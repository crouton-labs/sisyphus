import type { Command } from 'commander';
import { existsSync, readFileSync, watchFile, unwatchFile } from 'node:fs';
import { join, resolve } from 'node:path';
import { ulid } from 'ulid';
import { parseDeck } from '../../shared/ask-schema.js';
import { createAsk, listAsks, readMeta, updateMeta, writeDecisions } from '../../daemon/ask-store.js';
import { emitHistoryEvent } from '../../daemon/history.js';
import { askOutputPath, statePath } from '../../shared/paths.js';
import * as state from '../../daemon/state.js';
import { ORCHESTRATOR_ASKED_BY } from '../../shared/types.js';
import type { AskOutput, AskStatus, InteractionKind } from '../../shared/types.js';
import { execSafe } from '../../shared/exec.js';
import { shellQuote } from '../../shared/shell.js';
import { exitUsage } from '../errors.js';
import { approveDeck, notifyDeck, launchReview, display } from '@crouton-kit/humanloop';
import type { Deck } from '@crouton-kit/humanloop';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function validateAskId(askId: string): void {
  if (!ULID_RE.test(askId)) {
    exitUsage('invalid-ask-id', `invalid askId format: ${askId}`, {
      received: askId,
      expected: '26-character ULID (e.g. 01ARZ3NDEKTSV4RRFFQ69G5FAV)',
    });
  }
}

const DECK_SCHEMA_HELP = `
Posts a deck of questions to the user's dashboard inbox. They walk through it and you read the structured JSON back from stdout.

The CLI always blocks until the user answers (which can take 10+ minutes).

- **Orchestrator:** invoke synchronously so the orchestrator's pane stays alive while the bash blocks. Daemon refuses \`sis orch yield\` while orchestrator owns a pending deck; foreground is the supported pattern.
- **Agents / one-off Claude Code sessions:** invoke through the Bash tool with \`run_in_background: true\` and end your turn — the bash completion notification wakes you with stdout ready to parse.

For guidance on when to use a deck, how to design options the user can actually choose between, and how to bundle related questions into one deck, read the \`humanloop\` skill before authoring.

DECK JSON SCHEMA
  { "title"?: string, "interactions": Interaction[] }    // interactions[] non-empty

  Interaction:
    id              string, /^[A-Za-z0-9_-]+$/, max 64 chars, unique within deck
    title           string (required, non-empty)
    subtitle?       string
    body?           string                    // markdown rendered in dashboard
    bodyPath?       string                    // path RELATIVE to the deck JSON's directory
                                              // and must resolve INSIDE that directory
                                              // (no '..', no symlinks out, no absolute
                                              // paths pointing elsewhere). Mutually
                                              // exclusive with 'body'. To use bodyPath,
                                              // write the deck JSON next to the markdown
                                              // file (e.g. both in
                                              // \$SISYPHUS_SESSION_DIR/context/) and pass
                                              // a basename like "summary.md".
    kind?           "notify" | "validation" | "decision" | "context" | "error"
                                              // display hint for inbox icon/sort weight.
                                              // No other values accepted.
    options         Option[]                  // 2–4 options recommended (see humanloop)
    allowFreetext?  boolean
    freetextLabel?  string

  Option:
    id              string (required)
    label           string (required)
    description?    string
    shortcut?       string

OUTPUT
  On answer, stdout is one line of JSON:
    { "responses": [{ "id", "selectedOptionId"?, "freetext"? }, ...], "completedAt" }
  Branch on each response by its interaction \`id\`.

Validation errors at submit are precise — read them, don't guess.
`;

