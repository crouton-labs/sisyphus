import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerSessionTask(program: Command): void {
  program
    .command('task <task>')
    .description('Update the session task/goal')
    .option('--session <sessionId>', 'Session ID (defaults to SISYPHUS_SESSION_ID env var)')
    .addHelpText(
      'after',
      `
Input
  <task>             required. New task/goal string for the session.
  --session <id>     optional. Defaults to $SISYPHUS_SESSION_ID.

Output (stdout, JSON, schema_version: 1)
  ok, schema_version: 1, data: { sessionId, task }

Effects
  Overwrites the session's stored task field in daemon state.

Exit codes: 0 ok | 2 usage (missing --session) | 3 not_found.`,
    )
    .action(async (task: string, opts: { session?: string }) => {
      const sessionId = opts.session ?? process.env.SISYPHUS_SESSION_ID;
      if (!sessionId) {
        exitUsage('missing_session_id', 'Provide --session or set SISYPHUS_SESSION_ID environment variable', {
          next: 'export SISYPHUS_SESSION_ID=<sessionId> or pass --session <sessionId>',
        });
      }

      const request: Request = { type: 'update-task', sessionId, task };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      emitJsonOk({ sessionId, task }); return;
    });
}
