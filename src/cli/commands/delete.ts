import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import { exitError } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerDelete(program: Command): void {
  program
    .command('delete <sessionId>')
    .description('Delete a session and all its data (state.json, logs, panes)')
    .option('--cwd <path>', 'Project directory (default: $SISYPHUS_CWD or cwd)')
    .addHelpText(
      'after',
      `
Input
  <sessionId>        required. Session to delete.
  --cwd <path>       optional. Project directory; defaults to $SISYPHUS_CWD or cwd.

Output (stdout, JSON)
  ok, data: { sessionId }

Effects
  Permanently removes state.json, logs, and all pane records for the session.

Exit codes: 0 ok | 3 not_found | 5 conflict (session still running — kill first).`,
    )
    .action(async (sessionId: string, opts: { cwd?: string }) => {
      const cwd = opts.cwd ?? process.env.SISYPHUS_CWD ?? process.cwd();
      const request: Request = { type: 'delete', sessionId, cwd };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      emitJsonOk({ sessionId }); return;
    });
}