export function registerAsk(program: Command): void {
  const ask = program
    .command('ask')
    .description('Submit a structured question deck for the user to answer (blocks until answered)')
    .action(() => {
      ask.help();
    });

  ask
    .command('submit <file>')
    .description('Submit a deck JSON file and block until the user answers')
    .option('--session <id>', 'Session id (defaults to SISYPHUS_SESSION_ID)')
    .addHelpText('after', DECK_SCHEMA_HELP)
    .action(async (file: string, opts: { session?: string }) => {
      await submit(file, opts);
    });

  ask
    .command('poll <askId>')
    .description('Block until <askId> is answered, then print output JSON')
    .option('--session <id>', 'Session id (defaults to SISYPHUS_SESSION_ID)')
    .action(async (askId: string, opts: { session?: string }) => poll(askId, opts));

  ask
    .command('peek <askId>')
    .description('Print {askId, status, completedAt?, output?} for <askId> without blocking')
    .option('--session <id>', 'Session id (defaults to SISYPHUS_SESSION_ID)')
    .action(async (askId: string, opts: { session?: string }) => peek(askId, opts));

  ask
    .command('approve <title>')
    .description('Yes/No approval gate (blocks until answered)')
    .option('--subtitle <s>', 'Optional one-line context shown below the title')
    .option('--body <b>', 'Optional markdown body')
    .option('--session <id>', 'Session id (defaults to SISYPHUS_SESSION_ID)')
    .action(async (title: string, opts: { subtitle?: string; body?: string; session?: string }) => {
      await approve(title, opts);
    });

  ask
    .command('notify <title>')
    .description('Fire-and-forget acknowledgement on the dashboard (non-blocking)')
    .option('--body <b>', 'Optional markdown body')
    .option('--session <id>', 'Session id (defaults to SISYPHUS_SESSION_ID)')
    .action(async (title: string, opts: { body?: string; session?: string }) => {
      await notify(title, opts);
    });

  ask
    .command('review <file>')
    .description('Anchored-comment review of a markdown file (opens editor; blocks)')
    .option('--output <path>', 'Where to write the FeedbackResult JSON (default: .sisyphus/reviews/<ulid>.json)')
    .option('--session <id>', 'Session id (defaults to SISYPHUS_SESSION_ID)')
    .action(async (file: string, opts: { output?: string; session?: string }) => {
      await review(file, opts);
    });

  ask
    .command('list')
    .description('List pending interactions for the current session')
    .option('--limit <n>', 'Max items to return (default 20, max 100)')
    .option('--cursor <c>', 'Opaque pagination token from a previous next_cursor')
    .option('--session <id>', 'Session id (defaults to SISYPHUS_SESSION_ID)')
    .action(async (opts: { limit?: string; cursor?: string; session?: string }) => {
      await listPending(opts);
    });

  ask
    .command('show <path>')
    .description('Live-display a file in a tmux pane (passthrough to humanloop)')
    .option('--watch', 'Live-update the pane on edits')
    .option('--window <mode>', 'Pane placement: auto, split, or new (default auto)')
    .action(async (path: string, opts: { watch?: boolean; window?: string }) => {
      await show(path, opts);
    });
}

function mintAskId(): string {
  return ulid();
}

function resolveClaudeSessionId(cwd: string, sessionId: string, askedBy: string): string | undefined {
  if (!existsSync(statePath(cwd, sessionId))) return undefined;
  const session = state.getSession(cwd, sessionId);
  if (askedBy === ORCHESTRATOR_ASKED_BY) {
    const last = session.orchestratorCycles[session.orchestratorCycles.length - 1];
    return last?.claudeSessionId;
  }
  return session.agents.find(a => a.id === askedBy)?.claudeSessionId;
}

function resolveSessionEnv(opts: { session?: string }): { cwd: string; sessionId: string } {
  const sessionId = opts.session ?? process.env.SISYPHUS_SESSION_ID;
  const cwd = process.env.SISYPHUS_CWD ?? process.cwd();
  if (!sessionId) {
    exitUsage('missing-session', 'provide --session or set SISYPHUS_SESSION_ID', {
      next: 'sis ask submit <file> --session <id>',
    });
  }
  return { cwd, sessionId };
}

/**
 * Idempotently mark an ask answered: stamp meta.completedAt, emit `ask-answered`,
 * and credit `userBlockedMs` on the session/cycle if the ask was blocking.
 * Re-entrant: the `meta.completedAt` check ensures only the first observer credits the wait.
 */
