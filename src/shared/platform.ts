import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export type Platform = 'darwin' | 'linux' | 'wsl' | 'win32' | 'unknown';

let cachedPlatform: Platform | undefined;

/**
 * Detect the host platform, distinguishing WSL from native Linux.
 *
 * WSL detection: Microsoft injects "Microsoft"/"WSL" into /proc/version, and
 * WSL2 sets WSL_DISTRO_NAME. We check both so it works in minimal containers
 * where /proc/version may be unreadable but env is preserved.
 */
export function detectPlatform(): Platform {
  if (cachedPlatform) return cachedPlatform;

  if (process.platform === 'darwin') {
    cachedPlatform = 'darwin';
  } else if (process.platform === 'win32') {
    cachedPlatform = 'win32';
  } else if (process.platform === 'linux') {
    cachedPlatform = isWsl() ? 'wsl' : 'linux';
  } else {
    cachedPlatform = 'unknown';
  }
  return cachedPlatform;
}

function isWsl(): boolean {
  if (process.env['WSL_DISTRO_NAME'] || process.env['WSL_INTEROP']) return true;
  try {
    if (existsSync('/proc/version')) {
      const v = readFileSync('/proc/version', 'utf-8').toLowerCase();
      if (v.includes('microsoft') || v.includes('wsl')) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/** True if the platform supports the macOS-only Swift notify app, pbcopy, launchd, etc. */
export function isDarwin(): boolean { return detectPlatform() === 'darwin'; }

/** True if running under WSL (any version). Use this for WSL-specific tool selection. */
export function isWslHost(): boolean { return detectPlatform() === 'wsl'; }

/** True for native or WSL Linux — both share apt/dnf/notify-send/xdg-open ecosystems. */
export function isLinuxLike(): boolean {
  const p = detectPlatform();
  return p === 'linux' || p === 'wsl';
}

/**
 * True if a given command is on PATH. Uses `command -v` (POSIX) so it works in
 * subshells with the same PATH the daemon/CLI sees. Cached per-process.
 */
const cmdCache = new Map<string, boolean>();
export function hasCommand(cmd: string): boolean {
  const cached = cmdCache.get(cmd);
  if (cached !== undefined) return cached;
  try {
    execSync(`command -v ${cmd}`, { stdio: 'pipe', shell: '/bin/sh' });
    cmdCache.set(cmd, true);
    return true;
  } catch {
    cmdCache.set(cmd, false);
    return false;
  }
}

const TERMINAL_APP_NAMES: ReadonlySet<string> = new Set([
  'iterm2', 'iterm', 'terminal', 'apple_terminal',
  'alacritty', 'kitty', 'wezterm', 'ghostty', 'hyper', 'warp', 'tmux',
]);

/**
 * Best-effort check: returns true if a known terminal emulator is the frontmost
 * macOS application. Non-darwin or any error → false ("don't suppress / keep banner").
 * Never throws.
 */
export function isTerminalFrontmost(): boolean {
  if (detectPlatform() !== 'darwin') return false;
  try {
    const raw = execFileSync(
      'osascript',
      ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
      { timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const name = raw.toString().trim().toLowerCase();
    return TERMINAL_APP_NAMES.has(name);
  } catch {
    return false;
  }
}

/** Human-readable platform label, e.g. for `sis admin check doctor`. */
export function platformLabel(): string {
  switch (detectPlatform()) {
    case 'darwin': return 'macOS';
    case 'wsl': {
      const distro = process.env['WSL_DISTRO_NAME'];
      return distro ? `WSL (${distro})` : 'WSL';
    }
    case 'linux': return 'Linux';
    case 'win32': return 'Windows (native)';
    default: return 'unknown';
  }
}
