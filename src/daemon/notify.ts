import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { escapeAppleScript } from '../shared/shell.js';
import { detectPlatform, hasCommand } from '../shared/platform.js';

/**
 * Notification urgency.
 * - `urgent` (default): plays sound, banner; for crashes, asks, things needing real attention
 * - `info`: silent passive banner; for status updates the user only needs to acknowledge
 */
export type NotificationLevel = 'info' | 'urgent';

export interface NotificationOptions {
  title: string;
  message: string;
  /** tmux session name to switch to on click */
  tmuxSession?: string;
  level?: NotificationLevel;
}

const TMUX_SOCKET = `/tmp/tmux-${process.getuid?.() ?? 0}/default`;

/**
 * Click-to-switch helper. Used by macOS notifications today; the script is
 * portable so the same one works on Linux if a notification handler ever
 * invokes it. iTerm activation is gated by uname so it no-ops elsewhere.
 */
const SWITCH_SCRIPT = [
  '#!/bin/bash',
  'SESSION="$1"',
  `TMUX_SOCKET="${TMUX_SOCKET}"`,
  '',
  '# Find any attached client (user is likely on a different session)',
  'CLIENT_TTY=$(tmux -S "$TMUX_SOCKET" list-clients -F \'#{client_tty}\' 2>/dev/null | head -1)',
  '[ -z "$CLIENT_TTY" ] && exit 0',
  '',
  '# Switch that client to the target session',
  'tmux -S "$TMUX_SOCKET" switch-client -c "$CLIENT_TTY" -t "$SESSION" 2>/dev/null',
  'tmux -S "$TMUX_SOCKET" select-window -t "$SESSION" 2>/dev/null',
  '',
  '# macOS-only: bring iTerm2 to front and select the tab with this client',
  'if [ "$(uname -s)" = "Darwin" ] && command -v osascript >/dev/null 2>&1; then',
  '  TTY_SHORT=$(echo "$CLIENT_TTY" | sed \'s|/dev/||\')',
  '  osascript -e "',
  '    tell application \\"iTerm2\\"',
  '      activate',
  '      repeat with w in windows',
  '        tell w',
  '          repeat with t in tabs',
  '            tell t',
  '              repeat with s in sessions',
  '                tell s',
  '                  if tty contains \\"$TTY_SHORT\\" then',
  '                    select t',
  '                    return',
  '                  end if',
  '                end tell',
  '              end repeat',
  '            end tell',
  '          end repeat',
  '        end tell',
  '      end repeat',
  '    end tell',
  '  " 2>/dev/null || osascript -e \'tell application "iTerm2" to activate\' 2>/dev/null',
  'fi',
  '',
].join('\n');

function ensureSwitchScript(): void {
  const dir = join(homedir(), '.sisyphus');
  const scriptPath = join(dir, 'notify-switch.sh');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(scriptPath, SWITCH_SCRIPT, { mode: 0o755 });
  } catch {
    // Best effort
  }
}

// Long-lived SisyphusNotify.app process — accepts JSON lines on stdin
let notifyProcess: ChildProcess | null = null;

function getNotifyBinary(): string {
  return join(homedir(), '.sisyphus', 'SisyphusNotify.app', 'Contents', 'MacOS', 'sisyphus-notify');
}

function ensureNotifyProcess(): ChildProcess | null {
  if (notifyProcess && !notifyProcess.killed && notifyProcess.stdin?.writable) {
    return notifyProcess;
  }

  const binary = getNotifyBinary();
  if (!existsSync(binary)) {
    return null;
  }

  notifyProcess = spawn(binary, [], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  notifyProcess.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.error(`[sisyphus-notify] ${msg}`);
  });

  notifyProcess.on('close', () => {
    notifyProcess = null;
  });

  // Don't keep short-lived parents alive (CLI, tests). The daemon stays up
  // for other reasons; when it exits, the notify subprocess sees stdin EOF.
  notifyProcess.unref();
  // stdin/stderr are pipe-backed Socket streams that expose unref() at runtime,
  // but the Writable/Readable types don't declare it — cast through unknown.
  (notifyProcess.stdin as unknown as { unref(): void } | null)?.unref();
  (notifyProcess.stderr as unknown as { unref(): void } | null)?.unref();

  return notifyProcess;
}

function sendLinuxNotification(title: string, msg: string, level: NotificationLevel): boolean {
  if (!hasCommand('notify-send')) return false;
  const urgency = level === 'urgent' ? 'critical' : 'normal';
  // --app-name keeps the notification grouped under "Sisyphus" in the OS UI.
  execFile('notify-send', ['--app-name=Sisyphus', `--urgency=${urgency}`, title, msg], () => {});
  return true;
}

export function sendTerminalNotification(opts: NotificationOptions): void;
export function sendTerminalNotification(title: string, message: string, tmuxSession?: string, level?: NotificationLevel): void;
export function sendTerminalNotification(titleOrOpts: string | NotificationOptions, message?: string, tmuxSession?: string, level?: NotificationLevel): void {
  let title: string;
  let msg: string;
  let tmuxSess: string | undefined;
  let lvl: NotificationLevel;

  if (typeof titleOrOpts === 'object') {
    title = titleOrOpts.title;
    msg = titleOrOpts.message;
    tmuxSess = titleOrOpts.tmuxSession;
    lvl = titleOrOpts.level === undefined ? 'urgent' : titleOrOpts.level;
  } else {
    title = titleOrOpts;
    msg = message!;
    tmuxSess = tmuxSession;
    lvl = level === undefined ? 'urgent' : level;
  }

  // Ensure the switch script is in place
  if (tmuxSess) ensureSwitchScript();

  const platform = detectPlatform();

  if (platform === 'darwin') {
    // Try native SisyphusNotify.app (supports click-to-switch + level styling)
    const proc = ensureNotifyProcess();
    if (proc?.stdin?.writable) {
      const payload: Record<string, string> = { title, message: msg, level: lvl };
      if (tmuxSess) payload.tmuxSession = tmuxSess;
      proc.stdin.write(JSON.stringify(payload) + '\n');
      return;
    }

    // Fallback: terminal-notifier — sound only on urgent
    const tnArgs = ['-title', title, '-message', msg];
    if (lvl === 'urgent') tnArgs.push('-sound', 'default');
    execFile('terminal-notifier', tnArgs, (err) => {
      if (err) {
        // Last resort on macOS: osascript
        const soundClause = lvl === 'urgent' ? ' sound name "default"' : '';
        execFile('osascript', [
          '-e',
          `display notification "${escapeAppleScript(msg)}" with title "${escapeAppleScript(title)}"${soundClause}`,
        ], () => {});
      }
    });
    return;
  }

  // Linux + WSL: libnotify via notify-send. On WSL this surfaces through WSLg
  // (Windows 11+) or the user's X server. If unavailable we silently drop —
  // the daemon log still records the underlying event.
  if (platform === 'linux' || platform === 'wsl') {
    sendLinuxNotification(title, msg, lvl);
    return;
  }

  // Other platforms (win32, unknown): no-op.
}