async function markAnswered(cwd: string, sessionId: string, askId: string): Promise<void> {
  const meta = readMeta(cwd, sessionId, askId);
  if (!meta || meta.completedAt) return;

  const completedAt = new Date().toISOString();
  const durationMs = new Date(completedAt).getTime() - new Date(meta.askedAt).getTime();

  try {
    await updateMeta(cwd, sessionId, askId, { status: 'answered', completedAt });
  } catch {
    // updateMeta throws if the meta file vanished mid-flight; treat as best-effort.
    return;
  }

  emitHistoryEvent(sessionId, 'ask-answered', {
    askId,
    askedBy: meta.askedBy,
    blocking: meta.blocking,
    durationMs,
    askedAt: meta.askedAt,
    completedAt,
  });

  if (meta.blocking && durationMs > 0) {
    try {
      if (existsSync(statePath(cwd, sessionId))) {
        await state.incrementUserBlockedMs(cwd, sessionId, durationMs, meta.askedAt, meta.askedBy);
      }
    } catch {
      // State increment is best-effort — history event is the source of truth for autopsy.
    }
  }
}

function waitForOutput(cwd: string, sessionId: string, askId: string, initialPpid?: number): Promise<AskOutput> {
  const outputPath = askOutputPath(cwd, sessionId, askId);

  if (existsSync(outputPath)) {
    return Promise.resolve(JSON.parse(readFileSync(outputPath, 'utf-8')) as AskOutput);
  }

  return new Promise((res, _rej) => {
    let ppidWatcher: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      unwatchFile(outputPath, onChange);
      if (ppidWatcher !== undefined) clearInterval(ppidWatcher);
      process.removeListener('SIGINT', onSigint);
    };

    const onChange = () => {
      if (!existsSync(outputPath)) return;
      try {
        const out = JSON.parse(readFileSync(outputPath, 'utf-8')) as AskOutput;
        cleanup();
        res(out);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || err instanceof SyntaxError) {
          // File disappeared mid-read or atomic rename not yet complete — next tick will retry
          return;
        }
        throw err;
      }
    };
    watchFile(outputPath, { interval: 250 }, onChange);

    if (initialPpid !== undefined && initialPpid !== 1) {
      ppidWatcher = setInterval(() => {
        if (process.ppid !== initialPpid || process.ppid === 1) {
          cleanup();
          process.exit(0);
        }
      }, 250);
    }

    const onSigint = () => {
      cleanup();
      process.exit(130);
    };
    process.once('SIGINT', onSigint);
  });
}

/**
 * Spawn a tmux pane next to the caller showing the deck so the user can answer
 * inline without leaving the agent's pane. The dashboard inbox remains a valid
 * second surface — both write through the same on-disk ask-store paths.
 *
 * No-op outside tmux, when the user opts out, or if the split fails (the
 * dashboard is still a valid answering surface, so we never want to break the
 * ask itself for a UX nicety).
 */
function maybeSpawnAskPane(cwd: string, sessionId: string, askId: string): void {
  const callerPane = process.env.TMUX_PANE;
  if (!callerPane) return;
  if (process.env.SISYPHUS_DISABLE_ASK_PANE === '1') return;

  const tuiPath = join(import.meta.dirname, 'tui.js');
  const cmd = `node ${shellQuote(tuiPath)} --cwd ${shellQuote(cwd)} --session-id ${shellQuote(sessionId)} --ask ${shellQuote(askId)}`;

  // -d: don't auto-focus the new pane (caller stays focused)
  // -h: horizontal split (new pane sits to the right)
  // -t: target the caller's pane so the split is adjacent
  execSafe(`tmux split-window -d -h -t ${shellQuote(callerPane)} -c ${shellQuote(cwd)} ${shellQuote(cmd)}`);
}

/**
 * Core deck submission logic. Creates the ask store entry, writes decisions,
 * optionally spawns a pane, and optionally blocks waiting for output.
 *
 * blocking:true (default) — waits for response, marks answered, returns output.
 * blocking:false — creates a non-blocking ask, does NOT spawn a pane or wait.
 */
async function submitDeck(
  deck: Deck,
  opts: { session?: string },
  options?: { blocking?: boolean; kindOverride?: InteractionKind },
): Promise<{ askId: string; output?: AskOutput }> {
  const blocking = options?.blocking !== false;
  const { cwd, sessionId } = resolveSessionEnv(opts);
  const askedBy = process.env.SISYPHUS_AGENT_ID ?? ORCHESTRATOR_ASKED_BY;
  const initialPpid = process.ppid;
  const claudeSessionId = resolveClaudeSessionId(cwd, sessionId, askedBy);
  const askId = mintAskId();

  const q0 = deck.interactions[0];
  createAsk(cwd, sessionId, {
    askId,
    askedBy,
    blocking,
    pid: process.pid,
    claudeSessionId,
    cwd,
    title: deck.title !== undefined ? deck.title : q0?.title,
    subtitle: q0?.subtitle,
    kind: options?.kindOverride !== undefined ? options.kindOverride : q0?.kind,
  });
  writeDecisions(cwd, sessionId, askId, deck);

  if (!blocking) {
    return { askId };
  }

  maybeSpawnAskPane(cwd, sessionId, askId);

  const output = await waitForOutput(cwd, sessionId, askId, initialPpid);
  await markAnswered(cwd, sessionId, askId);
  return { askId, output };
}

