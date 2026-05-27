import type { Command } from 'commander';
import { execSync } from 'node:child_process';
import { assertTmux } from '../tmux.js';
import { shellQuote } from '../../shared/shell.js';
import { emitJsonOk } from '../output.js';

/**
 * Find the home session (non-ssyph_ session with matching @sisyphus_cwd).
 * Returns the tmux session name, or null if none found.
 *
 * Queries by $N session ID — tmux's -t <name> can substring-match the wrong
 * session under sparse env, and scratch may run from any shell context.
 */
function findHomeSession(cwd: string): string | null {
  const normalizedCwd = cwd.replace(/\/+$/, '');
  let output: string;
  try {
    output = execSync('tmux list-sessions -F "#{session_id}|#{session_name}"', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
  for (const line of output.split('\n').filter(Boolean)) {
    const pipeIdx = line.indexOf('|');
    if (pipeIdx < 0) continue;
    const sessId = line.slice(0, pipeIdx);
    const name = line.slice(pipeIdx + 1);
    if (name.startsWith('ssyph_')) continue;
    try {
      const val = execSync(
        `tmux show-options -t ${shellQuote(sessId)} -v @sisyphus_cwd`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      if (val === normalizedCwd) return name;
    } catch {
      // Option not set — skip
    }
  }
  return null;
}

export function registerScratch(program: Command): void {
  program
    .command('scratch [prompt...]')
    .description('Open a standalone Claude Code session in the home tmux session')
    .option('--cwd <path>', 'Working directory for the Claude session')
    .addHelpText('after', `
session scratch: open a standalone Claude Code window in the project's home tmux session.

Input
  [prompt...]     optional variadic — words joined into a single prompt string passed to Claude via -p
  --cwd <path>    optional — working directory for the Claude session; defaults to $SISYPHUS_CWD then process cwd

Output (stdout, JSON)
  { ok, data: { tmuxSession, windowId } }
  tmuxSession is the tmux session name; windowId is the tmux window ID (e.g. @42).
  on error: { ok: false, error: { code, message } }

Effects
  Creates a new tmux window named "scratch" in the home tmux session.
  Sends \`claude --dangerously-skip-permissions\` (with optional -p <prompt>) to the window.

Exit codes: 0 ok | 2 usage.`)
    .action((promptParts: string[], opts: { cwd?: string }) => {
      assertTmux();

      const cwd = opts.cwd ?? process.env['SISYPHUS_CWD'] ?? process.cwd();
      const homeSession = findHomeSession(cwd);

      if (!homeSession) {
        // Fall back to current tmux session
        const current = execSync('tmux display-message -p "#{session_name}"', {
          encoding: 'utf-8',
        }).trim();
        openScratchWindow(current, cwd, promptParts.join(' '));
        return;
      }

      openScratchWindow(homeSession, cwd, promptParts.join(' '));
    });
}

function openScratchWindow(tmuxSession: string, cwd: string, prompt: string): void {
  const windowId = execSync(
    `tmux new-window -t ${shellQuote(tmuxSession + ':')} -n "scratch" -c ${shellQuote(cwd)} -P -F "#{window_id}"`,
    { encoding: 'utf-8' },
  ).trim();

  let cmd = 'claude --dangerously-skip-permissions';
  if (prompt) {
    cmd += ` -p ${shellQuote(prompt)}`;
  }

  execSync(
    `tmux send-keys -t ${shellQuote(windowId)} ${shellQuote(cmd)} Enter`,
  );

  emitJsonOk({ tmuxSession, windowId });
}
