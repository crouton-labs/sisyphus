import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import { readStdin } from '../stdin.js';
import { assertTmux } from '../tmux.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerReport(program: Command): void {
  program
    .command('report')
    .description('Send a progress report without exiting (agent only)')
    .option('--message <message>', 'Progress report content')
    .option('--stdin', 'Force-read message from stdin (avoids shell escaping for long prompts)')
    .option('--session <sessionId>', 'Session ID (defaults to SISYPHUS_SESSION_ID env var)')
    .addHelpText(
      'after',
      `
agent report: send an intermediate progress checkpoint without exiting.

Input
  --message <text>    optional. Report content (conflicts with --stdin).
  --stdin             optional. Force-read content from stdin.
  --session <id>      optional. Defaults to $SISYPHUS_SESSION_ID.
  stdin               optional. Read when neither --message nor --stdin is given.

Output (stdout, JSON, schema_version: 1)
  ok, schema_version: 1, data: { sessionId, agentId }

Effects
  Records an intermediate checkpoint in the orchestrator; the agent keeps running.

Exit codes: 0 ok | 2 usage | 3 not_found | 60 transient.`,
    )
    .action(async (opts: { message?: string; stdin?: boolean; session?: string }) => {
      assertTmux();
      const sessionId = opts.session ?? process.env.SISYPHUS_SESSION_ID;
      const agentId = process.env.SISYPHUS_AGENT_ID;
      if (!sessionId || !agentId) {
        exitUsage('missing_agent_env', 'Provide --session or set SISYPHUS_SESSION_ID (and SISYPHUS_AGENT_ID) environment variables', {
          received: { sessionId: sessionId ?? null, agentId: agentId ?? null },
          next: 'report is agent-only; SISYPHUS_AGENT_ID is set automatically inside agent panes',
        });
      }

      let content: string | null | undefined;
      if (opts.stdin) {
        content = await readStdin({ force: true });
        if (!content) {
          exitUsage('empty_stdin', '--stdin set but no input received on stdin', {
            next: 'pipe content: `echo "..." | sis agent report --stdin`',
          });
        }
        if (opts.message) {
          exitUsage('stdin_conflict', '--stdin conflicts with --message; pass one source', {
            received: { stdin: true, message: opts.message },
          });
        }
      } else {
        content = opts.message ?? await readStdin();
      }
      if (!content) {
        exitUsage('missing_content', 'provide --message, pipe content via stdin, or use --stdin', {
          next: 'sis agent report --message "..." or sis agent report --stdin <checkpoint.md',
        });
      }

      const request: Request = { type: 'report', sessionId, agentId, content };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      emitJsonOk({ sessionId, agentId }); return;
    });
}
