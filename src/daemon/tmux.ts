import { execSync } from 'node:child_process';
import { shellQuote } from '../shared/shell.js';
import { exec as rawExec, execSafe as rawExecSafe, EXEC_ENV } from '../shared/exec.js';
export { EXEC_ENV } from '../shared/exec.js';

// Escape tmux -t targets for shell. Session IDs like $34 contain $ which
// gets expanded by /bin/sh when passed through execSync. shellQuote wraps
// in single quotes, preventing all expansion.
const t = (target: string): string => shellQuote(target);

// Local tmux IPC should return in well under a second. Cap to 5s so a wedged
// tmux server (lock contention, blocked command queue) fails fast instead of
// blocking the daemon for the 30s default. See 2026-04-08 incident.
const TMUX_TIMEOUT_MS = 5_000;

// All tmux IPC goes through these wrappers so every call inherits the 5s cap.
// Calling the shared exec/execSafe helpers directly is a footgun: execSafe with
// no timeout waits forever, so a wedged tmux server would block the daemon's
// event loop indefinitely instead of failing fast.
const texec = (cmd: string, cwd?: string, timeoutMs: number = TMUX_TIMEOUT_MS): string =>
  rawExec(cmd, cwd, timeoutMs);
const texecSafe = (cmd: string, cwd?: string, timeoutMs: number = TMUX_TIMEOUT_MS): string | null =>
  rawExecSafe(cmd, cwd, timeoutMs);

export class PaneUnavailableError extends Error {
  constructor(public paneTarget: string, public state: PaneState) {
    super(`pane ${paneTarget} unavailable (exists=${state.exists}, dead=${state.dead}, inMode=${state.inMode})`);
    this.name = 'PaneUnavailableError';
  }
}

export interface PaneState {
  exists: boolean;
  dead: boolean;
  inMode: boolean;
}

/**
 * Pure decision logic for sendKeys preflight. Tested independently of tmux.
 *
 * - dead/missing pane → 'abort' (caller should throw, not block on send-keys)
 * - pane in copy/clock mode → 'cancel-then-send' (without -X cancel first,
 *   our keys would route through the copy-mode key table instead of the shell)
 * - normal pane → 'send'
 */
export function planSendKeys(state: PaneState): { action: 'send' | 'cancel-then-send' | 'abort' } {
  if (!state.exists || state.dead) return { action: 'abort' };
  if (state.inMode) return { action: 'cancel-then-send' };
  return { action: 'send' };
}

/**
 * Read pane state in a single tmux call. Returns exists=false if the pane is
 * gone. Uses execSafe with a tight timeout so a wedged tmux server can't block
 * us indefinitely.
 */
export function getPaneState(paneTarget: string): PaneState {
  const out = texecSafe(`tmux display-message -t ${t(paneTarget)} -p '#{pane_dead} #{pane_in_mode}'`, undefined, TMUX_TIMEOUT_MS);
  if (out === null) return { exists: false, dead: false, inMode: false };
  const [deadStr, modeStr] = out.split(' ');
  return { exists: true, dead: deadStr === '1', inMode: modeStr === '1' };
}

export function createPane(windowTarget: string, cwd?: string, position: 'left' | 'right' = 'right'): string {
  const cwdFlag = cwd ? ` -c ${shellQuote(cwd)}` : '';
  // Target the first/last pane in the window to ensure absolute left/right placement
  const panes = listPanes(windowTarget);
  const target = position === 'left' ? panes[0]?.paneId : panes[panes.length - 1]?.paneId;
  const targetFlag = target ? ` -t ${t(target)}` : ` -t ${t(windowTarget)}`;
  const beforeFlag = position === 'left' ? 'b' : '';
  const paneId = texec(`tmux split-window -h${beforeFlag}${targetFlag}${cwdFlag} -P -F "#{pane_id}"`);
  texecSafe(`tmux select-layout -t ${t(windowTarget)} even-horizontal`);
  return paneId;
}

