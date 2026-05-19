import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import { exitError } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerSegmentUnregister(program: Command): void {
  program
    .command('unregister')
    .description('Remove an external status bar segment')
    .requiredOption('--id <id>', 'Segment identifier to remove')
    .addHelpText(
      'after',
      `
Input
  --id <id>    required. Segment identifier to remove.

Output (stdout, JSON, schema_version: 1)
  ok, schema_version: 1, data: { id }

Effects
  Removes the named segment from the status bar.

Exit codes: 0 ok | 3 not_found.`,
    )
    .action(async (opts: { id: string }) => {
      const request: Request = { type: 'unregister-segment', id: opts.id };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      emitJsonOk({ id: opts.id }); return;
    });
}
