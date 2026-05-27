import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import { exitError } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerReconnect(program: Command): void {
  program
    .command('reconnect')
    .description('Reconnect daemon to an orphaned tmux session (no state change, no orchestrator spawn)')
    .argument('<session-id>', 'Session ID to reconnect')
    .addHelpText(
      'after',
      `
Input
  <session-id>       required. ID of the orphaned session to reattach.

Output (stdout, JSON)
  ok, data: { sessionId, tmuxSessionName, tmuxWindowId }

Effects
  Registers the existing tmux session with the daemon. No orchestrator is spawned and no session state changes.

Exit codes: 0 ok | 3 not_found.`,
    )
    .action(async (sessionId: string) => {
      const cwd = process.env['SISYPHUS_CWD'] ?? process.cwd();
      const request: Request = { type: 'reconnect', sessionId, cwd };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      const tmuxSessionName = response.data?.tmuxSessionName as string;
      const tmuxWindowId = response.data?.tmuxWindowId as string;
      emitJsonOk({ sessionId, tmuxSessionName, tmuxWindowId }); return;
    });
}