export function sendKeys(paneTarget: string, command: string): void {
  const state = getPaneState(paneTarget);
  const { action } = planSendKeys(state);
  if (action === 'abort') throw new PaneUnavailableError(paneTarget, state);
  if (action === 'cancel-then-send') {
    // Drop out of copy/clock-mode so the keys actually reach the underlying
    // shell instead of being interpreted by the copy-mode key table.
    texecSafe(`tmux send-keys -t ${t(paneTarget)} -X cancel`, undefined, TMUX_TIMEOUT_MS);
  }
  texec(`tmux send-keys -t ${t(paneTarget)} ${shellQuote(command)} Enter`, undefined, TMUX_TIMEOUT_MS);
}

/**
 * Type arbitrary text into a pane via tmux paste-buffer so multi-line input is
 * preserved as a single bracketed paste (Claude treats it as one user turn).
 * Optionally presses Enter to submit. Same preflight as `sendKeys`.
 *
 * Uses a named, randomized buffer + `-d` (delete after paste) so the user's
 * default `0` paste-buffer is left alone.
 */
export function pasteToPane(paneTarget: string, text: string, submit: boolean): void {
  const state = getPaneState(paneTarget);
  const { action } = planSendKeys(state);
  if (action === 'abort') throw new PaneUnavailableError(paneTarget, state);
  if (action === 'cancel-then-send') {
    texecSafe(`tmux send-keys -t ${t(paneTarget)} -X cancel`, undefined, TMUX_TIMEOUT_MS);
  }
  const bufName = `sisyphus-tell-${Math.random().toString(36).slice(2, 10)}`;
  // load-buffer reads from stdin via `-`; pipe text in directly so newlines/quotes are preserved
  // verbatim (no shell escaping). Calls execSync directly (not the texec wrappers) since it pipes stdin.
  execSync(`tmux load-buffer -b ${shellQuote(bufName)} -`, {
    input: text,
    env: EXEC_ENV,
    timeout: TMUX_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    texec(`tmux paste-buffer -t ${t(paneTarget)} -b ${shellQuote(bufName)} -d`, undefined, TMUX_TIMEOUT_MS);
  } catch (err) {
    // Best-effort cleanup if paste-buffer failed before -d kicked in.
    texecSafe(`tmux delete-buffer -b ${shellQuote(bufName)}`);
    throw err;
  }
  if (submit) {
    texec(`tmux send-keys -t ${t(paneTarget)} Enter`, undefined, TMUX_TIMEOUT_MS);
  }
}

export function killPane(paneTarget: string): void {
  texecSafe(`tmux kill-pane -t ${t(paneTarget)}`);
}

export function killWindow(windowTarget: string): void {
  texecSafe(`tmux kill-window -t ${t(windowTarget)}`);
}

export function createSession(sessionName: string, cwd: string): { windowId: string; initialPaneId: string; sessionId: string } {
  const sessionId = texec(`tmux new-session -d -s ${t(sessionName)} -n main -c ${shellQuote(cwd)} -P -F "#{session_id}"`);
  const windowId = texec(`tmux display-message -t ${t(sessionId + ':main')} -p "#{window_id}"`);
  const initialPaneId = texec(`tmux display-message -t ${t(sessionId + ':main')} -p "#{pane_id}"`);
  configureSessionDefaults(sessionId, windowId);
  return { windowId, initialPaneId, sessionId };
}

export function paneExists(paneTarget: string): boolean {
  return texecSafe(`tmux display-message -t ${t(paneTarget)} -p "#{pane_id}"`) !== null;
}

export function getPanePid(paneTarget: string): number | null {
  const out = texecSafe(`tmux display-message -t ${t(paneTarget)} -p "#{pane_pid}"`, undefined, TMUX_TIMEOUT_MS);
  if (!out) return null;
  const pid = parseInt(out.trim(), 10);
  return Number.isFinite(pid) ? pid : null;
}

/**
 * Check if a tmux session exists by its $N ID. Safe for all operations —
 * $N IDs use exact integer matching (no prefix-match risk).
 */
export function sessionExistsById(tmuxSessionId: string): boolean {
  return texecSafe(`tmux has-session -t ${t(tmuxSessionId)}`) !== null;
}

/**
 * Check if a session name is already taken. Uses exact name matching.
 * Only needed for collision detection at creation/rename — prefer
 * sessionExistsById() for all other existence checks.
 */
export function sessionNameTaken(sessionName: string): boolean {
  const output = texecSafe('tmux list-sessions -F "#{session_name}"');
  if (!output) return false;
  return output.split('\n').some(line => line === sessionName);
}

/**
 * Re-capture a tmux $N session ID from a known session name.
 * Used for recovery after tmux server restart when stored $N is stale.
 */
export function resolveSessionId(sessionName: string): string | null {
  // Use list-sessions with exact match filter rather than display-message,
  // which may fail without an attached client in daemon context.
  const output = texecSafe('tmux list-sessions -F "#{session_id} #{session_name}"');
  if (!output) return null;
  for (const line of output.split('\n').filter(Boolean)) {
    const { sessionId, name } = parseSessionLine(line);
    if (name === sessionName) return sessionId;
  }
  return null;
}

/**
 * Check if a tmux session is alive, preferring $N ID when available.
 * Encapsulates the $N-vs-name dispatch so callers don't need to know about tmux ID formats.
 */
export function isSessionAlive(tmuxSessionId: string | undefined, tmuxSessionName: string | undefined): boolean {
  if (tmuxSessionId) return sessionExistsById(tmuxSessionId);
  if (tmuxSessionName) return sessionNameTaken(tmuxSessionName);
  return false;
}

/**
 * Set standard sisyphus metadata on a newly created tmux session.
 */
export function initSessionMeta(tmuxTarget: string, cwd: string, sisyphusSessionId: string): void {
  setSessionOption(tmuxTarget, '@sisyphus_cwd', cwd.replace(/\/+$/, ''));
  setSessionOption(tmuxTarget, '@sisyphus_session_id', sisyphusSessionId);
}

export function killSession(target: string): void {
  texecSafe(`tmux kill-session -t ${t(target)}`);
}

export function renameSession(target: string, newName: string): void {
  texec(`tmux rename-session -t ${t(target)} ${t(newName)}`);
}

export function setSessionOption(target: string, option: string, value: string): void {
  texecSafe(`tmux set-option -t ${t(target)} ${option} ${shellQuote(value)}`);
}

export function unsetSessionOption(target: string, option: string): void {
  texecSafe(`tmux set-option -u -t ${t(target)} ${option}`);
}

function parseSessionLine(line: string): { sessionId: string; name: string } {
  const spaceIdx = line.indexOf(' ');
  return { sessionId: line.slice(0, spaceIdx), name: line.slice(spaceIdx + 1) };
}

export function findHomeSession(cwd: string): string | null {
  const output = texecSafe('tmux list-sessions -F "#{session_id} #{session_name}"');
  if (!output) return null;
  const normalizedCwd = cwd.replace(/\/+$/, '');
  for (const line of output.split('\n').filter(Boolean)) {
    const { sessionId: sessId, name } = parseSessionLine(line);
    if (name.startsWith('ssyph_')) continue;
    const val = texecSafe(`tmux show-options -t ${t(sessId)} -v @sisyphus_cwd`);
    if (val?.trim() === normalizedCwd) return sessId;
  }
  return null;
}

export function switchAttachedClients(sourceTarget: string, destTarget: string): void {
  if (texecSafe(`tmux has-session -t ${t(destTarget)}`) === null) return;
  const output = texecSafe(`tmux list-clients -t ${t(sourceTarget)} -F "#{client_tty}"`);
  if (!output) return;
  for (const tty of output.split('\n').filter(Boolean)) {
    texecSafe(`tmux switch-client -c ${t(tty)} -t ${t(destTarget)}`);
  }
}


export interface PaneInfo {
  paneId: string;
  panePid: string;
}

export function getFirstWindowId(sessionTarget: string): string | null {
  return texecSafe(`tmux list-windows -t ${t(sessionTarget)} -F "#{window_id}" -f "#{==:#{window_index},0}"`)?.trim() || null;
}

export function listPanes(windowTarget: string): PaneInfo[] {
  const output = texecSafe(`tmux list-panes -t ${t(windowTarget)} -F "#{pane_id} #{pane_pid}"`, undefined, TMUX_TIMEOUT_MS);
  if (!output) return [];
  return output
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [paneId, panePid] = line.split(' ');
      return { paneId: paneId!, panePid: panePid! };
    });
}

