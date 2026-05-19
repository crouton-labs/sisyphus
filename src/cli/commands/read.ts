import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import type { Session, OrchestratorCycle } from '../../shared/types.js';
import { exitError, exitUsage } from '../errors.js';
import { normalizeAgentId } from './tell.js';

interface ReadOptions {
  session?: string;
  cycle?: string;
  tail?: string;
  head?: string;
}

const TURN_TYPES = new Set(['user', 'assistant']);

interface JsonlEntry {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

function projectDirFromCwd(cwd: string): string {
  // Claude Code project encoding: cwd with `/` → `-`. Leading `/` becomes leading `-`.
  return cwd.replace(/\//g, '-');
}

function transcriptPath(cwd: string, claudeSessionId: string): string {
  return join(homedir(), '.claude', 'projects', projectDirFromCwd(cwd), `${claudeSessionId}.jsonl`);
}

async function emitTranscript(
  claudeSessionId: string,
  sessionCwd: string,
  opts: ReadOptions,
): Promise<void> {
  const path = transcriptPath(sessionCwd, claudeSessionId);
  if (!existsSync(path)) {
    exitError({
      code: 'transcript_not_found',
      kind: 'not_found',
      message: `transcript not found at ${path}`,
      received: path,
    });
  }

  const raw = readFileSync(path, 'utf-8');

  const allEntries: JsonlEntry[] = raw
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line) as JsonlEntry; } catch { return null; } })
    .filter((e): e is JsonlEntry => e !== null);

  let entries = allEntries.filter(e => e.type && TURN_TYPES.has(e.type));

  const head = opts.head ? parseInt(opts.head, 10) : undefined;
  const tail = opts.tail ? parseInt(opts.tail, 10) : undefined;
  if (head && Number.isFinite(head)) {
    entries = entries.slice(0, head);
  }
  if (tail && Number.isFinite(tail)) {
    entries = entries.slice(-tail);
  }

  for (const e of entries) {
    process.stdout.write(JSON.stringify({
      role: e.type,
      timestamp: e.timestamp,
      content: e.message?.content,
    }) + '\n');
  }
}

async function fetchSession(sessionId: string): Promise<Session> {
  const response = await sendRequest({ type: 'status', sessionId, cwd: process.cwd() } as Request);
  if (!response.ok) exitError(response.error);
  const session = (response.data as { session?: Session })?.session;
  if (!session) {
    exitError({
      code: 'no_session_in_status',
      kind: 'not_found',
      message: 'status response did not include session',
      received: sessionId,
    });
  }
  return session;
}

