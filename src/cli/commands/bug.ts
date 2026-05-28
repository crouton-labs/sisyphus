import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { readStdin } from '../stdin.js';
import { exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';
import {
  REPO,
  buildBody,
  collectEnv,
  deriveTitle,
  fallbackUrl,
  ghReady,
  resolveSessionStats,
  tailLog,
} from './report-shared.js';

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