/**
 * Single-subprocess snapshot of every pane across every tmux session, grouped
 * by window id. Replaces N per-window `listPanes` calls when the caller needs
 * pane state for many windows in the same tick — the pane monitor uses this
 * to fan out poll work without spawning a tmux child per session.
 */
export function listAllPanesByWindow(): Map<string, PaneInfo[]> {
  const output = texecSafe('tmux list-panes -a -F "#{window_id} #{pane_id} #{pane_pid}"', undefined, TMUX_TIMEOUT_MS);
  const map = new Map<string, PaneInfo[]>();
  if (!output) return map;
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [windowId, paneId, panePid] = line.split(' ');
    if (!windowId || !paneId || !panePid) continue;
    const bucket = map.get(windowId);
    if (bucket) bucket.push({ paneId, panePid });
    else map.set(windowId, [{ paneId, panePid }]);
  }
  return map;
}

export function setPaneTitle(paneTarget: string, title: string): void {
  texecSafe(`tmux select-pane -t ${t(paneTarget)} -T ${shellQuote(title)}`);
}

export interface PaneMeta {
  role: string;      // "orch" or agent paneLabel (e.g. "impl", "review-plan")
  session: string;   // session name or truncated UUID
  cycle: string;     // e.g. "c3"
  mode?: string;     // orchestrator mode (e.g. "discovery", "implementation")
}

