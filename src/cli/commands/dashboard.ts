import type { Command } from 'commander';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { assertTmux, getTmuxSession } from '../tmux.js';
import { shellQuote } from '../../shared/shell.js';


/**
 * Opens the dashboard in a new tmux window (for background use, e.g. from `start`).
 *
 * Tracks the window by its tmux window ID stored in the @sisyphus_dashboard
 * session option — not by window name, which is fragile (renames, collisions).
 * The "; exit" suffix closes the window when the TUI exits.
 *
 * Returns true if a new dashboard was created, false if an existing one was focused.
 */
export function openDashboardWindow(tmuxSession: string, cwd: string): boolean {
  // Check for existing dashboard by stored window ID
  try {
    const storedId = execSync(
      `tmux show-option -t ${shellQuote(tmuxSession)} -v @sisyphus_dashboard`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    if (storedId) {
      try {
        execSync(
          `tmux display-message -t ${shellQuote(storedId)} -p "#{window_id}"`,
          { stdio: 'pipe' },
        );
        execSync(`tmux select-window -t ${shellQuote(storedId)}`, { stdio: 'pipe' });
        return false;
      } catch {
        // Window is gone — fall through to create a new one
      }
    }
  } catch {
    // Option not set — fall through to create
  }

  // Reconcile: the option may be unset or stale even though a dashboard window
  // is still alive in this session (option drift). Adopt an existing
  // "sisyphus-dashboard" window before creating a duplicate. Mirrors the shell
  // reconciliation in tmux-setup.ts's homeScript.
  try {
    const windows = execSync(
      `tmux list-windows -t ${shellQuote(tmuxSession)} -F "#{window_id} #{window_name}"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    for (const line of windows.split('\n').filter(Boolean)) {
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx < 0) continue;
      const wid = line.slice(0, spaceIdx);
      const wname = line.slice(spaceIdx + 1);
      if (wname === 'sisyphus-dashboard') {
        execSync(
          `tmux set-option -t ${shellQuote(tmuxSession)} @sisyphus_dashboard ${shellQuote(wid)}`,
          { stdio: 'pipe' },
        );
        execSync(`tmux select-window -t ${shellQuote(wid)}`, { stdio: 'pipe' });
        return false;
      }
    }
  } catch {
    // No windows / tmux unhappy — fall through to create
  }

  const tuiPath = join(import.meta.dirname, 'tui.js');

  const windowId = execSync(
    `tmux new-window -t ${shellQuote(tmuxSession + ':')} -n "sisyphus-dashboard" -c ${shellQuote(cwd)} -P -F "#{window_id}"`,
    { encoding: 'utf-8' },
  ).trim();

  const cmd = `node ${shellQuote(tuiPath)} --cwd ${shellQuote(cwd)}; exit`;
  execSync(
    `tmux send-keys -t ${shellQuote(windowId)} ${shellQuote(cmd)} Enter`,
  );

  execSync(
    `tmux set-option -t ${shellQuote(tmuxSession)} @sisyphus_dashboard ${shellQuote(windowId)}`,
    { stdio: 'pipe' },
  );

  return true;
}

function buildDashboardCommand(target: Command, hidden: boolean): void {
  target
    .command('dashboard', { hidden })
    .description('Launch the TUI dashboard for monitoring and managing sessions')
    .addHelpText(
      'after',
      `
dashboard: launch the interactive TUI for monitoring and managing sisyphus sessions.

Input
  (none)    Launches against the current working directory.

Output (TUI; human surface, not for agentic consumption — JSON-only contract does not apply)
  Full-screen terminal UI showing live session state, agent status, roadmap,
  cycle history, and interactive controls.

Effects
  Spawns the TUI process attached to the current terminal (stdio: inherit).
  The TUI process exits when the user quits (q).

Exit codes: 0 ok | 1 tmux not available`,
    )
    .action(async () => {
      assertTmux();
      const tuiPath = join(import.meta.dirname, 'tui.js');
      execSync(`node ${shellQuote(tuiPath)} --cwd ${shellQuote(process.cwd())}`, {
        stdio: 'inherit',
      });
    });
}

/**
 * Registers `<parent> dashboard` (canonical, e.g. `sis ui dashboard`) and,
 * when `root` is given, a hidden top-level `sis ui dashboard` alias.
 */
export function registerDashboard(parent: Command, root?: Command): void {
  buildDashboardCommand(parent, false);
  if (root) buildDashboardCommand(root, true);
}
