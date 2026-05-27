import type { Command } from 'commander';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { readStdin } from '../stdin.js';
import { exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';
import { sendRequest } from '../client.js';
import { getSisyphusVersion } from '../../shared/version.js';
import { platformLabel } from '../../shared/platform.js';
import { daemonLogPath, socketPath } from '../../shared/paths.js';
import { getSession } from '../../daemon/state.js';
import type { Request } from '../../shared/protocol.js';
import type { Session } from '../../shared/types.js';

// Where bug reports land. Intrinsic to the tool, not user config — if the
// project moves, this constant moves with the code that files against it.
const REPO = 'crouton-labs/sisyphus';

function tryCmd(bin: string, args: string[]): string | null {
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

interface EnvInfo {
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

function collectEnv(): EnvInfo {
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

interface SessionStats {
  id: string;
  status: string;
  model: string;
  effort: string;
  cycles: number;
  agents: number;
  crashed: number;
}

// Stats only — never task/context/goal text. Bug reports become PUBLIC issues.
function statsFor(session: Session): SessionStats {
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

async function resolveSessionStats(
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

function tailLog(lines: number): string | null {
  const path = daemonLogPath();
  if (!existsSync(path)) return null;
  try {
    const all = readFileSync(path, 'utf-8').split('\n');
    return all.slice(-lines).join('\n').trim() || null;
  } catch {
    return null;
  }
}

function deriveTitle(description: string): string {
  const firstLine = description.split('\n').map((l) => l.trim()).find(Boolean) ?? 'Bug report';
  return firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;
}

function buildBody(args: {
  description: string;
  env: EnvInfo;
  session: SessionStats | null;
  logTail: string | null;
}): string {
  const { description, env, session, logTail } = args;
  const envRows = Object.entries(env)
    .map(([k, v]) => `| ${k} | ${v} |`)
    .join('\n');

  let body = `${description}\n\n---\n\n<details>\n<summary>Environment (auto-collected by <code>sis admin report bug</code>)</summary>\n\n| field | value |\n|---|---|\n${envRows}\n\n</details>`;

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

function fallbackUrl(title: string, body: string): string {
  const base = `https://github.com/${REPO}/issues/new`;
  const t = encodeURIComponent(title);
  let b = encodeURIComponent(body);
  // GitHub rejects new-issue URLs past ~8KB. Drop diagnostics if too long.
  if (base.length + t.length + b.length > 7500) {
    b = encodeURIComponent(
      body.split('\n\n---\n\n')[0] +
        '\n\n---\n\n_(diagnostics omitted — URL too long. Authenticate `gh` and re-run `sis admin report bug` to attach full telemetry.)_',
    );
  }
  return `${base}?title=${t}&body=${b}`;
}

function ghReady(): boolean {
  if (!tryCmd('gh', ['--version'])) return false;
  const auth = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 5000 });
  return auth.status === 0;
}

export function registerBug(program: Command): void {
  program
    .command('bug')
    .description('Report a sisyphus bug — files a GitHub issue with feedback + diagnostics')
    .argument('[description]', 'What went wrong (omit to read from stdin)')
    .option('--message <message>', 'Bug description (alternative to the positional argument)')
    .option('--stdin', 'Read the description from stdin (avoids shell escaping for long reports)')
    .option('--title <title>', 'Issue title (default: first line of the description)')
    .option('--session <id>', 'Attach stats for a specific session (default: active session for cwd)')
    .option('--no-session', 'Do not attach any session stats')
    .option('--logs [n]', 'Attach the last N lines of daemon.log (default 50)')
    .option('--cwd <path>', 'Project directory used to find the active session', process.cwd())
    .addHelpText(
      'after',
      `
bug: report a sisyphus bug — files a GitHub issue with feedback + diagnostics.

Input
  [description]     optional positional — what went wrong (omit to read from stdin or --message).
  --message <msg>   bug description (alternative to the positional argument).
  --stdin           read the description from stdin (avoids shell escaping for long reports).
  --title <title>   issue title (default: first line of the description).
  --session <id>    attach stats for a specific session (default: active session for cwd).
  --no-session      do not attach any session stats.
  --logs [n]        attach the last N lines of daemon.log (default 50).
  --cwd <path>      project directory used to find the active session (default: cwd).

Telemetry attached (all non-sensitive — bug reports become PUBLIC issues):
  - Versions / platform (sisyphus, node, claude, tmux, git, gh, OS)
  - Daemon running state
  - Session STATS only (counts, durations, status) — never task/goal/context text
  - daemon.log tail only with --logs (may contain file paths — review before filing)

Filing:
  Uses \`gh issue create\` against ${REPO}. If \`gh\` is missing or
  unauthenticated, opens a prefilled GitHub "new issue" URL instead.

Output (stdout, JSON envelope)
  { ok, data: { url | issueUrl, filed } }

Exit codes: 0 ok | 1 filing error | 2 usage`,
    )
    .action(
      async (
        descriptionArg: string | undefined,
        opts: {
          message?: string;
          stdin?: boolean;
          title?: string;
          session?: string;
          logs?: string | boolean;
          cwd: string;
        },
      ) => {
        let description: string | null | undefined;
        if (opts.stdin) {
          description = await readStdin({ force: true });
          if (opts.message || descriptionArg) {
            exitUsage('stdin_conflict', '--stdin conflicts with --message / positional description; pass one source', {
              received: { stdin: true, message: opts.message ?? descriptionArg },
            });
          }
        } else {
          description = descriptionArg ?? opts.message ?? (await readStdin());
        }
        if (!description || !description.trim()) {
          exitUsage('missing_description', 'provide a bug description (argument, --message, or piped stdin)', {
            next: 'sis admin report bug "what went wrong" — or: sis admin report bug --stdin < report.md',
          });
        }
        description = description.trim();

        const env = collectEnv();

        // commander stores `--no-session` as opts.session === false
        const sessionDisabled = (opts.session as unknown) === false;
        const session = sessionDisabled
          ? null
          : await resolveSessionStats(
              typeof opts.session === 'string' ? opts.session : undefined,
              opts.cwd,
            );

        let logTail: string | null = null;
        if (opts.logs !== undefined) {
          const n = typeof opts.logs === 'string' ? parseInt(opts.logs, 10) || 50 : 50;
          logTail = tailLog(n);
        }

        const title = opts.title ?? deriveTitle(description);
        const body = buildBody({ description, env, session, logTail });

        if (!ghReady()) {
          const url = fallbackUrl(title, body);
          emitJsonOk({ url, filed: false });
          return;
        }

        const result = spawnSync(
          'gh',
          ['issue', 'create', '--repo', REPO, '--title', title, '--body-file', '-'],
          { input: body, encoding: 'utf-8', timeout: 30000 },
        );

        if (result.status !== 0) {
          const url = fallbackUrl(title, body);
          const stderr = (result.stderr ?? '').trim();
          emitJsonOk({ url, filed: false, error: stderr });
          process.exit(1);
        }

        const issueUrl = (result.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
        emitJsonOk({ issueUrl, filed: true });
      },
    );
}
