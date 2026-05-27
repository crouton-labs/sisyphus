import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import { assertTmux } from '../tmux.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerContinue(program: Command): void {
  program
    .command('continue')
    .description('Clear roadmap and continue working on a completed session (stays in current cycle)')
    .option('--session <sessionId>', 'Session ID (defaults to SISYPHUS_SESSION_ID env var)')
    .addHelpText(
      'after',
      `
Input
  --session <id>     optional. Defaults to $SISYPHUS_SESSION_ID.

Output (stdout, JSON)
  ok, data: { sessionId }

Effects
  Clears the session roadmap and resets status to active. History is preserved.

Exit codes: 0 ok | 2 usage (missing session id) | 3 not_found.`,
    )
    .action(async (opts: { session?: string }) => {
      assertTmux();
      const sessionId = opts.session ?? process.env.SISYPHUS_SESSION_ID;
      if (!sessionId) {
        exitUsage('missing_session_id', 'Provide --session or set SISYPHUS_SESSION_ID environment variable', {
          expected: 'a session id string',
          received: null,
          next: 'export SISYPHUS_SESSION_ID=<sessionId> or pass --session <sessionId>',
        });
      }

      const request: Request = { type: 'continue', sessionId };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      emitJsonOk({ sessionId }); return;
    });
}
