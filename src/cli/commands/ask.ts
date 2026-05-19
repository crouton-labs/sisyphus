import type { Command } from 'commander';
import { existsSync, readFileSync, unlinkSync, watchFile, unwatchFile } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ulid } from 'ulid';
import { parseDeck } from '../../shared/ask-schema.js';
import { createAsk, listAsks, readMeta, readReview, updateMeta, writeDecisions, writeReview, writeReviewOutput } from '../../daemon/ask-store.js';
import { emitHistoryEvent } from '../../daemon/history.js';
import { askOutputPath, askReviewDraftPath, askReviewSubmitFlagPath, statePath } from '../../shared/paths.js';
import * as state from '../../daemon/state.js';
import { ORCHESTRATOR_ASKED_BY } from '../../shared/types.js';
import type { AskOutput, AskStatus, InteractionKind } from '../../shared/types.js';
import { execSafe } from '../../shared/exec.js';
import { shellQuote } from '../../shared/shell.js';
import { exitUsage } from '../errors.js';
import { approveDeck, notifyDeck, launchReview, display } from '@crouton-kit/humanloop';
import type { Deck, FeedbackComment, FeedbackResult } from '@crouton-kit/humanloop';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function validateAskId(askId: string): void {
  if (!ULID_RE.test(askId)) {
    exitUsage('invalid-ask-id', `invalid askId format: ${askId}`, {
      received: askId,
      expected: '26-character ULID (e.g. 01ARZ3NDEKTSV4RRFFQ69G5FAV)',
    });
  }
}

const ROOT_HELP = `
\`sis ask\` is the single surface for user engagement. Every question, gate, notification, or document hand-off goes through here. Engagement is expensive — resolve what you can resolve yourself (read code, spawn exploration agents, run tools) before reaching for these leaves. A typical session has a handful of asks, not a stream.

Pick the leaf by the shape of the engagement:

  deck submit FILE   Pose 1+ questions with named alternatives (and optional freetext).
                     The general-purpose surface — when in doubt, use this.
  approve TITLE      Yes/no gate on a single concrete action. Blocks.
  notify TITLE       FYI; no answer expected. Non-blocking.
  review FILE        Line-by-line markdown annotation in the user's editor. Blocks.
  state {poll,peek,list}
                     Inspect existing ask state (recovery only — not the normal path).
  show PATH          Display a file in a tmux pane. No response captured.

I/O contract: every leaf emits one line of JSON on stdout (schema in each leaf's -h). Stderr is diagnostics only; never the result. Set --json to suppress prose diagnostics when piping; it is forced when stdout is not a TTY.
`;

const DECK_HELP = `
Structured option decks — the primary surface for user decisions. A deck is one or more interactions, each posing a titled question with 2–4 mutually-exclusive named options and an optional freetext channel.

Use a deck when:
- Picking between concrete alternatives with meaningful tradeoffs.
- Bundling 2+ related questions into one user context-switch.
- Surfacing work for sign-off (a design, plan, completion summary).
- The user may sit on it across cycles — decks survive yields; pane chat does not.

For a freetext-primary question, write a single-interaction deck with one option ("acknowledge") and \`allowFreetext: true\` with a clear \`freetextLabel\`. Freetext-as-primary is rare; usually you want named options grounded in evidence.

Leaves
  submit <file>   Submit a deck JSON file. Blocks until the user resolves it.
`;

