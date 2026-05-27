import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerAgentRestart(program: Command): void {
  program
    .command('restart <agentId>')
    .description('Restart a failed/killed/lost agent in a new tmux pane')
    .option('--session <sessionId>', 'Session ID (defaults to SISYPHUS_SESSION_ID)')
    .addHelpText(
      'after',
      `
agent ctl restart: respawn a failed or killed agent in a new tmux pane.

Input
  <agentId>          required. Agent to restart (e.g. agent-003).
  --session <id>     optional. Defaults to $SISYPHUS_SESSION_ID.

Output (stdout, JSON)
  ok, data: { sessionId, agentId }

Effects
  Spawns the agent in a new tmux pane; previous pane is discarded.

Exit codes: 0 ok | 2 usage (missing --session) | 3 not_found | 5 conflict (agent still running).`,
    )
    .action(async (agentId: string, opts: { session?: string }) => {
      const sessionId = opts.session ?? process.env.SISYPHUS_SESSION_ID;
      if (!sessionId) {
        exitUsage('missing_session_id', 'Provide --session or set SISYPHUS_SESSION_ID', {
          next: 'export SISYPHUS_SESSION_ID=<sessionId> or pass --session <sessionId>',
        });
      }

      const request: Request = { type: 'restart-agent', sessionId, agentId };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      emitJsonOk({ sessionId, agentId }); return;
    });
}
