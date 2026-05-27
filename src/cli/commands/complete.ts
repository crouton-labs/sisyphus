import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import { assertTmux } from '../tmux.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerComplete(program: Command): void {
  program
    .command('complete')
    .description('Mark session as completed (orchestrator only)')
    .requiredOption('--report <report>', 'Final completion report')
    .option('--session <sessionId>', 'Session ID (defaults to SISYPHUS_SESSION_ID env var)')
    .addHelpText(
      'after',
      `
Input
  --report <report>  required. Final completion report text.
  --session <id>     optional. Defaults to $SISYPHUS_SESSION_ID.

Output (stdout, JSON)
  ok, data: { sessionId }

Effects
  Marks the session as completed in daemon state. Orchestrator-only; sub-agents
  use \`sis agent submit\` to deliver their final report instead.

Exit codes: 0 ok | 2 usage (missing session id) | 3 not_found.`,
    )
    .action(async (opts: { report: string; session?: string }) => {
      assertTmux();
      const sessionId = opts.session ?? process.env.SISYPHUS_SESSION_ID;
      if (!sessionId) {
        exitUsage('missing_session_id', 'Provide --session or set SISYPHUS_SESSION_ID environment variable', {
          expected: 'a session id string',
          received: null,
          next: 'export SISYPHUS_SESSION_ID=<sessionId> or pass --session <sessionId>',
        });
      }

      const request: Request = { type: 'complete', sessionId, report: opts.report };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      emitJsonOk({ sessionId }); return;
    });
}
