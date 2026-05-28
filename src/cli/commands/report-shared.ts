import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { getSisyphusVersion } from '../../shared/version.js';
import { platformLabel } from '../../shared/platform.js';
import { daemonLogPath, socketPath } from '../../shared/paths.js';
import { getSession } from '../../daemon/state.js';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import type { Session } from '../../shared/types.js';

// Where bug reports / feedback fallbacks land on GitHub. Intrinsic to the tool,
// not user config — if the project moves, this constant moves with the code.
export const REPO = 'crouton-labs/sisyphus';

export function tryCmd(bin: string, args: string[]): string | null {
  try {
    const out = execFileSync(bin, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export interface EnvInfo {
  sisyphus: string;
  platform: string;
  os: string;
  node: string;
  claude: string;
  tmux: string;
  git: string;
  gh: string;
  daemon: string;
}

export function collectEnv(): EnvInfo {
  return {
    sisyphus: getSisyphusVersion(),
    platform: platformLabel(),
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    node: process.version,
    claude: tryCmd('claude', ['--version']) ?? 'not found',
    tmux: tryCmd('tmux', ['-V']) ?? 'not found',
    git: tryCmd('git', ['--version']) ?? 'not found',
    gh: tryCmd('gh', ['--version'])?.split('\n')[0] ?? 'not found',
    daemon: existsSync(socketPath()) ? 'running (socket present)' : 'not running',
  };
}

export interface SessionStats {
  id: string;
  status: string;
  model: string;
  effort: string;
  cycles: number;
  agents: number;
  crashed: number;
}

// Stats only — never task/context/goal text. Reports may become PUBLIC issues.
export function statsFor(session: Session): SessionStats {
  return {
    id: session.id,
    status: session.status,
    model: session.model ?? 'default',
    effort: session.effort ?? 'default',
    cycles: session.orchestratorCycles.length,
    agents: session.agents.length,
    crashed: session.agents.filter((a) => a.status === 'crashed').length,
  };
}

export async function resolveSessionStats(
  explicitId: string | undefined,
  cwd: string,
): Promise<SessionStats | null> {
  if (explicitId) {
    try {
      return statsFor(getSession(cwd, explicitId));
    } catch {
      return null;
    }
  }
  // No explicit id: attach the active session for this cwd, if any.
  try {
    const resp = await sendRequest({ type: 'status', cwd } as Request);
    if (resp.ok) {
      const session = resp.data?.session as Session | undefined;
      if (session) return statsFor(session);
    }
  } catch {
    // daemon unreachable — telemetry is best-effort
  }
  return null;
}

export function tailLog(lines: number): string | null {
  const path = daemonLogPath();
  if (!existsSync(path)) return null;
  try {
    const all = readFileSync(path, 'utf-8').split('\n');
    return all.slice(-lines).join('\n').trim() || null;
  } catch {
    return null;
  }
}

export function deriveTitle(description: string, fallback = 'Bug report'): string {
  const firstLine = description.split('\n').map((l) => l.trim()).find(Boolean) ?? fallback;
  return firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;
}

export function buildBody(args: {
  description: string;
  env: EnvInfo;
  session: SessionStats | null;
  logTail: string | null;
}): string {
  const { description, env, session, logTail } = args;
  const envRows = Object.entries(env)
    .map(([k, v]) => `| ${k} | ${v} |`)
    .join('\n');

  let body = `${description}\n\n---\n\n<details>\n<summary>Environment (auto-collected)</summary>\n\n| field | value |\n|---|---|\n${envRows}\n\n</details>`;

  if (session) {
    body +=
      `\n\n<details>\n<summary>Session stats</summary>\n\n` +
      `| field | value |\n|---|---|\n` +
      `| id | ${session.id} |\n` +
      `| status | ${session.status} |\n` +
      `| model | ${session.model} |\n` +
      `| effort | ${session.effort} |\n` +
      `| cycles | ${session.cycles} |\n` +
      `| agents | ${session.agents} |\n` +
      `| crashed agents | ${session.crashed} |\n\n` +
      `</details>`;
  }

  if (logTail) {
    body +=
      `\n\n<details>\n<summary>daemon.log (tail)</summary>\n\n` +
      '```\n' +
      logTail.replace(/```/g, '`​``') +
      '\n```\n\n</details>';
  }

  return body;
}

export function fallbackUrl(title: string, body: string): string {
  const base = `https://github.com/${REPO}/issues/new`;
  const t = encodeURIComponent(title);
  let b = encodeURIComponent(body);
  // GitHub rejects new-issue URLs past ~8KB. Drop diagnostics if too long.
  if (base.length + t.length + b.length > 7500) {
    b = encodeURIComponent(
      body.split('\n\n---\n\n')[0] +
        '\n\n---\n\n_(diagnostics omitted — URL too long. Authenticate `gh` and re-run to attach full telemetry.)_',
    );
  }
  return `${base}?title=${t}&body=${b}`;
}

export function ghReady(): boolean {
  if (!tryCmd('gh', ['--version'])) return false;
  const auth = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 5000 });
  return auth.status === 0;
}
