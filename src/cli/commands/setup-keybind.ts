import type { Command } from 'commander';
import { DEFAULT_CYCLE_KEY, setupTmuxKeybind } from '../tmux-setup.js';

export function registerSetupKeybind(program: Command): void {
  program
    .command('setup-keybind [cycle-key]')
    .description('Install sisyphus tmux keybindings (default: M-s cycle, C-s prefix)')
    .option('--yes', 'Auto-accept the y/N prompt before appending source-file to ~/.tmux.conf')
    .option('--force', 'Override safety refusals: overwrite existing key bindings AND auto-append the source-file line')
    .addHelpText(
      'after',
      `
setup-keybind: install the sisyphus tmux keybinding scripts and wire them into tmux.

Input
  [cycle-key]    optional positional — tmux key for the session-cycle binding.
                 Format: M-<char> (e.g. M-s, M-w, M-a). Defaults to M-s.
  --yes          optional boolean — auto-accept the ~/.tmux.conf append prompt.
  --force        optional boolean — overwrite conflicting bindings AND auto-append
                 source-file to ~/.tmux.conf without prompting.

Output (stdout, plain text)
  Status message describing the result (installed, conflict details, or refusal reason).

Effects
  Writes keybinding shell scripts to ~/.sisyphus/.
  Binds [cycle-key] and C-s in the live tmux session via \`tmux bind-key\`.
  May append a source-file line to ~/.tmux.conf (prompts unless --yes/--force).

Exit codes: 0 ok | 1 conflict or requires-force`,
    )
    .action(async (key: string | undefined, opts: { yes?: boolean; force?: boolean }) => {
      const resolvedKey = key === undefined ? DEFAULT_CYCLE_KEY : key;
      const result = await setupTmuxKeybind(resolvedKey, undefined, {
        assumeYes: opts.yes,
        force: opts.force,
      });

      switch (result.status) {
        case 'installed':
          console.log(result.message);
          console.log('Note: requires tmux 3.2+ for display-menu keybindings.');
          break;
        case 'already-installed':
          console.log(result.message);
          break;
        case 'conflict':
          console.log(`Key ${result.conflictKey} is already bound:`);
          console.log(`  ${result.existingBinding}`);
          console.log('');
          console.log('Options:');
          console.log('  - Pick a different cycle key:  sis admin install setup-keybind M-w');
          console.log('  - Run "sis admin check check-keybinds" for a full breakdown');
          console.log('  - Override and overwrite:      sis admin install setup-keybind --force');
          process.exitCode = 1;
          break;
        case 'unsupported-tmux':
          console.log(result.message);
          process.exitCode = 1;
          break;
        case 'requires-force':
          console.log(result.message);
          console.log('');
          console.log('Run "sis admin check check-keybinds" first if you want the full decision tree before deciding.');
          process.exitCode = 1;
          break;
        case 'conf-modification-declined':
          console.log(result.message);
          console.log('');
          console.log('Re-run with --force to append automatically.');
          break;
      }
    });
}
