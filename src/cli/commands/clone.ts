import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import { assertTmux } from '../tmux.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerClone(program: Command): void {
  program
    .command('clone')
    .description('Clone the current session into a new independent session with a different goal')
    .argument('<goal>', 'Goal for the cloned session')
    .option('--context <text>', 'Additional context for the clone')
    .option('--strategy', 'Copy strategy.md from the source session')
    .option('--name <name>', 'Name for the cloned session')
    .addHelpText(
      'after',
      `
Input
  <goal>             required. Goal for the cloned session.
  --context <text>   optional. Additional context to pass to the clone.
  --strategy         optional. Copy strategy.md from the source session.
  --name <name>      optional. Name for the cloned session.

Output (stdout, JSON)
  ok, data: { sessionId, tmuxSessionName, goal }

Effects
  Creates a new independent session with its own roadmap, tmux session, and state.
  Restricted to orchestrator callers; sub-agents must message the orchestrator instead.

Exit codes: 0 ok | 2 usage (missing env / wrong agent) | 3 not_found | 5 conflict.`,
    )
    .action(async (goal: string, opts: { context?: string; strategy?: boolean; name?: string }) => {
      assertTmux();

      const sessionId = process.env.SISYPHUS_SESSION_ID;
      if (!sessionId) {
        exitUsage('missing_session_env', 'SISYPHUS_SESSION_ID not set. Run this from an orchestrator or agent pane.', {
          next: 'clone is invoked from inside a session pane',
        });
      }

      const agentId = process.env.SISYPHUS_AGENT_ID;
      if (agentId !== 'orchestrator') {
        exitUsage('orchestrator_only', 'clone can only be called by the orchestrator. Use `sis orch message` to ask the orchestrator to clone.', {
          received: agentId ?? null,
          expected: 'orchestrator',
        });
      }

      const request: Request = {
        type: 'clone',
        sessionId,
        goal,
        context: opts.context,
        name: opts.name,
        strategy: opts.strategy,
      };

      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      const data = response.data as { sessionId: string; tmuxSessionName: string };
      emitJsonOk({ sessionId: data.sessionId, tmuxSessionName: data.tmuxSessionName, goal }); return;
    });
}
