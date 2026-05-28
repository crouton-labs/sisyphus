import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { readStdin } from '../stdin.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';
import { loadConfig } from '../../shared/config.js';
import type { UploadConfig } from '../../shared/config.js';
import { isUploadConfigured } from '../../shared/upload.js';
import { getSisyphusVersion } from '../../shared/version.js';
import { platformLabel } from '../../shared/platform.js';
import {
  REPO,
  buildBody,
  collectEnv,
  deriveTitle,
  fallbackUrl,
  ghReady,
  resolveSessionStats,
  type SessionStats,
} from './report-shared.js';

interface CloudFeedbackResult {
  feedbackId: string;
  receivedAt: string;
}

async function sendToCloud(
  config: UploadConfig,
  payload: {
    message: string;
    sisyphusVersion: string;
    platform: string;
    session: SessionStats | null;
  },
): Promise<CloudFeedbackResult> {
  const res = await fetch(`${config.url}/feedback`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const raw = await res.text();
    const body = raw.length > 2048 ? raw.slice(0, 2048) + '… [truncated]' : raw;
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === 'string') detail = parsed.error;
    } catch { /* keep raw body */ }
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }

  return (await res.json()) as CloudFeedbackResult;
}

export function registerFeedback(program: Command): void {
  program
    .command('feedback')
    .description('Send feedback about sisyphus itself — private cloud if registered, else a GitHub issue')
    .argument('[message]', 'The feedback (omit to read from stdin)')
    .option('--message <message>', 'Feedback text (alternative to the positional argument)')
    .option('--stdin', 'Read the feedback from stdin (avoids shell escaping for long notes)')
    .option('--session <id>', 'Attach stats for a specific session (default: active session for cwd)')
    .option('--no-session', 'Do not attach any session stats')
    .option('--cwd <path>', 'Project directory used to find the active session', process.cwd())
    .addHelpText(
      'after',
      `
feedback: report a problem or suggestion about SISYPHUS ITSELF — the tool, the
CLI, the orchestration workflow — not about the user's own task or codebase.

When to use (agent guidance)
  Run this whenever the user gripes about sisyphus: a daemon crash, a CLI that
  misbehaved, a confusing or broken workflow, a rough edge, a feature wish.
  Filing it is a low-cost, helpful side-action — do it WITHOUT asking the user
  first. Summarize their complaint in your own words as the message.
  NOT for the user's project work, code bugs, or task questions.

Input
  [message]       optional positional — the feedback (omit to read from stdin or --message).
  --message <msg> feedback text (alternative to the positional argument).
  --stdin         read the feedback from stdin (avoids shell escaping for long notes).
  --session <id>  attach stats for a specific session (default: active session for cwd).
  --no-session    do not attach any session stats.
  --cwd <path>    project directory used to find the active session (default: cwd).

Where it goes
  - Cloud registered (sis admin report configure-upload set up):
    POSTs privately to the upload worker's /feedback endpoint. Stays private.
  - Not registered: falls back to a GitHub issue against ${REPO}
    (via \`gh\` if authenticated, else a prefilled "new issue" URL). PUBLIC.

Telemetry attached (non-sensitive): sisyphus version, platform, and session
STATS only (counts/status) — never task/goal/context text.

Output (stdout, JSON envelope)
  cloud:  { ok, data: { sent: true, channel: "cloud", feedbackId, receivedAt } }
  github: { ok, data: { sent, channel: "github", issueUrl | url } }

Exit codes: 0 ok | 1 filing error | 2 usage | 60 cloud unreachable (retry-safe)`,
    )
    .action(
      async (
        messageArg: string | undefined,
        opts: {
          message?: string;
          stdin?: boolean;
          session?: string | false;
          cwd: string;
        },
      ) => {
        let message: string | null | undefined;
        if (opts.stdin) {
          message = await readStdin({ force: true });
          if (opts.message || messageArg) {
            exitUsage('stdin_conflict', '--stdin conflicts with --message / positional message; pass one source', {
              received: { stdin: true, message: opts.message ?? messageArg },
            });
          }
        } else {
          message = messageArg ?? opts.message ?? (await readStdin());
        }
        if (!message || !message.trim()) {
          exitUsage('missing_message', 'provide feedback (argument, --message, or piped stdin)', {
            next: 'sis feedback "what is wrong or could be better" — or: sis feedback --stdin < notes.md',
          });
        }
        message = message.trim();

        // commander stores `--no-session` as opts.session === false
        const sessionDisabled = opts.session === false;
        const session = sessionDisabled
          ? null
          : await resolveSessionStats(
              typeof opts.session === 'string' ? opts.session : undefined,
              opts.cwd,
            );

        const config = loadConfig(opts.cwd);

        // Cloud channel: private, preferred when the upload worker is registered.
        if (isUploadConfigured(config.upload)) {
          try {
            const result = await sendToCloud(config.upload, {
              message,
              sisyphusVersion: getSisyphusVersion(),
              platform: platformLabel(),
              session,
            });
            emitJsonOk({ sent: true, channel: 'cloud', ...result });
            return;
          } catch (err) {
            // Don't silently fall through to a PUBLIC GitHub issue when the user
            // chose a private channel — surface a retry-safe transient instead.
            exitError({
              kind: 'transient',
              code: 'cloud_unreachable',
              message: `feedback upload failed: ${(err as Error).message}`,
              next: 'retry shortly, or file publicly with `sis admin report bug`',
            });
          }
        }

        // GitHub channel: public fallback when no cloud is registered.
        const env = collectEnv();
        const title = `Feedback: ${deriveTitle(message, 'Feedback')}`;
        const body = buildBody({ description: message, env, session, logTail: null });

        if (!ghReady()) {
          emitJsonOk({ sent: false, channel: 'github', url: fallbackUrl(title, body) });
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
          emitJsonOk({ sent: false, channel: 'github', url, error: stderr });
          process.exit(1);
        }

        const issueUrl = (result.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
        emitJsonOk({ sent: true, channel: 'github', issueUrl });
      },
    );
}
