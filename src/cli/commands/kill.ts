import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import { exitError } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerKill(program: Command): void {
  program
    .command('kill <sessionId>')
    .description('Kill a running session and all its agents')
    .addHelpText(
      'after',
      `
Input
  <sessionId>        required. Session to kill.

Output (stdout, JSON, schema_version: 1)
  ok, schema_version: 1, data: { sessionId, killedAgents }

Effects
  Terminates all running agents and stops the session process.

Exit codes: 0 ok | 3 not_found | 60 transient.`,
    )
    .action(async (sessionId: string) => {
      const request: Request = { type: 'kill', sessionId };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      const killedAgents = (response.data as { killedAgents?: number } | undefined)?.killedAgents ?? 0;
      emitJsonOk({ sessionId, killedAgents }); return;
    });
}
