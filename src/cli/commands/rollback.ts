import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerRollback(program: Command): void {
  program
    .command('rollback <sessionId>')
    .description('Roll back a session to a previous cycle boundary')
    .requiredOption('--cycle <n>', 'Target cycle boundary (positive integer >= 1)')
    .addHelpText(
      'after',
      `
Input
  <sessionId>        required. Session to roll back.
  --cycle N          required. Target cycle boundary (positive integer >= 1).

Output (stdout, JSON)
  ok, data: { sessionId, restoredToCycle }

Effects
  Restores session state to the specified cycle boundary; discards all later cycle data.

Exit codes: 0 ok | 2 usage (cycle must be positive integer) | 3 not_found.`,
    )
    .action(async (sessionId: string, opts: { cycle: string }) => {
      const toCycle = parseInt(opts.cycle, 10);
      if (isNaN(toCycle) || toCycle < 1) {
        exitUsage('bad_cycle', 'cycle must be a positive integer', {
          received: opts.cycle,
          expected: 'positive integer >= 1',
        });
      }

      const cwd = process.env['SISYPHUS_CWD'] ?? process.cwd();
      const request: Request = { type: 'rollback', sessionId, cwd, toCycle };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      const data = response.data as { restoredToCycle: number };
      emitJsonOk({ sessionId, restoredToCycle: data.restoredToCycle }); return;
    });
}
