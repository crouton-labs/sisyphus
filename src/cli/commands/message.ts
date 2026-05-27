import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import { readStdin } from '../stdin.js';
import type { Request } from '../../shared/protocol.js';
import type { MessageSource } from '../../shared/types.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerMessage(program: Command): void {
  program
    .command('message')
    .description('Queue a message for the orchestrator to see on next cycle')
    .option('--session <sessionId>', 'Session ID (defaults to SISYPHUS_SESSION_ID env var)')
    .option('--agent <agentId>', 'Route message to a specific agent inbox instead of the orchestrator')
    .option('--stdin', 'Force-read message content from stdin (avoids shell escaping for long prompts)')
    .addHelpText(
      'after',
      `
orch message: queue a message for the orchestrator (or a specific agent) to see on next cycle.

Input
  stdin              required. Message body; pipe content directly.
  --stdin            optional. Force-read from stdin (avoids shell escaping).
  --session <id>     optional. Defaults to $SISYPHUS_SESSION_ID.
  --agent <agentId>  optional. Routes to a specific agent inbox instead of orchestrator.

Output (stdout, JSON)
  ok, data: { sessionId, agentId? }

Effects
  Queues the message in the daemon inbox for the target; delivered on next cycle.

Exit codes: 0 ok | 2 usage (missing content or --session) | 3 not_found.`,
    )
    .action(async (opts: { session?: string; agent?: string; stdin?: boolean }) => {
      const sessionId = opts.session ?? process.env.SISYPHUS_SESSION_ID;
      if (!sessionId) {
        exitUsage('missing_session_id', 'Provide --session or set SISYPHUS_SESSION_ID environment variable', {
          next: 'export SISYPHUS_SESSION_ID=<sessionId> or pass --session <sessionId>',
        });
      }

      let content: string | null | undefined;
      if (opts.stdin) {
        content = await readStdin({ force: true });
        if (!content) {
          exitUsage('empty_stdin', '--stdin set but no input received on stdin', {
            next: 'pipe content: `echo "..." | sis orch message --stdin`',
          });
        }
      } else {
        content = await readStdin();
        if (!content) {
          exitUsage('missing_content', 'pipe content via stdin or use --stdin', {
            next: 'echo "text" | sis orch message — or sis orch message --stdin <hint.md',
          });
        }
      }

      const source: MessageSource | undefined = process.env.SISYPHUS_AGENT_ID
        ? { type: 'agent' as const, agentId: process.env.SISYPHUS_AGENT_ID }
        : undefined;

      const request: Request = { type: 'message', sessionId, content: content!, source, ...(opts.agent ? { agentId: opts.agent } : {}) };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      emitJsonOk({ sessionId, ...(opts.agent ? { agentId: opts.agent } : {}) }); return;
    });
}