const DECK_SUBMIT_HELP = `
Submits a deck of structured questions to the user's dashboard inbox. Always blocks until the user resolves every interaction (often minutes; can be 10+).

DECK DESIGN

  Each interaction asks one thing. When two questions interact, give them separate id/title/options inside the same deck.

  Each option is a concrete forward path. The user picks an option to commit to a direction; each label must name a real path with its tradeoffs spelled out, grounded in *this* codebase or *this* exploration. Reference specifics — file names, framework constraints, prior decisions — not generic descriptions.

  Bound option count to 2–4 per interaction.
    < 2: collapses to yes/no — use \`sis ask approve\` instead.
    > 4: too granular for the user to weigh — split into two interactions or cut weak options.

  Options must be mutually exclusive forward paths. Reject feeling-based prompts ("Happy with this?") and fallback-to-freetext options ("Comment", "Maybe"). If "Reject" is a real path, name what rejecting routes to (back to design? abandon? try a different framing?).

  \`allowFreetext: true\` is a safety valve for context the options didn't anticipate, not the primary input channel. When freetext is the primary answer, the deck has one option ("acknowledge") and a clear \`freetextLabel\`.

  Bundle related questions into one deck. One deck with multiple interactions is one context switch for the user; two decks is two.

  Investigate before authoring. If you can settle the question by reading code, running a tool, or spawning an exploration agent, do that first. Asking should expose options grounded in evidence, not punt the investigation.

INVOCATION

  Orchestrator: invoke synchronously and let the Bash tool block. The daemon refuses \`sis orch yield\` while you own a pending deck; foreground is the supported pattern. Yielding while a deck is pending kills the pane and any in-flight bash with it, producing a polling loop.

  Agent / one-off Claude Code session: invoke through the Bash tool with \`run_in_background: true\` and end your turn. The bash completion notification wakes you with stdout ready to parse. Do not peek, poll, or narrate while you wait.

  Respawn recovery only: if you wake to a pending deck on disk (daemon restart, mid-wait crash), re-attach with \`sis ask state poll <askId>\` (blocking) or \`sis ask state peek <askId>\` (non-blocking diagnostics). Never poll a deck you submitted in the current turn — the bash completion is the only signal you need.

DECK JSON SCHEMA

  { "title"?: string, "interactions": Interaction[] }    // interactions[] non-empty

  Interaction:
    id              string, /^[A-Za-z0-9_-]+$/, max 64 chars, unique within deck
    title           string (required, non-empty)         // ask the actual decision
    subtitle?       string                               // one-line context
    body?           string                               // markdown rendered in dashboard
    bodyPath?       string                               // path RELATIVE to the deck JSON's
                                                         // directory and must resolve INSIDE
                                                         // that directory (no '..', no
                                                         // symlinks out, no absolute paths
                                                         // pointing elsewhere). Mutually
                                                         // exclusive with 'body'. To use
                                                         // bodyPath, write the deck JSON next
                                                         // to the markdown file (e.g. both in
                                                         // \$SISYPHUS_SESSION_DIR/context/)
                                                         // and pass a basename like
                                                         // "summary.md".
    kind?           "decision" | "validation" | "context" | "error" | "notify"
                                                         // display hint for inbox icon/sort:
                                                         //   decision   — fork in the road
                                                         //   validation — sign-off on work
                                                         //   context    — background needing response
                                                         //   error      — recovery picker
                                                         //   notify     — use the \`notify\` leaf instead
    options         Option[]                             // 2–4 entries; single-option only
                                                         // valid with allowFreetext: true
                                                         // and a freetext-primary framing
    allowFreetext?  boolean
    freetextLabel?  string                               // required if allowFreetext is the
                                                         // primary channel — name the input

  Option:
    id              string (required)
    label           string (required)                    // concrete path, not a feeling
    description?    string                               // spell out the tradeoff
    shortcut?       string

OUTPUT

  stdout (one line of JSON):
    { "responses": [{ "id", "selectedOptionId"?, "freetext"? }, ...], "completedAt" }

  Branch on each response by its interaction \`id\`.

ERRORS

  Validation errors at submit are precise — they name what was received and what was expected. Read them, don't guess.
`;

const APPROVE_HELP = `
Single yes/no gate. Blocks until the user picks. Returns { askId, approved, completedAt, responses }.

Use when the next step is reversible and proceeding needs explicit user consent — a destructive command, a network call with side effects, a state-changing migration. The \`--body\` should describe the concrete action in enough detail that the user can judge it without a follow-up question.

When the answer is "yes, but also tell me X" or "no, and here's why" matters, use \`sis ask deck submit\` instead — approve doesn't capture nuance.

Same blocking semantics as \`sis ask deck submit\`: orchestrator runs foreground, agent uses run_in_background.
`;

const NOTIFY_HELP = `
Fire-and-forget acknowledgement. Non-blocking — returns immediately with { askId } before the user sees it.

Use when the user should know about something (a milestone hit, a finding surfaced, a heads-up before a long-running step) but no answer is needed.

When even a minimal answer matters, use \`sis ask approve\`. When picking between paths matters, use \`sis ask deck submit\`. Notifications do not have a return path.
`;

