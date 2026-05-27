import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import { readStdin } from '../stdin.js';
import type { Request } from '../../shared/protocol.js';
import type { MessageSource } from '../../shared/types.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

interface TellOptions {
  session?: string;
  pasteOnly?: boolean;
  stdin?: boolean;
  message?: string;
}

/**
 * Normalize a raw target string to a canonical agent ID.
 * - /^agent-\d+$/i → lowercased as-is
 * - /^\d+$/ → `agent-${raw}`
 * - else → exitUsage('bad_target', ...)
 */
export function normalizeAgentId(raw: string): string {
  if (/^agent-\d+$/i.test(raw)) return raw.toLowerCase();
  if (/^\d+$/.test(raw)) return `agent-${raw}`;
  exitUsage('bad_target', `target must be 'agent-NNN' or a bare number like '3' (got '${raw}')`, {
    received: raw,
    expected: ['agent-1', 'agent-3', '3'],
  });
}

function runTell(
  target: { kind: 'orchestrator' } | { kind: 'agent'; agentId: string },
  text: string,
  opts: TellOptions & { sessionId: string },
): Promise<void> {
  return (async () => {
    const source: MessageSource | undefined = process.env.SISYPHUS_AGENT_ID
      ? { type: 'agent' as const, agentId: process.env.SISYPHUS_AGENT_ID }
      : undefined;

    const submit = opts.pasteOnly !== true;
    const request: Request = {
      type: 'tell',
      sessionId: opts.sessionId,
      target,
      text,
      submit,
      ...(source ? { source } : {}),
    };
    const response = await sendRequest(request);
    if (!response.ok) exitError(response.error);

    const targetLabel = target.kind === 'orchestrator' ? 'orchestrator' : target.agentId;
    emitJsonOk({ target: targetLabel, submit }); return;
  })();
}

async function resolveTextFromOpts(opts: TellOptions): Promise<string> {
  if (opts.stdin) {
    const text = await readStdin({ force: true });
    if (!text) {
      exitUsage('empty_stdin', '--stdin set but stdin was empty', {
        next: 'pipe content: `echo "..." | sis orch tell --stdin`',
      });
    }
    if (opts.message != null && opts.message !== '') {
      exitUsage('stdin_conflict', '--stdin conflicts with --message; pass one source', {
        received: { stdin: true, message: opts.message },
      });
    }
    return text;
  }
  if (opts.message == null || opts.message === '') {
    exitUsage('missing_text', 'provide --message or use --stdin', {
      next: 'sis orch tell --message "your text" — or sis orch tell --stdin <prompt.md',
    });
  }
  return opts.message;
}

export function registerOrchTell(parent: Command): void {
  parent
    .command('tell')
    .description('Type a prompt directly into the orchestrator pane. Submits immediately unlike `message`.')
    .option('--message <text>', 'Text to type into the orchestrator pane')
    .option('--session <sessionId>', 'Session ID (defaults to SISYPHUS_SESSION_ID)')
    .option('--paste-only', 'Paste text but do not press Enter (caller can review/submit manually)')
    .option('--stdin', 'Read prompt body from stdin instead of --message (avoids shell escaping)')
    .addHelpText(
      'after',
      `
orch tell: type a prompt directly into the orchestrator pane and optionally submit it.

Input
  --message <text>   required (or --stdin). Text to type into the orchestrator pane.
  --stdin            optional. Read text from stdin instead of --message (avoids shell escaping).
  --session <id>     optional. Defaults to $SISYPHUS_SESSION_ID.
  --paste-only       optional. Paste without pressing Enter; caller submits manually.

Output (stdout, JSON)
  ok, data: { target, submit }

Effects
  Types text into the orchestrator tmux pane and optionally submits it.

Exit codes: 0 ok | 2 usage (missing text) | 3 not_found (unknown session) | 5 conflict (not running).`,
    )
    .action(async (opts: TellOptions) => {
      const sessionId = opts.session ?? process.env.SISYPHUS_SESSION_ID;
      if (!sessionId) {
        exitUsage('missing_session_id', 'Provide --session or set SISYPHUS_SESSION_ID', {
          next: 'export SISYPHUS_SESSION_ID=<sessionId> or pass --session <sessionId>',
        });
      }
      const text = await resolveTextFromOpts(opts);
      await runTell({ kind: 'orchestrator' }, text, { ...opts, sessionId });
    });
}

export function registerAgentTell(parent: Command): void {
  parent
    .command('tell <id>')
    .description('Type a prompt directly into an agent pane (agent-NNN). Submits immediately unlike `message`.')
    .option('--message <text>', 'Text to type into the agent pane')
    .option('--session <sessionId>', 'Session ID (defaults to SISYPHUS_SESSION_ID)')
    .option('--paste-only', 'Paste text but do not press Enter (caller can review/submit manually)')
    .option('--stdin', 'Read prompt body from stdin instead of --message (avoids shell escaping)')
    .addHelpText(
      'after',
      `
agent io tell: type a prompt directly into an agent pane and optionally submit it.

Input
  <id>               required. Agent ID: agent-NNN or bare number (e.g. 3 → agent-3).
  --message <text>   required (or --stdin). Text to type into the agent pane.
  --stdin            optional. Read text from stdin instead of --message (avoids shell escaping).
  --session <id>     optional. Defaults to $SISYPHUS_SESSION_ID.
  --paste-only       optional. Paste without pressing Enter; caller submits manually.

Output (stdout, JSON)
  ok, data: { target, submit }

Effects
  Types text into the agent tmux pane and optionally submits it.

Exit codes: 0 ok | 2 usage (bad target / missing text) | 3 not_found (unknown session/agent) | 5 conflict (agent not running).`,
    )
    .action(async (idRaw: string, opts: TellOptions) => {
      const sessionId = opts.session ?? process.env.SISYPHUS_SESSION_ID;
      if (!sessionId) {
        exitUsage('missing_session_id', 'Provide --session or set SISYPHUS_SESSION_ID', {
          next: 'export SISYPHUS_SESSION_ID=<sessionId> or pass --session <sessionId>',
        });
      }
      const agentId = normalizeAgentId(idRaw);
      const text = await resolveTextFromOpts(opts);
      await runTell({ kind: 'agent', agentId }, text, { ...opts, sessionId });
    });
}