async function submit(file: string, opts: { session?: string }): Promise<void> {
  const deckPath = resolve(file);
  if (!existsSync(deckPath)) {
    exitUsage('file-not-found', `deck file not found: ${deckPath}`, {
      received: deckPath,
      next: 'sis ask submit <file> (provide a valid path to a deck JSON)',
    });
  }

  let decisions: Deck;
  try {
    decisions = parseDeck(deckPath);
  } catch (err) {
    exitUsage('invalid-deck', (err as Error).message, { received: deckPath });
  }

  const { output } = await submitDeck(decisions!, opts);
  process.stdout.write(JSON.stringify(output) + '\n');
}

async function approve(
  title: string,
  opts: { subtitle?: string; body?: string; session?: string },
): Promise<void> {
  const deck = approveDeck(title, {
    ...(opts.subtitle !== undefined ? { subtitle: opts.subtitle } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });

  const { askId, output } = await submitDeck(deck, opts);
  if (!output) throw new Error('blocking ask returned no output');

  const approveResponse = output.responses.find(r => r.id === 'approve');
  const approved = approveResponse?.selectedOptionId === 'yes';

  process.stdout.write(
    JSON.stringify({
      askId,
      approved,
      completedAt: output.completedAt,
      responses: output.responses,
    }) + '\n',
  );
}

async function notify(title: string, opts: { body?: string; session?: string }): Promise<void> {
  const deck = notifyDeck(title, opts.body !== undefined ? { body: opts.body } : {});
  const { askId } = await submitDeck(deck, opts, { blocking: false, kindOverride: 'notify' });
  process.stdout.write(JSON.stringify({ askId }) + '\n');
}

async function review(
  file: string,
  opts: { output?: string; session?: string },
): Promise<void> {
  const abs = resolve(file);
  if (!existsSync(abs)) {
    exitUsage('file-not-found', `file not found: ${abs}`, {
      received: abs,
      next: 'sis ask review <file> (provide a valid path to an existing .md file)',
    });
  }
  if (!abs.endsWith('.md')) {
    exitUsage('invalid-file', `review requires a .md file: ${abs}`, {
      received: abs,
      next: 'sis ask review <file> (file must end in .md)',
    });
  }

  const { cwd } = resolveSessionEnv(opts);
  const outputPath =
    opts.output !== undefined
      ? resolve(opts.output)
      : join(cwd, '.sisyphus', 'reviews', `${ulid()}.json`);

  const result = await launchReview(abs, { output: outputPath });
  const commentCount = Array.isArray(result.comments) ? result.comments.length : 0;
  process.stdout.write(JSON.stringify({ output: outputPath, comments: commentCount }) + '\n');
}

async function listPending(opts: {
  limit?: string;
  cursor?: string;
  session?: string;
}): Promise<void> {
  const { cwd, sessionId } = resolveSessionEnv(opts);

  const limitParsed = opts.limit !== undefined ? parseInt(opts.limit, 10) : 20;
  if (opts.limit !== undefined && (isNaN(limitParsed) || limitParsed < 1)) {
    exitUsage('invalid-limit', `--limit must be a positive integer, got: ${opts.limit}`, {
      received: opts.limit,
      next: 'sis ask list --limit <n> (1-100)',
    });
  }
  const limit = Math.min(limitParsed, 100);
  const cursorParsed = opts.cursor !== undefined ? parseInt(opts.cursor, 10) : 0;
  if (opts.cursor !== undefined && isNaN(cursorParsed)) {
    exitUsage('invalid-cursor', `--cursor must be a numeric token, got: ${opts.cursor}`, {
      received: opts.cursor,
      next: 'Pass the next_cursor value from a previous sis ask list response',
    });
  }
  const cursorOffset = cursorParsed;

  const allAskIds = listAsks(cwd, sessionId);
  const pending: Array<{
    askId: string;
    title?: string;
    kind?: string;
    askedAt: string;
    blocking: boolean;
    askedBy: string;
  }> = [];

  for (const askId of allAskIds) {
    const meta = readMeta(cwd, sessionId, askId);
    if (!meta) continue;
    if (meta.orphaned) continue;
    if (meta.status !== 'pending' && meta.status !== 'in-progress') continue;
    if (existsSync(askOutputPath(cwd, sessionId, askId))) continue;
    pending.push({
      askId,
      ...(meta.title !== undefined ? { title: meta.title } : {}),
      ...(meta.kind !== undefined ? { kind: meta.kind } : {}),
      askedAt: meta.askedAt,
      blocking: meta.blocking,
      askedBy: meta.askedBy,
    });
  }

  // Sort oldest first
  pending.sort((a, b) => (a.askedAt < b.askedAt ? -1 : a.askedAt > b.askedAt ? 1 : 0));

  const total = pending.length;
  const start = Math.min(cursorOffset, total);
  const page = pending.slice(start, start + limit);
  const nextStart = start + page.length;
  const next_cursor = nextStart < total ? String(nextStart) : null;

  process.stdout.write(
    JSON.stringify({ items: page, next_cursor, total }) + '\n',
  );
}

async function show(
  path: string,
  opts: { watch?: boolean; window?: string },
): Promise<void> {
  const rawWindow = opts.window;
  if (rawWindow !== undefined && rawWindow !== 'auto' && rawWindow !== 'split' && rawWindow !== 'new') {
    exitUsage('invalid-window', `--window must be auto, split, or new, got: ${rawWindow}`, {
      received: rawWindow,
      next: 'sis ask show <path> --window auto|split|new',
    });
  }
  const windowOpt: 'auto' | 'split' | 'new' = rawWindow !== undefined ? rawWindow as 'auto' | 'split' | 'new' : 'auto';
  const watch = opts.watch === true;

  let paneId: string | undefined;
  try {
    const r = display(path, { watch, window: windowOpt });
    paneId = r.paneId;
  } catch (err) {
    // display failures degrade gracefully — never fail the caller (matches crtr human show semantics).
    // Log to stderr so the error is visible but doesn't corrupt stdout JSON.
    process.stderr.write(`[sis ask show] display error: ${(err as Error).message}\n`);
    paneId = undefined;
  }

  if (paneId !== undefined) {
    process.stdout.write(JSON.stringify({ pane_id: paneId, reason: null }) + '\n');
    return;
  }

  const inTmux = Boolean(process.env.TMUX);
  const reason = inTmux ? 'renderer unavailable (termrender/uv missing)' : 'not in tmux';
  process.stdout.write(JSON.stringify({ pane_id: null, reason }) + '\n');
  process.exit(0);
}

async function poll(askId: string, opts: { session?: string }): Promise<void> {
  validateAskId(askId);
  const { cwd, sessionId } = resolveSessionEnv(opts);
  const meta = readMeta(cwd, sessionId, askId);
  if (!meta) {
    exitUsage('not-found', `askId not found: ${askId}`, { received: askId });
  }
  const output = await waitForOutput(cwd, sessionId, askId);
  await markAnswered(cwd, sessionId, askId);
  process.stdout.write(JSON.stringify(output) + '\n');
}

async function peek(askId: string, opts: { session?: string }): Promise<void> {
  validateAskId(askId);
  const { cwd, sessionId } = resolveSessionEnv(opts);
  const meta = readMeta(cwd, sessionId, askId);
  if (!meta) {
    process.stdout.write(JSON.stringify({ askId, status: 'not-found' satisfies AskStatus }) + '\n');
    return;
  }
  const outputPath = askOutputPath(cwd, sessionId, askId);
  const result: { askId: string; status: AskStatus; completedAt?: string; output?: AskOutput } = {
    askId,
    status: meta.status,
  };
  if (meta.completedAt) result.completedAt = meta.completedAt;
  try {
    if (existsSync(outputPath)) {
      result.output = JSON.parse(readFileSync(outputPath, 'utf-8')) as AskOutput;
    }
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    // response.json mid-write (atomic rename in progress); leave output key absent
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}
