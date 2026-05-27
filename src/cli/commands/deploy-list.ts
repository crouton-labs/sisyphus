import type { Command } from 'commander';
import { PROVIDERS } from '../deploy/creds.js';
import { isProvisioned } from '../deploy/runner.js';
import { emitJsonOk } from '../output.js';

export function registerDeployList(deploy: Command): void {
  deploy
    .command('list')
    .description('List available deploy providers')
    .addHelpText(
      'after',
      `
deploy list: list installable deploy providers (hetzner, aws, ...).

Input
  None.

Output (stdout, JSON)
  ok, data: { providers: [{ name, status }, ...] }
  Sorted by name ascending. No pagination — bounded set.

Effects
  None. Read-only.

Exit codes: 0 ok.`,
    )
    .action(() => {
      const providers = [...PROVIDERS]
        .sort()
        .map(name => ({
          name,
          status: isProvisioned(name) ? 'provisioned' : 'not provisioned',
        }));
      emitJsonOk({ providers });
    });
}
