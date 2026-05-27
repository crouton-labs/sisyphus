import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerAgentKill(program: Command): void {
  program
    .command('kill <agentId>')
    .description('Kill a running agent')
    .option('--session <sessionId>', 'Session ID (defaults to SISYPHUS_SESSION_ID)')
    .addHelpText(
      'after',
      `
agent ctl kill: forcibly terminate a running agent.

Input
  <agentId>          required. Agent to kill (e.g. agent-003).
  --session <id>     optional. Defaults to $SISYPHUS_SESSION_ID.

Output (stdout, JSON)
  ok, data: { sessionId, agentId }

Effects
  Sends a kill signal to the agent's tmux pane and marks the agent terminated in daemon state.

Exit codes: 0 ok | 2 usage (missing --session) | 3 not_found.`,
    )
    .action(async (agentId: string, opts: { session?: string }) => {
      const sessionId = opts.session ?? process.env.SISYPHUS_SESSION_ID;
      if (!sessionId) {
        exitUsage('missing_session_id', 'Provide --session or set SISYPHUS_SESSION_ID', {
          next: 'export SISYPHUS_SESSION_ID=<sessionId> or pass --session <sessionId>',
        });
      }

      const request: Request = { type: 'kill-agent', sessionId, agentId };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      emitJsonOk({ sessionId, agentId }); return;
    });
}