export function setPaneStyle(paneTarget: string, color: string, meta: PaneMeta): void {
  const gitBranch = `#(cd #{pane_current_path} && git branch --show-current 2>/dev/null)`;
  const branchSuffix = `#(cd #{pane_current_path} && git branch --show-current 2>/dev/null | grep -q . && echo ' |') ${gitBranch}`;
  const homePath = `#(echo '#{pane_current_path}' | sed "s|^$HOME|~|")`;

  // Store structured metadata as per-pane user variables so the format string
  // resolves them independently per pane (one format, per-pane values).
  texecSafe(`tmux set -p -t ${t(paneTarget)} @pane_role ${shellQuote(meta.role)}`);
  texecSafe(`tmux set -p -t ${t(paneTarget)} @pane_session ${shellQuote(meta.session)}`);
  texecSafe(`tmux set -p -t ${t(paneTarget)} @pane_cycle ${shellQuote(meta.cycle)}`);
  if (meta.mode) {
    texecSafe(`tmux set -p -t ${t(paneTarget)} @pane_mode ${shellQuote(meta.mode)}`);
  }

  // Visual hierarchy: role badge (bg color) > session name (fg color) > mode (italic) > cycle + path (dim)
  // Mode only renders for orchestrator panes (where @pane_mode is set).
  const modeSegment = `#{?#{@pane_mode}, #[fg=${color}\\,italics]#{@pane_mode}#[default],}`;
  const fmt = [
    `#[bg=${color},fg=black,bold] #{@pane_role} #[default]`,
    ` #[fg=${color},bold]#{@pane_session}`,
    modeSegment,
    ` #[default,dim]#{@pane_cycle}`,
    `  ${homePath}${branchSuffix}`,
    `#[default]`,
  ].join('');

  texecSafe(`tmux set -p -t ${t(paneTarget)} pane-border-format ${shellQuote(fmt)}`);
}

/**
 * Update pane metadata variables without rebuilding the full style.
 * Used by auto-naming to update session name across all live panes.
 */
export function updatePaneMeta(paneTarget: string, updates: Partial<PaneMeta>): void {
  if (updates.role !== undefined) texecSafe(`tmux set -p -t ${t(paneTarget)} @pane_role ${shellQuote(updates.role)}`);
  if (updates.session !== undefined) texecSafe(`tmux set -p -t ${t(paneTarget)} @pane_session ${shellQuote(updates.session)}`);
  if (updates.cycle !== undefined) texecSafe(`tmux set -p -t ${t(paneTarget)} @pane_cycle ${shellQuote(updates.cycle)}`);
  if (updates.mode !== undefined) texecSafe(`tmux set -p -t ${t(paneTarget)} @pane_mode ${shellQuote(updates.mode)}`);
}

export function selectLayout(windowTarget: string, layout: string = 'even-horizontal'): void {
  texecSafe(`tmux select-layout -t ${t(windowTarget)} ${layout}`);
}

