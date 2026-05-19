import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import { readStdin } from '../stdin.js';
import { assertTmux } from '../tmux.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerSubmit(program: Command): void {
  program
    .command('submit')
    .description('Submit work report and exit (agent only)')
    .option('--report <report>', 'Work report (or pipe via stdin)')
    .option('--stdin', 'Force-read report from stdin (avoids shell escaping for long prompts)')
    .option('--session <sessionId>', 'Session ID (defaults to SISYPHUS_SESSION_ID env var)')
    .addHelpText(
      'after',
      `
agent submit: deliver final work report and close the agent pane.

Input
  --report <text>    optional. Work report text; or pipe via stdin.
  --stdin            optional. Force-read report from stdin (avoids shell escaping).
  --session <id>     optional. Defaults to $SISYPHUS_SESSION_ID.
  stdin              optional. Piped input used as report when --report is omitted.

Output (stdout, JSON)
  ok, schema_version: 1, data: { sessionId, agentId }

Effects
  Persists the report, closes the agent pane, and signals the daemon. The orchestrator
  resumes when all spawned agents have submitted.

Exit codes: 0 ok | 2 usage (missing report, --session, or SISYPHUS_AGENT_ID) | 3 not_found.`,
    )
    .action(async (opts: { report?: string; stdin?: boolean; session?: string }) => {
      assertTmux();
      const sessionId = opts.session ?? process.env.SISYPHUS_SESSION_ID;
      const agentId = process.env.SISYPHUS_AGENT_ID;
      if (!sessionId || !agentId) {
        exitUsage('missing_agent_env', 'Provide --session or set SISYPHUS_SESSION_ID (and SISYPHUS_AGENT_ID) environment variables', {
          received: { sessionId: sessionId ?? null, agentId: agentId ?? null },
          next: 'submit is agent-only; SISYPHUS_AGENT_ID is set automatically inside agent panes',
        });
      }

      let report: string | null | undefined;
      if (opts.stdin) {
        report = await readStdin({ force: true });
        if (!report) {
          exitUsage('empty_stdin', '--stdin set but no input received on stdin', {
            next: 'pipe content: `cat report.md | sis agent submit --stdin`',
          });
        }
        if (opts.report) {
          exitUsage('stdin_conflict', '--stdin conflicts with --report; pass one source', {
            received: { stdin: true, report: opts.report },
          });
        }
      } else {
        report = opts.report ?? await readStdin();
      }
      if (!report) {
        exitUsage('missing_report', 'provide --report, pipe content via stdin, or use --stdin', {
          next: 'sis agent submit --report "..." or sis agent submit --stdin <report.md',
        });
      }

      const request: Request = { type: 'submit', sessionId, agentId, report };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      emitJsonOk({ sessionId, agentId }); return;
    });
}