const REVIEW_HELP = `
A review is a markdown-file review with line-anchored comments.

The agent submits the file; the human opens it in a clean nvim/vim session from
the dashboard inbox (90% tmux popup), adds anchored comments with <Space>c, and
submits with <Space>s or via the dashboard "Submit" action. Multiple open/close
cycles are supported — the draft persists until explicitly submitted.

Use when surfacing a document (design, plan, spec, completion summary) the user should annotate per-line rather than pick options on. For a global yes/no, use \`sis ask approve\`. For named alternatives, use \`sis ask deck submit\`.

Input: <file> must exist and end in \`.md\`.

Output (on submit):
  { askId, file, output: { kind: 'review', feedback: { ... }, completedAt } }

FeedbackResult fields: file, submitted, approved, comments[{ line, endLine, lineText, quote?, colStart?, colEnd?, comment, createdAt }], submittedAt, savedAt.
`;

const STATE_HELP = `
Inspect ask state for the current session. Pure reads — no submission, no writes.

Normal flow: when you submit an ask in the current turn, the bash completion delivers stdout — no \`state\` calls needed. Reach for these only on recovery.

Leaves
  poll <askId>   Block on a known askId.    | use when respawning into a session with a pending ask owned by you
  peek <askId>   Non-blocking status read.  | use when checking status without committing to wait
  list           Pending asks for session.  | use when recovering from a daemon restart or auditing open asks
`;

const STATE_POLL_HELP = `
Block until <askId> resolves, then print the same { responses, completedAt } JSON that \`deck submit\` would return.

Recovery-only. If you respawn and find an ask on disk owned by you with status pending or in-progress, poll re-attaches. Never poll an ask you submitted in the current turn — wait for the original bash to complete.
`;

const STATE_PEEK_HELP = `
Print { askId, status, completedAt?, output? } for <askId> without blocking. Status is one of: pending | in-progress | answered | not-found.

Diagnostics surface. Use to decide whether to poll or to skip an orphaned ask. Returns immediately.
`;

const STATE_LIST_HELP = `
List pending and in-progress asks for the current session, oldest first.

Output: { items: [{askId, title?, kind?, askedAt, blocking, askedBy}], next_cursor, total }

Sorted by askedAt ascending. Pagination is cursor-based: pass the previous response's \`next_cursor\` to the next call; null means end of list. \`total\` is the count across all pages.
`;

const SHOW_HELP = `
Live-display a file in a tmux pane (passthrough to humanloop's renderer). No response captured.

Use to surface context the user should glance at while you work — a generated diagram, a status report, a diff. For documents the user should annotate, use \`sis ask review\` instead.

Degrades gracefully outside tmux: returns { pane_id: null, reason } and exits 0.
`;