export function registerOrchRead(parent: Command): void {
  parent
    .command('read')
    .description("Print the Claude conversation transcript for the orchestrator.")
    .option('--session <sessionId>', 'Session ID (defaults to SISYPHUS_SESSION_ID)')
    .option('--cycle <n>', 'Orchestrator cycle number (default: most recent live, else last completed)')
    .option('--tail <n>', 'Show last N turns', undefined)
    .option('--head <n>', 'Show first N turns', undefined)
    .addHelpText(
      'after',
      `
orch read: print the Claude conversation transcript for the orchestrator.

Input
  --session <sessionId>  optional — sisyphus session ID; defaults to SISYPHUS_SESSION_ID env var
  --cycle <n>            optional — orchestrator cycle number; defaults to most recent live cycle, else last completed
  --tail <n>             optional — emit only the last N turns
  --head <n>             optional — emit only the first N turns

Output (stdout, JSONL)
  one JSON object per line; no {ok, schema_version} envelope (stream contract).
  fields: { role: "user"|"assistant", timestamp: ISO-8601, content: message content }
  ordered oldest-first within the selected cycle.

Effects
  None. Read-only.

Exit codes: 0 ok | 2 usage | 3 not_found (session/cycle/transcript).`,
    )
    .action(async (opts: ReadOptions) => {
      const sessionId = opts.session ?? process.env.SISYPHUS_SESSION_ID;
      if (!sessionId) {
        exitUsage('missing_session_id', 'Provide --session or set SISYPHUS_SESSION_ID', {
          next: 'export SISYPHUS_SESSION_ID=<sessionId> or pass --session <sessionId>',
        });
      }

      const session = await fetchSession(sessionId);

      let cycle: OrchestratorCycle | undefined;
      if (opts.cycle) {
        const n = parseInt(opts.cycle, 10);
        if (!Number.isFinite(n)) {
          exitUsage('bad_cycle', '--cycle must be a number', { received: opts.cycle });
        }
        cycle = session.orchestratorCycles.find(c => c.cycle === n);
        if (!cycle) {
          exitError({
            code: 'cycle_not_found',
            kind: 'not_found',
            message: `orchestrator cycle ${n} not found in session`,
            received: n,
            expected: session.orchestratorCycles.map(c => c.cycle),
          });
        }
      } else {
        cycle = [...session.orchestratorCycles].reverse().find(c => !c.completedAt) ?? session.orchestratorCycles.at(-1);
      }
      if (!cycle) {
        exitError({
          code: 'no_cycles',
          kind: 'not_found',
          message: 'no orchestrator cycles found',
          received: sessionId,
        });
      }

      const claudeSessionId = cycle.claudeSessionId;
      const label = `orchestrator cycle ${cycle.cycle}${cycle.completedAt ? ' (completed)' : ' (live)'}`;

      if (!claudeSessionId) {
        exitError({
          code: 'no_claude_session',
          kind: 'not_found',
          message: `no claudeSessionId stored for ${label} — transcript may not exist yet`,
          received: sessionId,
        });
      }

      await emitTranscript(claudeSessionId, session.cwd, opts);
    });
}

export function registerAgentRead(parent: Command): void {
  parent
    .command('read <id>')
    .description("Print the Claude conversation transcript for an agent (agent-NNN).")
    .option('--session <sessionId>', 'Session ID (defaults to SISYPHUS_SESSION_ID)')
    .option('--tail <n>', 'Show last N turns', undefined)
    .option('--head <n>', 'Show first N turns', undefined)
    .addHelpText(
      'after',
      `
agent io read: print the Claude conversation transcript for an agent.

Input
  <id>                   required — agent identifier; accepts agent-NNN, NNN, or agent-NNN shorthand
  --session <sessionId>  optional — sisyphus session ID; defaults to SISYPHUS_SESSION_ID env var
  --tail <n>             optional — emit only the last N turns
  --head <n>             optional — emit only the first N turns

Output (stdout, JSONL)
  one JSON object per line; no {ok, schema_version} envelope (stream contract).
  fields: { role: "user"|"assistant", timestamp: ISO-8601, content: message content }
  ordered oldest-first.

Effects
  None. Read-only.

Exit codes: 0 ok | 2 usage | 3 not_found (session/agent/transcript).`,
    )
    .action(async (idRaw: string, opts: ReadOptions) => {
      const sessionId = opts.session ?? process.env.SISYPHUS_SESSION_ID;
      if (!sessionId) {
        exitUsage('missing_session_id', 'Provide --session or set SISYPHUS_SESSION_ID', {
          next: 'export SISYPHUS_SESSION_ID=<sessionId> or pass --session <sessionId>',
        });
      }

      const agentId = normalizeAgentId(idRaw);
      const session = await fetchSession(sessionId);

      const ag = session.agents.find(a => a.id === agentId);
      if (!ag) {
        exitError({
          code: 'unknown_agent',
          kind: 'not_found',
          message: `agent ${agentId} not found in session ${sessionId}`,
          received: agentId,
          candidates: session.agents.map(a => a.id),
          next: 'sis session inspect status to list agents',
        });
      }

      const claudeSessionId = ag.claudeSessionId;
      const label = `agent ${ag.id} — ${ag.name} (${ag.status})`;

      if (!claudeSessionId) {
        exitError({
          code: 'no_claude_session',
          kind: 'not_found',
          message: `no claudeSessionId stored for ${label} — transcript may not exist yet`,
          received: agentId,
        });
      }

      await emitTranscript(claudeSessionId, session.cwd, opts);
    });
}