export function setWindowOption(windowTarget: string, option: string, value: string): void {
  texecSafe(`tmux set-option -w -t ${t(windowTarget)} ${option} ${shellQuote(value)}`);
}

export function getSessionOption(target: string, option: string): string | null {
  return texecSafe(`tmux show-options -t ${t(target)} -v ${option}`);
}

export function getGlobalOption(option: string): string | null {
  try {
    return texecSafe(`tmux show-option -gv ${option}`)?.trim() || null;
  } catch {
    return null;
  }
}

export function setGlobalOption(option: string, value: string): void {
  texecSafe(`tmux set-option -g ${option} ${shellQuote(value)}`);
}

export function listAllSessions(): Array<{ name: string; sessionId: string }> {
  const output = texecSafe('tmux list-sessions -F "#{session_id} #{session_name}"');
  if (!output) return [];
  return output.split('\n').filter(Boolean).map(parseSessionLine);
}

export function listWindows(sessionTarget: string): Array<{ index: number; id: string; name: string }> {
  const output = texecSafe(`tmux list-windows -t ${t(sessionTarget)} -F '#{window_index}\t#{window_id}\t#{window_name}'`);
  if (!output) return [];
  return output.split('\n').filter(Boolean).map(line => {
    const [indexStr, id, ...nameParts] = line.split('\t');
    return { index: parseInt(indexStr!, 10), id: id!, name: nameParts.join('\t') };
  });
}

export function listWindowPanes(windowTarget: string): Array<{ paneId: string }> {
  const output = texecSafe(`tmux list-panes -t ${t(windowTarget)} -F '#{pane_id}'`);
  if (!output) return [];
  return output.split('\n').filter(Boolean).map(paneId => ({ paneId }));
}

export function listAllPanes(): Array<{ sessionName: string; paneId: string }> {
  const output = texecSafe('tmux list-panes -a -F "#{session_name} #{pane_id}"');
  if (!output) return [];
  return output.split('\n').filter(Boolean).map(line => {
    const spaceIdx = line.indexOf(' ');
    return { sessionName: line.slice(0, spaceIdx), paneId: line.slice(spaceIdx + 1) };
  });
}

/**
 * Single-subprocess snapshot of every window across every tmux session, grouped
 * by session name. Replaces N per-session `tmux list-windows` spawns in the
 * compositor's render path (one tmux child per session per status-bar render).
 */
export function listAllWindowsBySession(): Map<string, Array<{ index: number; id: string; name: string }>> {
  const output = texecSafe('tmux list-windows -a -F "#{session_name}\t#{window_index}\t#{window_id}\t#{window_name}"', undefined, TMUX_TIMEOUT_MS);
  const map = new Map<string, Array<{ index: number; id: string; name: string }>>();
  if (!output) return map;
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [sessionName, indexStr, id, ...nameParts] = line.split('\t');
    if (!sessionName || indexStr == null || !id) continue;
    const index = parseInt(indexStr, 10);
    if (!Number.isFinite(index)) continue;
    const name = nameParts.join('\t');
    const bucket = map.get(sessionName);
    if (bucket) bucket.push({ index, id, name });
    else map.set(sessionName, [{ index, id, name }]);
  }
  return map;
}

/**
 * Sets window/session-level tmux options that Sisyphus depends on.
 * Without these, pane labels won't show and titles may get clobbered.
 */
function configureSessionDefaults(sessionTarget: string, windowId: string): void {
  // Pane border labels at top of each pane
  texecSafe(`tmux set -w -t ${t(windowId)} pane-border-status top`);
  // Prevent tmux from overwriting pane/window titles we set
  texecSafe(`tmux set -w -t ${t(windowId)} allow-rename off`);
  texecSafe(`tmux set -w -t ${t(windowId)} automatic-rename off`);
  // Re-tile when a pane dies so remaining panes fill the space.
  // sessionTarget should be a $N id — tmux -t <name> can substring-match under sparse env.
  texecSafe(`tmux set-hook -t ${t(sessionTarget)} after-kill-pane "select-layout even-horizontal"`);
  texecSafe(`tmux set-hook -t ${t(sessionTarget)} pane-exited "select-layout even-horizontal"`);
}

