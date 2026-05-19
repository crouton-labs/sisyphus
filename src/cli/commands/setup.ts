import { execSync } from 'node:child_process';
import type { Command } from 'commander';
import { runOnboarding, type OnboardResult } from '../onboard.js';
import { ensureDaemonInstalled, isInstalled } from '../install.js';
import { setupTmuxKeybind, DEFAULT_CYCLE_KEY, DEFAULT_PREFIX_KEY } from '../tmux-setup.js';

function getTmuxVersion(): string {
  try {
    return execSync('tmux -V', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return 'installed';
  }
}

function printResults(result: OnboardResult, daemonOk: boolean, keybindMsg: string): void {
  console.log('');
  console.log('Setting up Sisyphus...');
  console.log('');

  // Platform banner
  console.log(`  \u2713 Platform: ${result.platform.label}`);

  // tmux
  if (result.tmuxInstalled) {
    const detail = getTmuxVersion();
    console.log(`  \u2713 tmux: ${detail}${result.tmuxAutoInstalled ? ' (just installed)' : ''}`);
  } else {
    const hint = process.platform === 'darwin'
      ? 'Install Homebrew (https://brew.sh) then: brew install tmux'
      : 'apt install tmux (Debian/Ubuntu) or your package manager';
    console.log(`  \u2717 tmux: Not installed \u2014 ${hint}`);
  }

  // Clipboard (non-darwin: pbcopy is always present on macOS)
  if (process.platform !== 'darwin') {
    if (result.platform.clipboardTool !== null) {
      console.log(`  \u2713 Clipboard: ${result.platform.clipboardTool}`);
    } else {
      const hint = result.platform.clipboardHint === null
        ? 'Install xclip / wl-clipboard'
        : result.platform.clipboardHint;
      console.log(`  \u2717 Clipboard: no backend \u2014 ${hint}`);
    }

    // Notifications via libnotify (Linux/WSL)
    if (result.platform.notifySendAvailable) {
      console.log('  \u2713 Notifications: notify-send');
    } else {
      console.log('  \u26a0 Notifications: notify-send missing \u2014 sudo apt install libnotify-bin');
    }
  }

  // WSL-specific: systemd opt-in for the daemon
  if (result.platform.wslSystemdEnabled === false) {
    console.log('  \u26a0 WSL systemd: disabled \u2014 add `[boot]\\nsystemd=true` to /etc/wsl.conf');
    console.log('    then run `wsl --shutdown` in PowerShell. The daemon can still be started manually with `sisyphusd &`.');
  }

  // tmux config
  if (result.tmuxDefaultsWritten) {
    console.log('  \u2713 tmux config: Sensible defaults written to ~/.tmux.conf');
  }

  // Terminal
  if (process.platform === 'darwin') {
    if (result.terminal.isIterm) {
      console.log(`  \u2713 Terminal: ${result.terminal.name}`);
    } else {
      const name = result.terminal.name ? result.terminal.name : 'unknown';
      console.log(`  \u26a0 Terminal: ${name} \u2014 iTerm2 recommended (https://iterm2.com)`);
    }
  }

  // iTerm option key
  if (result.itermOptionKey.checked) {
    if (result.itermOptionKey.allCorrect) {
      console.log('  \u2713 Right Option Key: Esc+');
    } else {
      const profiles = result.itermOptionKey.incorrectProfiles.map((p) => `"${p}"`).join(', ');
      console.log(`  \u26a0 Right Option Key: Not set to Esc+ for ${profiles}`);
      console.log('    Fix: iTerm2 \u2192 Settings \u2192 Profiles \u2192 Keys \u2192 Right Option Key \u2192 Esc+');
    }
  }

  // Daemon
  if (daemonOk) {
    console.log('  \u2713 Daemon: Running');
  } else {
    console.log('  \u2717 Daemon: Failed to start');
  }

  // Keybindings
  console.log(`  \u2713 Keybindings: ${keybindMsg}`);

  // Session bar
  console.log('  \u2713 Status bar: daemon-rendered via @sisyphus_left / @sisyphus_right');
  console.log('    status-left:  #{E:@sisyphus_left}');
  console.log('    status-right: #{E:@sisyphus_right}');

  // Sisyphus user plugin (slash commands: /sisyphus:begin, /sisyphus:autopsy, /sisyphus:configure-upload)
  if (result.sisyphusPlugin.installed && result.sisyphusPlugin.installPath) {
    const suffix = result.sisyphusPlugin.autoInstalled ? ' (just installed)' : '';
    console.log(`  \u2713 sisyphus@sisyphus plugin: ${result.sisyphusPlugin.installPath}${suffix}`);
  } else {
    console.log('  \u2717 sisyphus@sisyphus plugin: Failed to install (needs `claude` CLI)');
  }

  // Nvim
  if (result.nvim.installed) {
    const extra = result.nvim.autoInstalled ? ' (just installed)' : '';
    console.log(`  \u2713 Editor: nvim ${result.nvim.version}${extra}`);
    if (result.nvim.lazyVimInstalled) {
      console.log('  \u2713 LazyVim: Starter config installed to ~/.config/nvim/');
    }
    if (result.nvim.baleiaInstalled) {
      console.log('  \u2713 ANSI colors: baleia.nvim plugin configured (auto-detects escape codes)');
    }
  } else {
    console.log('  \u26a0 Editor: nvim not installed');
    if (process.platform === 'darwin') {
      console.log('    Install: brew install neovim');
    }
  }

  console.log('');
  console.log("Run 'sis ui guide' for a usage guide.");
  console.log('');
}

export function registerSetup(program: Command): void {
  program
    .command('setup')
    .description('One-time setup: install dependencies, daemon, keybindings, and commands')
    .option('--yes', 'Skip the y/N prompt before modifying ~/.tmux.conf')
    .option('--force', 'Override safety refusals: overwrite existing key bindings AND auto-append source-file to ~/.tmux.conf')
    .addHelpText(
      'after',
      `
setup: one-time installation of the sisyphus daemon, tmux keybindings, and dependencies.

Input
  --yes      optional boolean — skip the y/N confirmation before appending source-file to ~/.tmux.conf.
  --force    optional boolean — override safety refusals: overwrite conflicting key bindings
             AND auto-append the tmux source-file line to ~/.tmux.conf.

Output (stdout, plain text)
  Checklist of installed components with ✓ / ✗ / ⚠ status per item.

Effects
  Writes tmux keybinding scripts to ~/.sisyphus/.
  May append a source-file line to ~/.tmux.conf (prompts unless --yes/--force).
  Installs and starts the sisyphus daemon via launchd (macOS) or systemd/manual (Linux).
  Installs the sisyphus Claude Code plugin.
  May install tmux, nvim, and LazyVim if not present (with user confirmation).

Exit codes: 0 ok | 1 partial failure (keybind conflict or daemon start failure)`,
    )
    .action(async (opts: { yes?: boolean; force?: boolean }) => {
      // 1. Onboarding (tmux, terminal, iterm, nvim, plugin)
      const result = runOnboarding();

      // 2. Daemon
      let daemonOk = false;
      try {
        await ensureDaemonInstalled();
        daemonOk = true;
      } catch {
        daemonOk = isInstalled();
      }

      // 3. Keybindings — refuses without --force if it would conflict or modify the
      // user's tmux.conf. Surface the refusal clearly so the user knows to re-run.
      const keybindResult = await setupTmuxKeybind(
        DEFAULT_CYCLE_KEY,
        DEFAULT_PREFIX_KEY,
        { assumeYes: opts.yes, force: opts.force },
      );
      let keybindMsg: string;
      if (keybindResult.status === 'installed' || keybindResult.status === 'already-installed') {
        keybindMsg = `${DEFAULT_CYCLE_KEY} cycle, ${DEFAULT_PREFIX_KEY} prefix (h=dashboard, x=kill)`;
      } else if (keybindResult.status === 'requires-force' || keybindResult.status === 'conflict') {
        keybindMsg =
          `${keybindResult.message}\n` +
          `    Run "sis admin check check-keybinds" for the full decision tree, then re-run "sis admin install setup --force" to proceed.`;
        process.exitCode = 1;
      } else {
        keybindMsg = keybindResult.message;
      }

      printResults(result, daemonOk, keybindMsg);
    });
}