export function registerAsk(program: Command): void {
  const ask = program
    .command('ask')
    .description('Surface a question, gate, notification, or document to the user')
    .addHelpText('after', ROOT_HELP)
    .action(() => {
      ask.help();
    });

  const deck = ask
    .command('deck')
    .description('Structured option decks (the primary surface for user decisions)')
    .addHelpText('after', DECK_HELP)
    .action(() => {
      deck.help();
    });

  deck
    .command('submit <file>')
    .description('Submit a deck JSON file; blocks until the user resolves it')
    .option('--session <id>', 'Session id (defaults to SISYPHUS_SESSION_ID)')
    .addHelpText('after', DECK_SUBMIT_HELP)
    .action(async (file: string, opts: { session?: string }) => {
      await submit(file, opts);
    });

  ask
    .command('approve <title>')
    .description('Yes/no gate on a single concrete action; blocks until answered')
    .option('--subtitle <s>', 'Optional one-line context shown below the title')
    .option('--body <b>', 'Markdown body describing the action the user is approving')
    .option('--session <id>', 'Session id (defaults to SISYPHUS_SESSION_ID)')
    .addHelpText('after', APPROVE_HELP)
    .action(async (title: string, opts: { subtitle?: string; body?: string; session?: string }) => {
      await approve(title, opts);
    });

  ask
    .command('notify <title>')
    .description('Fire-and-forget acknowledgement on the dashboard (non-blocking)')
    .option('--body <b>', 'Optional markdown body')
    .option('--session <id>', 'Session id (defaults to SISYPHUS_SESSION_ID)')
    .addHelpText('after', NOTIFY_HELP)
    .action(async (title: string, opts: { body?: string; session?: string }) => {
      await notify(title, opts);
    });

  ask
    .command('review <file>')
    .description('Anchored-comment review of a markdown file; blocks until the user submits')
    .option('--session <id>', 'Session id (defaults to SISYPHUS_SESSION_ID)')
    .addHelpText('after', REVIEW_HELP)
    .action(async (file: string, opts: { session?: string }) => {
      await review(file, opts);
    });

  ask
    .command('review-open <askId>')
    .description('Open a pending review in the current terminal (used internally by the dashboard popup)')
    .option('--session <id>', 'Session id (defaults to SISYPHUS_SESSION_ID)')
    .action(async (askId: string, opts: { session?: string }) => {
      await reviewOpen(askId, opts);
    });

  ask
    .command('review-submit <askId>')
    .description('Finalize a pending review using the current draft (no editor)')
    .option('--session <id>', 'Session id (defaults to SISYPHUS_SESSION_ID)')
    .action(async (askId: string, opts: { session?: string }) => {
      await reviewSubmit(askId, opts);
    });

  const stateCmd = ask
    .command('state')
    .description('Inspect existing ask state (recovery only — not the normal path)')
    .addHelpText('after', STATE_HELP)
    .action(() => {
      stateCmd.help();
    });

  stateCmd
    .command('poll <askId>')
    .description('Block until <askId> is answered, then print output JSON')
    .option('--session <id>', 'Session id (defaults to SISYPHUS_SESSION_ID)')
    .addHelpText('after', STATE_POLL_HELP)
    .action(async (askId: string, opts: { session?: string }) => poll(askId, opts));

  stateCmd
    .command('peek <askId>')
    .description('Print {askId, status, completedAt?, output?} for <askId> without blocking')
    .option('--session <id>', 'Session id (defaults to SISYPHUS_SESSION_ID)')
    .addHelpText('after', STATE_PEEK_HELP)
    .action(async (askId: string, opts: { session?: string }) => peek(askId, opts));

  stateCmd
    .command('list')
    .description('List pending and in-progress asks for the current session')
    .option('--limit <n>', 'Max items to return (default 20, max 100)')
    .option('--cursor <c>', 'Opaque pagination token from a previous next_cursor')
    .option('--session <id>', 'Session id (defaults to SISYPHUS_SESSION_ID)')
    .addHelpText('after', STATE_LIST_HELP)
    .action(async (opts: { limit?: string; cursor?: string; session?: string }) => {
      await listPending(opts);
    });

  ask
    .command('show <path>')
    .description('Live-display a file in a tmux pane (no response captured)')
    .option('--watch', 'Live-update the pane on edits')
    .option('--window <mode>', 'Pane placement: auto, split, or new (default auto)')
    .addHelpText('after', SHOW_HELP)
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
      next: 'sis ask deck submit <file> --session <id>',
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
function maybeSpawnAskPane(cwd: string, sessionId: string, askId: string, kind?: InteractionKind): void {
  if (kind === 'review') return; // reviews surface in dashboard only
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

  maybeSpawnAskPane(cwd, sessionId, askId, q0?.kind);

  const output = await waitForOutput(cwd, sessionId, askId, initialPpid);
  await markAnswered(cwd, sessionId, askId);
  return { askId, output };
}

async function submit(file: string, opts: { session?: string }): Promise<void> {
  const deckPath = resolve(file);
  if (!existsSync(deckPath)) {
    exitUsage('file-not-found', `deck file not found: ${deckPath}`, {
      received: deckPath,
      next: 'sis ask deck submit <file> (provide a valid path to a deck JSON)',
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
  if (output.kind === 'review') throw new Error('approve returned review output — internal error');

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

async function submitReview(
  absFile: string,
  opts: { session?: string },
  options?: { blocking?: boolean },
): Promise<{ askId: string; output?: AskOutput }> {
  const blocking = options?.blocking !== false;
  const { cwd, sessionId } = resolveSessionEnv(opts);
  const askedBy = process.env.SISYPHUS_AGENT_ID ?? ORCHESTRATOR_ASKED_BY;
  const initialPpid = process.ppid;
  const claudeSessionId = resolveClaudeSessionId(cwd, sessionId, askedBy);
  const askId = mintAskId();

  createAsk(cwd, sessionId, {
    askId,
    askedBy,
    blocking,
    pid: process.pid,
    claudeSessionId,
    cwd,
    title: `Review ${basename(absFile)}`,
    kind: 'review',
  });
  writeReview(cwd, sessionId, askId, { file: absFile });

  if (!blocking) return { askId };

  const output = await waitForOutput(cwd, sessionId, askId, initialPpid);
  await markAnswered(cwd, sessionId, askId);
  return { askId, output };
}

async function review(file: string, opts: { session?: string }): Promise<void> {
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
  const { askId, output } = await submitReview(abs, opts);
  process.stdout.write(JSON.stringify({ askId, file: abs, output }) + '\n');
}

async function reviewOpen(askId: string, opts: { session?: string }): Promise<void> {
  validateAskId(askId);
  const { cwd, sessionId } = resolveSessionEnv(opts);
  const meta = readMeta(cwd, sessionId, askId);
  if (!meta) exitUsage('not-found', `askId not found: ${askId}`, { received: askId });
  if (meta.kind !== 'review') exitUsage('not-a-review', `askId ${askId} is not a review`, { received: meta.kind });

  const reviewData = readReview(cwd, sessionId, askId);
  if (!reviewData) exitUsage('missing-review-pointer', `review.json missing for ${askId}`, { received: askId });

  const draftPath = askReviewDraftPath(cwd, sessionId, askId);
  const flagPath = askReviewSubmitFlagPath(cwd, sessionId, askId);

  // Clean stale flag from any prior run; flag presence is the explicit-submit signal.
  if (existsSync(flagPath)) unlinkSync(flagPath);

  const result = await launchReview(reviewData.file, {
    output: draftPath,
    submitFlagPath: flagPath,
    noTmux: true, // we're already inside the dashboard's tmux popup
  });

  if (result.submitted) {
    writeReviewOutput(cwd, sessionId, askId, result);
    process.stdout.write(JSON.stringify({ askId, submitted: true, comments: result.comments.length }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ askId, submitted: false, comments: result.comments.length }) + '\n');
  }
}

async function reviewSubmit(askId: string, opts: { session?: string }): Promise<void> {
  validateAskId(askId);
  const { cwd, sessionId } = resolveSessionEnv(opts);
  const meta = readMeta(cwd, sessionId, askId);
  if (!meta) exitUsage('not-found', `askId not found: ${askId}`, { received: askId });
  if (meta.kind !== 'review') exitUsage('not-a-review', `askId ${askId} is not a review`, { received: meta.kind });

  const reviewData = readReview(cwd, sessionId, askId);
  if (!reviewData) exitUsage('missing-review-pointer', `review.json missing for ${askId}`, { received: askId });

  const draftPath = askReviewDraftPath(cwd, sessionId, askId);
  let comments: FeedbackComment[] = [];
  if (existsSync(draftPath)) {
    try {
      const draft = JSON.parse(readFileSync(draftPath, 'utf-8')) as { comments?: unknown };
      if (Array.isArray(draft.comments)) comments = draft.comments as FeedbackComment[];
    } catch {
      // unreadable draft — submit with 0 comments
    }
  }
  const now = new Date().toISOString();
  const feedback: FeedbackResult = {
    file: reviewData.file,
    submitted: true,
    approved: comments.length === 0,
    comments,
    submittedAt: now,
    savedAt: now,
  };
  writeReviewOutput(cwd, sessionId, askId, feedback);
  process.stdout.write(JSON.stringify({ askId, submitted: true, comments: comments.length }) + '\n');
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
      next: 'sis ask state list --limit <n> (1-100)',
    });
  }
  const limit = Math.min(limitParsed, 100);
  const cursorParsed = opts.cursor !== undefined ? parseInt(opts.cursor, 10) : 0;
  if (opts.cursor !== undefined && isNaN(cursorParsed)) {
    exitUsage('invalid-cursor', `--cursor must be a numeric token, got: ${opts.cursor}`, {
      received: opts.cursor,
      next: 'Pass the next_cursor value from a previous sis ask state list response',
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
