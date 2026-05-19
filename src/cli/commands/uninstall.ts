import type { Command } from 'commander';
import { createInterface } from 'node:readline';
import { uninstallDaemon } from '../install.js';

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

export function registerUninstall(program: Command): void {
  program
    .command('uninstall')
    .description('Unload the sisyphus daemon from launchd and remove the plist')
    .option('--purge', 'Also remove all session data in ~/.sisyphus')
    .option('--yes', 'Skip confirmation prompt for --purge')
    .addHelpText(
      'after',
      `
uninstall: stop and unregister the sisyphus daemon.

Input
  --purge    optional boolean — DESTRUCTIVE: also deletes all data in ~/.sisyphus
             (session history, roadmaps, agent reports, config, keybind scripts).
  --yes      optional boolean — skip the confirmation prompt required by --purge.

Output (stdout, plain text)
  Status messages from the uninstall process.

Effects
  Unloads the sisyphus daemon from launchd (macOS) and removes the launchd plist.
  --purge: permanently deletes ~/.sisyphus and all its contents — this cannot be undone.

Exit codes: 0 ok`,
    )
    .action(async (opts: { purge?: boolean; yes?: boolean }) => {
      const purge = opts.purge ?? false;

      if (purge && !opts.yes) {
        const ok = await confirm('This will delete all session data in ~/.sisyphus. Continue? (y/N) ');
        if (!ok) {
          console.log('Aborted.');
          return;
        }
      }

      await uninstallDaemon(purge);
    });
}
