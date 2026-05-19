import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import type { Session } from '../../shared/types.js';
import { exitError } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('Show session status')
    .argument('[session-id]', 'Session ID (defaults to SISYPHUS_SESSION_ID env)')
    .addHelpText(
      'after',
      `
Input
  [session-id]  optional. Defaults to $SISYPHUS_SESSION_ID.

Output (stdout, JSON)
  ok, schema_version: 1, data: { session }
  session is null when no matching session is found.

Effects
  None. Read-only.
  Pane capture: read via \`sis orch read\` or \`sis agent io read\`.

Exit codes: 0 ok | 3 not_found.`,
    )
    .action(async (sessionIdArg: string | undefined) => {
      const sessionId = sessionIdArg ?? process.env.SISYPHUS_SESSION_ID;
      const cwd = process.env['SISYPHUS_CWD'] ?? process.cwd();

      const request: Request = { type: 'status', sessionId, cwd };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      const session = response.data?.session as Session | undefined;
      if (!session) {
        emitJsonOk({ session: null });
        return;
      }
      emitJsonOk({ session });
    });
}
