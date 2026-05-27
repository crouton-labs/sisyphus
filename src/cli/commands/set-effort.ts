import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

const VALID_TIERS = ['low', 'medium', 'high', 'xhigh'] as const;
type EffortTier = typeof VALID_TIERS[number];

export function registerSessionEffort(program: Command): void {
  program
    .command('effort <sessionId>')
    .description('Set the pipeline effort tier for a session (future cycles only; running agents keep their original prompt)')
    .requiredOption('--tier <level>', 'Effort level: low | medium | high | xhigh')
    .addHelpText(
      'after',
      `
Input
  <sessionId>    required. Session to reconfigure.
  --tier         required. Effort level: low | medium | high | xhigh.

Output (stdout, JSON)
  ok, data: { sessionId, effort }

Effects
  Updates the session's effort tier in daemon state.

Exit codes: 0 ok | 2 usage (bad tier) | 3 not_found.`,
    )
    .action(async (sessionId: string, opts: { tier: string }) => {
      const tier = opts.tier;
      if (!VALID_TIERS.includes(tier as EffortTier)) {
        exitUsage('bad_tier', `tier must be one of: ${VALID_TIERS.join(', ')}`, {
          received: tier,
          expected: [...VALID_TIERS],
        });
      }

      const request: Request = { type: 'set-effort', sessionId, effort: tier as EffortTier };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      emitJsonOk({ sessionId, effort: tier }); return;
    });
}
