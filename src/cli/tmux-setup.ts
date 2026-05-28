import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { globalDir } from '../shared/paths.js';
import { KEYMAP, formatHelpForKeymap, type MenuDef, type MenuItem, type Action } from '../shared/keymap.js';
import { ensureSisyphusInitLua } from '../shared/sisyphus-init-lua.js';

export const DEFAULT_CYCLE_KEY = 'M-s';
// Reverse cycle (Alt+Shift+S) — same script, "prev" direction arg.
export const DEFAULT_CYCLE_BACK_KEY = 'M-S';
export const DEFAULT_PREFIX_KEY = 'C-s';
export const KEY_TABLE = 'sisyphus';

const SISYPHUS_CONF_MARKER = '# sisyphus-managed — do not edit';

function scriptPath(name: string): string {
  return join(globalDir(), 'bin', name);
}

export function cycleScriptPath(): string {
  return scriptPath('sisyphus-cycle');
}

export function homeScriptPath(): string {
  return scriptPath('sisyphus-home');
}

export function killPaneScriptPath(): string {
  return scriptPath('sisyphus-kill-pane');
}

export function newPromptScriptPath(): string {
  return scriptPath('sisyphus-new');
}

export function messageScriptPath(): string {
  return scriptPath('sisyphus-msg');
}

export function deleteSessionScriptPath(): string {
  return scriptPath('sisyphus-delete-session');
}

export function killSessionScriptPath(): string {
  return scriptPath('sisyphus-kill-session');
}

export function helpScriptPath(): string {
  return scriptPath('sisyphus-help');
}

export function statusPopupScriptPath(): string {
  return scriptPath('sisyphus-status-popup');
}

export function pickSessionScriptPath(): string {
  return scriptPath('sisyphus-pick-session');
}

export function continueSessionScriptPath(): string {
  return scriptPath('sisyphus-continue-session');
}

export function restartAgentScriptPath(): string {
  return scriptPath('sisyphus-restart-agent-popup');
}

export function exportSessionScriptPath(): string {
  return scriptPath('sisyphus-export-session');
}

export function openRoadmapScriptPath(): string {
  return scriptPath('sisyphus-open-roadmap');
}

export function openStrategyScriptPath(): string {
  return scriptPath('sisyphus-open-strategy');
}

export function keymapJsonPath(): string {
  return join(globalDir(), 'keymap.json');
}

export function writeKeymapJson(): void {
  mkdirSync(globalDir(), { recursive: true });
  writeFileSync(keymapJsonPath(), JSON.stringify(KEYMAP, null, 2), 'utf8');
}

export function tmuxVersionAtLeast(major: number, minor: number): boolean {
  try {
    const out = execSync('tmux -V', { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    const match = out.match(/tmux\s+(\d+)\.(\d+)/);
    if (!match) return false;
    const v = parseInt(match[1], 10) * 1000 + parseInt(match[2], 10);
    return v >= major * 1000 + minor;
  } catch {
    return false;
  }
}

function menuItemCommand(action: Action, scriptsDir: string): string | null {
  switch (action.type) {
    case 'script':
      return `run-shell ${join(scriptsDir, action.name)}`;
    case 'popup': {
      const { w, h, borderStyle, title, cwd } = action.popup;
      let args = '-E';
      if (w) args += ` -w ${w}`;
      if (h) args += ` -h ${h}`;
      if (borderStyle) args += ` -S '${borderStyle}'`;
      if (title) args += ` -T '${title}'`;
      if (cwd === 'current') args += ` -d '#{pane_current_path}'`;
      return `display-popup ${args} ${join(scriptsDir, action.name)}`;
    }
    case 'submenu':
      return `run-shell ${join(scriptsDir, `sisyphus-menu-${action.ref}`)}`;
    case 'tmux':
      return action.cmd;
    case 'tui':
      return null;
  }
}

export function generateMenuLine(item: MenuItem, scriptsDir: string): string {
  const cmd = menuItemCommand(item.action, scriptsDir);
  if (cmd === null) return '';
  const label = item.label.replace(/"/g, '\\"');
  return `"${label}" ${item.key} "${cmd}"`;
}

export function generateSubmenuScript(submenuId: string, def: MenuDef, scriptsDir: string): string {
  const lines = def.items
    .map(item => generateMenuLine(item, scriptsDir))
    .filter(l => l !== '');
  const args = lines.join(' \\\n  ');
  return `#!/bin/bash
exec tmux display-menu -T '${def.title}' -x R -y S \\
  ${args}
`;
}

export function generateTopLevelBinding(prefixKey: string, def: MenuDef, scriptsDir: string): string {
  const args = def.items
    .map(item => generateMenuLine(item, scriptsDir))
    .filter(l => l !== '')
    .join(' ');
  return `bind-key -T root ${prefixKey} display-menu -T '${def.title}' -x R -y S ${args}`;
}

export function sisyphusTmuxConfPath(): string {
  return join(globalDir(), 'tmux.conf');
}

export function userTmuxConfPath(): string | null {
  const dotfile = join(homedir(), '.tmux.conf');
  const xdg = join(homedir(), '.config', 'tmux', 'tmux.conf');
  if (existsSync(xdg)) return xdg;
  if (existsSync(dotfile)) return dotfile;
  return null;
}

// Cross-platform helpers used by other embedded scripts. Installed alongside
// them in ~/.sisyphus/bin/ — the other scripts invoke these by absolute path.
const SISYPHUS_CLIP_SCRIPT = `#!/bin/bash
# Cross-platform clipboard wrapper.
#   sisyphus-clip            # read stdin, write to clipboard
#   sisyphus-clip copy       # same as default
#   sisyphus-clip paste      # write clipboard contents to stdout

mode="\${1:-copy}"
uname_s="$(uname -s 2>/dev/null || echo unknown)"

is_wsl=0
if [ "$uname_s" = "Linux" ]; then
  if [ -n "\${WSL_DISTRO_NAME:-}\${WSL_INTEROP:-}" ]; then is_wsl=1; fi
  if [ -r /proc/version ] && grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then is_wsl=1; fi
fi

case "$mode" in
  copy)
    if [ "$uname_s" = "Darwin" ]; then
      exec pbcopy
    elif [ "$is_wsl" = "1" ] && command -v clip.exe >/dev/null 2>&1; then
      exec clip.exe
    elif [ -n "\${WAYLAND_DISPLAY:-}" ] && command -v wl-copy >/dev/null 2>&1; then
      exec wl-copy
    elif command -v xclip >/dev/null 2>&1; then
      exec xclip -selection clipboard
    elif command -v xsel >/dev/null 2>&1; then
      exec xsel --clipboard --input
    else
      echo "sisyphus-clip: no clipboard backend (install xclip / wl-clipboard / clip.exe)" >&2
      exit 1
    fi
    ;;
  paste)
    if [ "$uname_s" = "Darwin" ]; then
      exec pbpaste
    elif [ "$is_wsl" = "1" ] && command -v powershell.exe >/dev/null 2>&1; then
      # Get-Clipboard appends \\r\\n; strip the trailing CR.
      powershell.exe -NoProfile -Command Get-Clipboard | sed 's/\\r$//'
      exit "\${PIPESTATUS[0]:-0}"
    elif [ -n "\${WAYLAND_DISPLAY:-}" ] && command -v wl-paste >/dev/null 2>&1; then
      exec wl-paste --no-newline
    elif command -v xclip >/dev/null 2>&1; then
      exec xclip -selection clipboard -o
    elif command -v xsel >/dev/null 2>&1; then
      exec xsel --clipboard --output
    else
      echo "sisyphus-clip: no clipboard backend (install xclip / wl-clipboard / powershell.exe)" >&2
      exit 1
    fi
    ;;
  *)
    echo "Usage: sisyphus-clip [copy|paste]" >&2
    exit 2
    ;;
esac
`;

const SISYPHUS_OPEN_SCRIPT = `#!/bin/bash
# Cross-platform "open path in default file manager / handler".
#   sisyphus-open <path>

if [ $# -lt 1 ]; then
  echo "Usage: sisyphus-open <path>" >&2
  exit 2
fi
target="$1"

uname_s="$(uname -s 2>/dev/null || echo unknown)"
is_wsl=0
if [ "$uname_s" = "Linux" ]; then
  if [ -n "\${WSL_DISTRO_NAME:-}\${WSL_INTEROP:-}" ]; then is_wsl=1; fi
  if [ -r /proc/version ] && grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then is_wsl=1; fi
fi

if [ "$uname_s" = "Darwin" ]; then
  exec open "$target"
elif [ "$is_wsl" = "1" ] && command -v explorer.exe >/dev/null 2>&1; then
  win="$target"
  if command -v wslpath >/dev/null 2>&1; then
    win=$(wslpath -w "$target" 2>/dev/null || echo "$target")
  fi
  # explorer.exe returns 1 even on success when launching a new window — ignore.
  explorer.exe "$win" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then
  exec xdg-open "$target"
else
  echo "sisyphus-open: no opener available (install xdg-utils on Linux)" >&2
  exit 1
fi
`;

const CLIP_BIN = '$HOME/.sisyphus/bin/sisyphus-clip';
const OPEN_BIN = '$HOME/.sisyphus/bin/sisyphus-open';

const CYCLE_SCRIPT = `#!/bin/bash
# Target by $N session ID (column 5 in TSV) — tmux -t <name> can substring-match
# the wrong session under sparse env.
# Arg $1: "prev" cycles backward (M-S); anything else cycles forward (M-s).
dir="\${1:-next}"
MANIFEST="$HOME/.sisyphus/sessions-manifest.tsv"
if [ ! -f "$MANIFEST" ]; then
  tmux display-message "sisyphus: no manifest — daemon running?"
  exit 0
fi
current_id=$(tmux display-message -p '#{session_id}')
current_name=$(tmux display-message -p '#{session_name}')
cwd=""
while IFS=$'\\t' read -r type name scwd phase sid; do
  [ "$sid" = "$current_id" ] && { cwd="$scwd"; break; }
done < "$MANIFEST"
if [ -z "$cwd" ]; then
  tmux display-message "sisyphus: '$current_name' has no @sisyphus_cwd — run 'sis session lifecycle start' here to register"
  exit 0
fi
session_ids=()
while IFS=$'\\t' read -r type name scwd phase sid; do
  [[ "$type" == "#"* ]] && continue
  [ "$scwd" = "$cwd" ] && session_ids+=("$sid")
done < "$MANIFEST"
if (( \${#session_ids[@]} <= 1 )); then
  tmux display-message "sisyphus: only one session in $cwd — nothing to cycle to"
  exit 0
fi
for (( i=0; i<\${#session_ids[@]}; i++ )); do
  if [ "\${session_ids[$i]}" = "$current_id" ]; then
    if [ "$dir" = "prev" ]; then
      next=$(( (i - 1 + \${#session_ids[@]}) % \${#session_ids[@]} ))
    else
      next=$(( (i + 1) % \${#session_ids[@]} ))
    fi
    tmux switch-client -t "\${session_ids[$next]}"
    exit 0
  fi
done
tmux switch-client -t "\${session_ids[0]}"
`;

// Live tmux query for the home session + its dashboard window ID.
// Sets HOME_SESSION and HOME_DWID. Returns 0 on success, 1 if no home found.
// Optional arg: explicit cwd to look up. If omitted, uses @sisyphus_cwd from
// the current tmux session, falling back to #{pane_current_path}.
// Sets HOME_SESSION (tmux $N id) and HOME_DWID for the non-ssyph_ session
// matching the given cwd. Always targets by $N — tmux -t <name> can
// substring-match under sparse env.
const RESOLVE_HOME = `
HOME_SESSION=""
HOME_DWID=""
resolve_home() {
  local target_cwd="$1"
  local current_id sid sname scwd
  if [ -z "$target_cwd" ]; then
    current_id=$(tmux display-message -p '#{session_id}')
    target_cwd=$(tmux show-options -t "$current_id" -v @sisyphus_cwd 2>/dev/null)
    [ -z "$target_cwd" ] && target_cwd=$(tmux display-message -p '#{pane_current_path}')
  fi
  target_cwd="\${target_cwd%/}"
  [ -z "$target_cwd" ] && return 1
  while IFS=$'\\t' read -r sid sname; do
    [ -z "$sid" ] && continue
    case "$sname" in ssyph_*) continue ;; esac
    scwd=$(tmux show-options -t "$sid" -v @sisyphus_cwd 2>/dev/null)
    scwd="\${scwd%/}"
    if [ "$scwd" = "$target_cwd" ]; then
      HOME_SESSION="$sid"
      HOME_DWID=$(tmux show-options -t "$sid" -v @sisyphus_dashboard 2>/dev/null)
      return 0
    fi
  done < <(tmux list-sessions -F '#{session_id}	#{session_name}')
  return 1
}`.trim();

function homeScript(): string {
  const tuiPath = join(import.meta.dirname, 'tui.js');
  return `#!/bin/bash
# Jump to the dashboard window for the home session matching this cwd.
${RESOLVE_HOME}
if ! resolve_home; then
  tmux display-message "No sisyphus dashboard for this cwd"
  exit 0
fi
# Validate dashboard window is still alive; clear if stale
if [ -n "$HOME_DWID" ] && ! tmux list-panes -t "$HOME_DWID" >/dev/null 2>&1; then
  HOME_DWID=""
fi
# Reconcile: if option is unset/stale, scan home session for an existing TUI window
# (pane running 'node'). This prevents duplicate dashboards when the option drifts.
if [ -z "$HOME_DWID" ]; then
  HOME_DWID=$(tmux list-windows -t "$HOME_SESSION" -F '#{window_id} #{pane_current_command}' 2>/dev/null \
    | awk '$2=="node"{print $1; exit}')
  [ -n "$HOME_DWID" ] && tmux set-option -t "$HOME_SESSION" @sisyphus_dashboard "$HOME_DWID"
fi
if [ -z "$HOME_DWID" ]; then
  # Reopen dashboard: create window, launch TUI, update option
  home_cwd=$(tmux show-options -t "$HOME_SESSION" -v @sisyphus_cwd 2>/dev/null)
  [ -z "$home_cwd" ] && { tmux display-message "Home session has no cwd"; exit 0; }
  HOME_DWID=$(tmux new-window -t "$HOME_SESSION:" -n "sisyphus-dashboard" -c "$home_cwd" -P -F "#{window_id}")
  tmux send-keys -t "$HOME_DWID" "node '${tuiPath}' --cwd '$home_cwd'; exit" Enter
  tmux set-option -t "$HOME_SESSION" @sisyphus_dashboard "$HOME_DWID"
fi
current_id=$(tmux display-message -p '#{session_id}')
[ "$current_id" != "$HOME_SESSION" ] && tmux switch-client -t "$HOME_SESSION"
tmux select-window -t "$HOME_DWID"
`;
}

const KILL_PANE_SCRIPT = `#!/bin/bash
# Smart kill-pane invoked via the sisyphus prefix menu (C-s x).
# If this is the last pane, switch to the home session before killing.
${RESOLVE_HOME}
session_id=$(tmux display-message -p '#{session_id}')
pane_count=$(tmux list-panes -t "$session_id" -F '#{pane_id}' | wc -l | tr -d ' ')

if [ "$pane_count" -le 1 ]; then
  if resolve_home; then
    tmux switch-client -t "$HOME_SESSION"
    [ -n "$HOME_DWID" ] && tmux select-window -t "$HOME_DWID"
    tmux kill-session -t "$session_id"
    exit 0
  fi
  tmux kill-pane
else
  tmux kill-pane
  tmux select-layout even-horizontal
fi
`;

const NEW_PROMPT_SCRIPT = `#!/bin/bash
# Open nvim to compose a new sisyphus task, then start a session
tmpfile=$(mktemp /tmp/sisyphus-new.XXXXXX)
trap 'rm -f "$tmpfile"' EXIT
NVIM_APPNAME=sisyphus nvim "$tmpfile"
grep -q '[^[:space:]]' "$tmpfile" || exit 0
exec sis session lifecycle start "$(cat "$tmpfile")"
`;

const MESSAGE_SCRIPT = `#!/bin/bash
# Open nvim to compose a message for the current session's orchestrator
# Resolve session ID: direct tmux option → manifest lookup.
# All -t targeting uses $N session id — tmux -t <name> can substring-match under sparse env.
tmux_sid=$(tmux display-message -p '#{session_id}')
session_id=$(tmux show-options -t "$tmux_sid" -v @sisyphus_session_id 2>/dev/null)

if [ -z "$session_id" ]; then
  MANIFEST="$HOME/.sisyphus/sessions-manifest.tsv"
  [ ! -f "$MANIFEST" ] && { echo "No active sessions found"; sleep 1; exit 1; }
  cwd=""
  while IFS=$'\\t' read -r type name scwd phase sid; do
    [ "$sid" = "$tmux_sid" ] && { cwd="$scwd"; break; }
  done < "$MANIFEST"
  [ -z "$cwd" ] && { echo "Session not in manifest"; sleep 1; exit 1; }
  while IFS=$'\\t' read -r type name scwd phase sid; do
    if [ "$type" = "S" ] && [ "$scwd" = "$cwd" ]; then
      session_id=$(tmux show-options -t "$sid" -v @sisyphus_session_id 2>/dev/null)
      [ -n "$session_id" ] && break
    fi
  done < "$MANIFEST"
fi

[ -z "$session_id" ] && { echo "No active sisyphus session found"; sleep 1; exit 1; }

tmpfile=$(mktemp /tmp/sisyphus-msg.XXXXXX)
trap 'rm -f "$tmpfile"' EXIT
NVIM_APPNAME=sisyphus nvim "$tmpfile"
grep -q '[^[:space:]]' "$tmpfile" || exit 0
exec sis orch message --session "$session_id" "$(cat "$tmpfile")"
`;

// --- Shared session ID + cwd resolution for session-scoped scripts ---
// All tmux -t targeting uses $N session id — -t <name> can substring-match under sparse env.
const SESSION_RESOLVE = `
tmux_sid=$(tmux display-message -p '#{session_id}')
session_id=$(tmux show-options -t "$tmux_sid" -v @sisyphus_session_id 2>/dev/null)
cwd=$(tmux show-options -t "$tmux_sid" -v @sisyphus_cwd 2>/dev/null)

if [ -z "$session_id" ]; then
  MANIFEST="$HOME/.sisyphus/sessions-manifest.tsv"
  [ ! -f "$MANIFEST" ] && { echo "No active sessions found"; sleep 1; exit 1; }
  if [ -z "$cwd" ]; then
    while IFS=$'\\t' read -r type name scwd phase sid; do
      [ "$sid" = "$tmux_sid" ] && { cwd="$scwd"; break; }
    done < "$MANIFEST"
  fi
  [ -z "$cwd" ] && { echo "Session not in manifest"; sleep 1; exit 1; }
  while IFS=$'\\t' read -r type name scwd phase sid; do
    if [ "$type" = "S" ] && [ "$scwd" = "$cwd" ]; then
      session_id=$(tmux show-options -t "$sid" -v @sisyphus_session_id 2>/dev/null)
      [ -n "$session_id" ] && break
    fi
  done < "$MANIFEST"
fi

[ -z "$session_id" ] && { echo "No active sisyphus session found"; sleep 1; exit 1; }
[ -z "$cwd" ] && cwd=$(tmux display-message -p '#{pane_current_path}')`.trim();

// --- Go-home helper used by kill/delete scripts ---
// Assumes $cwd was captured before the destructive action ran (via SESSION_RESOLVE).
const GO_HOME_AFTER = `
${RESOLVE_HOME}
if resolve_home "$cwd"; then
  tmux switch-client -t "$HOME_SESSION"
  [ -n "$HOME_DWID" ] && tmux select-window -t "$HOME_DWID"
fi`.trim();

const KILL_SESSION_SCRIPT = `#!/bin/bash
# Kill the sisyphus session associated with the current tmux session
${SESSION_RESOLVE}

sis session lifecycle kill "$session_id" >/dev/null 2>&1
${GO_HOME_AFTER}
`;

const DELETE_SESSION_SCRIPT = `#!/bin/bash
# Delete the sisyphus session associated with the current tmux session
${SESSION_RESOLVE}

printf "\\033[31mType 'yes' to confirm:\\033[0m "
read -r answer
[ "$answer" = "yes" ] || exit 0
sis session lifecycle delete "$session_id" --cwd "$cwd" >/dev/null 2>&1
${GO_HOME_AFTER}
`;

const HELP_SCRIPT = `#!/bin/bash
cat <<'EOF_HELP'
${formatHelpForKeymap(KEYMAP)}
EOF_HELP
read -n 1 -s -r -p "  Press any key to close"
`;

// Open/focus the side companion claude pane. Re-runs are idempotent — the CLI
// looks for an existing pane with @sisyphus_companion set to this cwd via
// tmux pane options, so a previously closed pane never leaves stale state.
const COMPANION_PANE_SCRIPT = `#!/bin/bash
tmux_sid=$(tmux display-message -p '#{session_id}')
cwd=$(tmux show-options -t "$tmux_sid" -v @sisyphus_cwd 2>/dev/null)
[ -z "$cwd" ] && cwd=$(tmux display-message -p '#{pane_current_path}')
exec sis companion pane --cwd "$cwd"
`;

const STATUS_POPUP_SCRIPT = `#!/bin/bash
# Show session status — if no sisyphus session here, list all.
# -t targeting uses $N session id — -t <name> can substring-match under sparse env.
tmux_sid=$(tmux display-message -p '#{session_id}')
session_id=$(tmux show-options -t "$tmux_sid" -v @sisyphus_session_id 2>/dev/null)

if [ -z "$session_id" ]; then
  MANIFEST="$HOME/.sisyphus/sessions-manifest.tsv"
  if [ -f "$MANIFEST" ]; then
    cwd=""
    while IFS=$'\\t' read -r type name scwd phase sid; do
      [ "$sid" = "$tmux_sid" ] && { cwd="$scwd"; break; }
    done < "$MANIFEST"
    if [ -n "$cwd" ]; then
      while IFS=$'\\t' read -r type name scwd phase sid; do
        if [ "$type" = "S" ] && [ "$scwd" = "$cwd" ]; then
          session_id=$(tmux show-options -t "$sid" -v @sisyphus_session_id 2>/dev/null)
          [ -n "$session_id" ] && break
        fi
      done < "$MANIFEST"
    fi
  fi
fi

if [ -n "$session_id" ]; then
  sis session inspect status "$session_id" 2>&1 | less -R
else
  sis session inspect list 2>&1 | less -R
fi
`;

const PICK_SESSION_SCRIPT = `#!/bin/bash
# Session picker — switch to a sisyphus session.
# switch-client -t targets $N session id — -t <name> can substring-match under sparse env.
MANIFEST="$HOME/.sisyphus/sessions-manifest.tsv"
[ ! -f "$MANIFEST" ] && { echo "No sessions found"; sleep 1; exit 0; }

current_id=$(tmux display-message -p '#{session_id}')
cwd=""
while IFS=$'\\t' read -r type name scwd phase sid; do
  [ "$sid" = "$current_id" ] && { cwd="$scwd"; break; }
done < "$MANIFEST"

declare -a entries=()
declare -a targets=()
while IFS=$'\\t' read -r type name scwd phase sid; do
  [[ "$type" == "#"* ]] && continue
  [ -n "$cwd" ] && [ "$scwd" != "$cwd" ] && continue
  display="$name"
  if [[ "$name" == ssyph_* ]]; then
    display="\${name#ssyph_}"
    display="\${display#*_}"
  fi
  [ "$type" = "H" ] && display="~ home"
  marker=""
  [ "$sid" = "$current_id" ] && marker=" *"
  phase_label="\${phase:-—}"
  entries+=("\${display} [\${phase_label}]\${marker}")
  targets+=("$sid")
done < "$MANIFEST"

(( \${#entries[@]} == 0 )) && { echo "No sessions found"; sleep 1; exit 0; }

if command -v fzf &>/dev/null; then
  idx=$(for (( i=0; i<\${#entries[@]}; i++ )); do echo "$i \${entries[$i]}"; done | \\
    fzf --height=100% --reverse --with-nth=2.. --prompt="Switch to: " | awk '{print $1}')
  [ -z "$idx" ] && exit 0
  tmux switch-client -t "\${targets[$idx]}"
else
  for (( i=0; i<\${#entries[@]}; i++ )); do
    printf "  %d) %s\\n" $((i+1)) "\${entries[$i]}"
  done
  printf "\\nPick session: "
  read -r choice
  idx=$((choice - 1))
  (( idx >= 0 && idx < \${#entries[@]} )) || exit 0
  tmux switch-client -t "\${targets[$idx]}"
fi
`;

const CONTINUE_SESSION_SCRIPT = `#!/bin/bash
# Continue a completed session
${SESSION_RESOLVE}

short_id="\${session_id:0:8}"
printf "\\033[33mContinue session %s...?\\033[0m (y/n) " "$short_id"
read -r answer
[ "$answer" = "y" ] || [ "$answer" = "yes" ] || exit 0
sis session lifecycle continue --session "$session_id"
sleep 1
`;

const OPEN_ROADMAP_SCRIPT = `#!/bin/bash
# Open roadmap.md for the current session in nvim
${SESSION_RESOLVE}

file="$cwd/.sisyphus/sessions/$session_id/roadmap.md"
[ ! -f "$file" ] && { tmux display-message "No roadmap.md for this session"; exit 0; }
exec nvim "$file"
`;

const OPEN_STRATEGY_SCRIPT = `#!/bin/bash
# Open strategy.md for the current session in nvim
${SESSION_RESOLVE}

file="$cwd/.sisyphus/sessions/$session_id/strategy.md"
[ ! -f "$file" ] && { tmux display-message "No strategy.md for this session"; exit 0; }
exec nvim "$file"
`;

const EXPORT_SESSION_SCRIPT = `#!/bin/bash
# Export session data as zip to ~/Downloads
${SESSION_RESOLVE}

echo "Exporting session \${session_id:0:8}..."
sis session inspect export "$session_id" --cwd "$cwd"
echo ""
read -n 1 -s -r -p "Press a key to close."
`;

const RESTART_AGENT_SCRIPT = `#!/bin/bash
# Pick a sisyphus agent and restart it (fzf picker with confirm for running agents).
# fzf optional. Requires \`sis session inspect status --json\`.
${SESSION_RESOLVE}

command -v jq &>/dev/null || { echo "jq required"; sleep 1; exit 1; }

agents_json=$(sis session inspect status "$session_id" --json 2>/dev/null)
if [ -z "$agents_json" ]; then
  echo "Failed to read session status"; sleep 1; exit 1
fi

declare -a entries=()
declare -a ids=()
declare -a statuses=()
while IFS=$'\\t' read -r aid aname atype astatus; do
  [ -z "$aid" ] && continue
  entries+=("$aid  $aname ($atype) — $astatus")
  ids+=("$aid")
  statuses+=("$astatus")
done < <(echo "$agents_json" | jq -r '.agents[] | [.id, .name, .agentType, .status] | @tsv')

(( \${#entries[@]} == 0 )) && { echo "No agents in session"; sleep 1; exit 0; }

if command -v fzf &>/dev/null; then
  idx=$(for (( i=0; i<\${#entries[@]}; i++ )); do echo "$i \${entries[$i]}"; done \\
    | fzf --reverse --height=100% --with-nth=2.. --prompt="Restart: " | awk '{print $1}')
  [ -z "$idx" ] && exit 0
else
  for (( i=0; i<\${#entries[@]}; i++ )); do
    printf "  %d) %s\\n" $((i+1)) "\${entries[$i]}"
  done
  printf "\\nPick agent: "
  read -r choice
  idx=$((choice - 1))
  (( idx >= 0 && idx < \${#entries[@]} )) || exit 0
fi

if [ "\${statuses[$idx]}" = "running" ]; then
  printf "\\033[33mAgent is running. Restart anyway? (yes/no): \\033[0m"
  read -r answer
  [ "$answer" = "yes" ] || exit 0
fi

sis agent ctl restart "\${ids[$idx]}" --session "$session_id"
echo ""
read -n 1 -s -r -p "Press a key to close."
`;

// === Stage 2 script constants ===

const OPEN_GOAL_SCRIPT = `#!/bin/bash
# Open goal.md for the current session in nvim.
# Run from a sisyphus session pane, not the home dashboard.
${SESSION_RESOLVE}

file="$cwd/.sisyphus/sessions/$session_id/goal.md"
[ ! -f "$file" ] && { tmux display-message "No goal.md for this session"; exit 0; }
exec nvim "$file"
`;

const OPEN_DIR_SCRIPT = `#!/bin/bash
# Open session dir in the platform file manager (Finder/Explorer/xdg-open).
# Run from a sisyphus session pane, not the home dashboard.
${SESSION_RESOLVE}

dir="$cwd/.sisyphus/sessions/$session_id"
[ ! -d "$dir" ] && { tmux display-message "Session dir not found: $dir"; exit 0; }
exec ${OPEN_BIN} "$dir"
`;

const OPEN_LOGS_SCRIPT = `#!/bin/bash
# Tail the newest cycle log for this session in a popup.
# Run from a sisyphus session pane, not the home dashboard.
${SESSION_RESOLVE}

session_dir="$cwd/.sisyphus/sessions/$session_id"
target=$(ls -t "$session_dir/logs/"cycle-*.md 2>/dev/null | head -1)
[ -z "$target" ] && { tmux display-message "No logs for this session yet"; exit 0; }
exec tail -n 500 -f "$target"
`;

const RESUME_SESSION_SCRIPT = `#!/bin/bash
# Resume a paused/completed session with optional follow-up instructions.
# Run from a sisyphus session pane, not the home dashboard.
${SESSION_RESOLVE}

short_id="\${session_id:0:8}"

# Optional message — leave empty to resume with no extra instructions.
tmpfile=$(mktemp /tmp/sisyphus-resume.XXXXXX)
trap 'rm -f "$tmpfile"' EXIT
printf "# Resume session %s\\n# (Optional) Add follow-up instructions for the orchestrator below.\\n# Save & quit empty to resume with no message.\\n\\n" "$short_id" > "$tmpfile"
NVIM_APPNAME=sisyphus nvim "$tmpfile"

# Strip comment + blank lines to detect empty submission
body=$(grep -v '^[[:space:]]*#' "$tmpfile" | sed '/^[[:space:]]*$/d')

if [ -z "$body" ]; then
  exec sis session lifecycle resume "$session_id"
else
  exec sis session lifecycle resume "$session_id" "$body"
fi
`;

const ROLLBACK_SESSION_SCRIPT = `#!/bin/bash
# Roll back session to a chosen cycle. Prompts inline.
# Run from a sisyphus session pane, not the home dashboard.
${SESSION_RESOLVE}

short_id="\${session_id:0:8}"
printf "Rollback %s to cycle: " "$short_id"
read -r cycle_input

# Validate: positive integer
case "$cycle_input" in
  ''|*[!0-9]*)
    echo "Invalid cycle number"
    read -n 1 -s -r -p "Press a key to close."
    exit 0
    ;;
esac

if [ "$cycle_input" -lt 1 ]; then
  echo "Cycle must be >= 1"
  read -n 1 -s -r -p "Press a key to close."
  exit 0
fi

sis session recover rollback "$session_id" "$cycle_input"
echo ""
echo "Rolled back to cycle $cycle_input — use [C-s S r] to resume."
read -n 1 -s -r -p "Press a key to close."
`;

const GO_TO_WINDOW_SCRIPT = `#!/bin/bash
# Switch to the sisyphus session's tmux window. If the window is dead,
# fall back to opening the orchestrator's last claude --resume in a popup.
# Run from a sisyphus session pane, not the home dashboard.
${SESSION_RESOLVE}

command -v jq &>/dev/null || { echo "jq required"; sleep 1; exit 1; }

# Walk the manifest for the S-row whose tmux session has @sisyphus_session_id == ours.
# Manifest format: type\tname\tcwd\tphase\tsessionId
MANIFEST="$HOME/.sisyphus/sessions-manifest.tsv"
[ ! -f "$MANIFEST" ] && { tmux display-message "No manifest"; exit 0; }

target_sid=""
while IFS=$'\\t' read -r type name scwd phase sid; do
  [[ "$type" == "#"* ]] && continue
  [ "$type" = "S" ] || continue
  [ "$scwd" = "$cwd" ] || continue
  ssid=$(tmux show-options -t "$sid" -v @sisyphus_session_id 2>/dev/null)
  if [ "$ssid" = "$session_id" ]; then
    target_sid="$sid"
    break
  fi
done < "$MANIFEST"

if [ -n "$target_sid" ] && tmux has-session -t "$target_sid" 2>/dev/null; then
  tmux switch-client -t "$target_sid"
  exit 0
fi

# Fallback: orchestrator window is gone. Open last claude session in a popup.
state="$cwd/.sisyphus/sessions/$session_id/state.json"
[ ! -f "$state" ] && { tmux display-message "Window dead and no state.json — try sis session lifecycle resume"; exit 0; }

claude_sid=$(jq -r '[.orchestratorCycles[].claudeSessionId] | last // empty' "$state")

if [ -z "$claude_sid" ]; then
  tmux display-message "No orchestrator claude session id found — try sis session lifecycle resume"
  exit 0
fi

# Validate before passing to exec — value must be a safe session id.
[[ "$claude_sid" =~ ^[A-Za-z0-9_-]+$ ]] || { tmux display-message "Invalid claude session id"; exit 1; }

exec claude --resume "$claude_sid"
`;

const SPAWN_AGENT_SCRIPT = `#!/bin/bash
# Compose an instruction for a new agent and spawn it.
# Run from a sisyphus session pane, not the home dashboard.
${SESSION_RESOLVE}

tmpfile=$(mktemp /tmp/sisyphus-spawn.XXXXXX)
trap 'rm -f "$tmpfile"' EXIT
printf "# Spawn agent in session %s\\n# Write the agent's instruction below. Empty = abort.\\n\\n" "\${session_id:0:8}" > "$tmpfile"
NVIM_APPNAME=sisyphus nvim "$tmpfile"

body=$(grep -v '^[[:space:]]*#' "$tmpfile" | sed '/^[[:space:]]*$/d')
[ -z "$body" ] && exit 0

exec sis agent spawn --session "$session_id" --name "agent" --instruction "$body"
`;

const SEARCH_REPORTS_SCRIPT = `#!/bin/bash
# fzf over reports/*.md across all sessions for the current cwd.
# Falls back to numbered list if fzf is missing.

# Resolve cwd via tmux option (set by daemon) or fall back.
tmux_sid=$(tmux display-message -p '#{session_id}')
cwd=$(tmux show-options -t "$tmux_sid" -v @sisyphus_cwd 2>/dev/null)
[ -z "$cwd" ] && cwd=$(tmux display-message -p '#{pane_current_path}')

sessions_dir="$cwd/.sisyphus/sessions"
[ ! -d "$sessions_dir" ] && { tmux display-message "No sessions in $cwd"; exit 0; }

# Find all report files. -path filter scopes to */reports/*.md inside any session.
mapfile -t files < <(find "$sessions_dir" -type f -path '*/reports/*.md' 2>/dev/null | sort)
(( \${#files[@]} == 0 )) && { tmux display-message "No reports yet in $cwd"; exit 0; }

if command -v fzf &>/dev/null; then
  picked=$(printf '%s\\n' "\${files[@]}" \\
    | sed "s|$sessions_dir/||" \\
    | fzf --reverse --height=100% --prompt="Report: " \\
        --preview 'f={}; cat -- "'"$sessions_dir"'/$f"' --preview-window=right:60%)
  [ -z "$picked" ] && exit 0
  exec nvim "$sessions_dir/$picked"
else
  for (( i=0; i<\${#files[@]}; i++ )); do
    rel="\${files[$i]#$sessions_dir/}"
    printf "  %d) %s\\n" $((i+1)) "\${rel}"
  done
  printf "\\nPick: "
  read -r choice
  idx=$((choice - 1))
  (( idx >= 0 && idx < \${#files[@]} )) || exit 0
  exec nvim "\${files[$idx]}"
fi
`;

// === end Stage 2 script constants ===

// === Stage 3 script constants ===

const JUMP_TO_PANE_SCRIPT = `#!/bin/bash
# Pick a sisyphus agent and jump to its tmux pane.
# fzf optional. Requires \`sis session inspect status --json\`.
${SESSION_RESOLVE}

command -v jq &>/dev/null || { echo "jq required"; sleep 1; exit 1; }

agents_json=$(sis session inspect status "$session_id" --json 2>/dev/null)
if [ -z "$agents_json" ]; then
  echo "Failed to read session status"; sleep 1; exit 1
fi

declare -a entries=()
declare -a ids=()
declare -a panes=()
while IFS=$'\\t' read -r aid aname atype astatus pid; do
  [ -z "$aid" ] && continue
  entries+=("$aid  $aname ($atype) — $astatus")
  ids+=("$aid")
  panes+=("$pid")
done < <(echo "$agents_json" | jq -r '.agents[] | [.id, .name, .agentType, .status, .paneId] | @tsv')

(( \${#entries[@]} == 0 )) && { echo "No agents in session"; sleep 1; exit 0; }

if command -v fzf &>/dev/null; then
  idx=$(for (( i=0; i<\${#entries[@]}; i++ )); do echo "$i \${entries[$i]}"; done \\
    | fzf --reverse --height=100% --with-nth=2.. --prompt="Jump to: " | awk '{print $1}')
  [ -z "$idx" ] && exit 0
else
  for (( i=0; i<\${#entries[@]}; i++ )); do
    printf "  %d) %s\\n" $((i+1)) "\${entries[$i]}"
  done
  printf "\\nPick agent: "
  read -r choice
  idx=$((choice - 1))
  (( idx >= 0 && idx < \${#entries[@]} )) || exit 0
fi

target_pane="\${panes[$idx]}"
[ -z "$target_pane" ] && { echo "Agent has no active pane"; sleep 1; exit 1; }
target_session=$(tmux display-message -p -t "$target_pane" '#{session_id}' 2>/dev/null)
target_window=$(tmux display-message -p -t "$target_pane" '#{window_id}' 2>/dev/null)
[ -n "$target_session" ] && tmux switch-client -t "$target_session"
[ -n "$target_window" ] && tmux select-window -t "$target_window"
tmux select-pane -t "$target_pane"
`;

const MSG_AGENT_SCRIPT = `#!/bin/bash
# Pick a sisyphus agent and send it a message via nvim.
# fzf optional. Requires \`sis session inspect status --json\` and \`--agent\` on message.
${SESSION_RESOLVE}

command -v jq &>/dev/null || { echo "jq required"; sleep 1; exit 1; }

agents_json=$(sis session inspect status "$session_id" --json 2>/dev/null)
if [ -z "$agents_json" ]; then
  echo "Failed to read session status"; sleep 1; exit 1
fi

declare -a entries=()
declare -a ids=()
while IFS=$'\\t' read -r aid aname atype astatus; do
  [ -z "$aid" ] && continue
  entries+=("$aid  $aname ($atype) — $astatus")
  ids+=("$aid")
done < <(echo "$agents_json" | jq -r '.agents[] | [.id, .name, .agentType, .status] | @tsv')

(( \${#entries[@]} == 0 )) && { echo "No agents in session"; sleep 1; exit 0; }

if command -v fzf &>/dev/null; then
  idx=$(for (( i=0; i<\${#entries[@]}; i++ )); do echo "$i \${entries[$i]}"; done \\
    | fzf --reverse --height=100% --with-nth=2.. --prompt="Message agent: " | awk '{print $1}')
  [ -z "$idx" ] && exit 0
else
  for (( i=0; i<\${#entries[@]}; i++ )); do
    printf "  %d) %s\\n" $((i+1)) "\${entries[$i]}"
  done
  printf "\\nPick agent: "
  read -r choice
  idx=$((choice - 1))
  (( idx >= 0 && idx < \${#entries[@]} )) || exit 0
fi

tmpfile=$(mktemp /tmp/sisyphus-msg-agent.XXXXXX)
trap 'rm -f "$tmpfile"' EXIT
NVIM_APPNAME=sisyphus nvim "$tmpfile"
grep -q '[^[:space:]]' "$tmpfile" || exit 0
exec sis orch message --session "$session_id" --agent "\${ids[$idx]}" "$(cat "$tmpfile")"
`;

const RERUN_AGENT_SCRIPT = `#!/bin/bash
# Pick a sisyphus agent and spawn a retry with its original instruction.
# fzf optional. Requires \`sis session inspect status --json\`.
${SESSION_RESOLVE}

command -v jq &>/dev/null || { echo "jq required"; sleep 1; exit 1; }

agents_json=$(sis session inspect status "$session_id" --json 2>/dev/null)
if [ -z "$agents_json" ]; then
  echo "Failed to read session status"; sleep 1; exit 1
fi

declare -a entries=()
declare -a ids=()
declare -a atypes=()
declare -a anames=()
declare -a instrs=()
while IFS=$'\\t' read -r aid aname atype astatus ainstr_b64; do
  [ -z "$aid" ] && continue
  entries+=("$aid  $aname ($atype) — $astatus")
  ids+=("$aid")
  atypes+=("$atype")
  anames+=("$aname")
  instrs+=("$(echo "$ainstr_b64" | base64 -d)")
done < <(echo "$agents_json" | jq -r '.agents[] | [.id, .name, .agentType, .status, (.instruction // "" | @base64)] | @tsv')

(( \${#entries[@]} == 0 )) && { echo "No agents in session"; sleep 1; exit 0; }

if command -v fzf &>/dev/null; then
  idx=$(for (( i=0; i<\${#entries[@]}; i++ )); do echo "$i \${entries[$i]}"; done \\
    | fzf --reverse --height=100% --with-nth=2.. --prompt="Rerun: " | awk '{print $1}')
  [ -z "$idx" ] && exit 0
else
  for (( i=0; i<\${#entries[@]}; i++ )); do
    printf "  %d) %s\\n" $((i+1)) "\${entries[$i]}"
  done
  printf "\\nPick agent: "
  read -r choice
  idx=$((choice - 1))
  (( idx >= 0 && idx < \${#entries[@]} )) || exit 0
fi

instr="\${instrs[$idx]}"
if [ "\${#instr}" -lt 20 ]; then
  echo "Original instruction is shorter than 20 chars — cannot rerun safely."
  read -n 1 -s -r -p "Press a key to close."
  exit 1
fi

exec sis agent spawn --session "$session_id" --agent-type "\${atypes[$idx]}" --name "\${anames[$idx]}-retry-$(date +%s)" --instruction "$instr"
`;

const OPEN_CLAUDE_AGENT_SCRIPT = `#!/bin/bash
# Pick a sisyphus agent or orchestrator cycle and resume its Claude session.
# fzf optional. Requires \`sis session inspect status --json\`.
${SESSION_RESOLVE}

command -v jq &>/dev/null || { echo "jq required"; sleep 1; exit 1; }

state="$cwd/.sisyphus/sessions/$session_id/state.json"
[ ! -f "$state" ] && { echo "No state.json for this session"; sleep 1; exit 1; }

agents_json=$(sis session inspect status "$session_id" --json 2>/dev/null)
if [ -z "$agents_json" ]; then
  echo "Failed to read session status"; sleep 1; exit 1
fi

declare -a entries=()
declare -a claudes=()
while IFS=$'\\t' read -r rid rname rtype rcid; do
  [ -z "$rid" ] && continue
  entries+=("$rid  $rname ($rtype)")
  claudes+=("$rcid")
done < <(echo "$agents_json" | jq -r '
  ((.agents // [])[] | [.id, .name, .agentType, (.claudeSessionId // "")] | @tsv),
  ((.orchestratorCycles // [])[] | ["cycle-" + (.cycle|tostring), "orchestrator", "cycle", (.claudeSessionId // "")] | @tsv)
')

(( \${#entries[@]} == 0 )) && { echo "No agents or cycles in session"; sleep 1; exit 0; }

if command -v fzf &>/dev/null; then
  idx=$(for (( i=0; i<\${#entries[@]}; i++ )); do echo "$i \${entries[$i]}"; done \\
    | fzf --reverse --height=100% --with-nth=2.. --prompt="Open Claude: " | awk '{print $1}')
  [ -z "$idx" ] && exit 0
else
  for (( i=0; i<\${#entries[@]}; i++ )); do
    printf "  %d) %s\\n" $((i+1)) "\${entries[$i]}"
  done
  printf "\\nPick: "
  read -r choice
  idx=$((choice - 1))
  (( idx >= 0 && idx < \${#entries[@]} )) || exit 0
fi

cid="\${claudes[$idx]}"
[ -z "$cid" ] && { echo "No Claude session"; sleep 1; exit 1; }
[[ "$cid" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Invalid claude session id"; sleep 1; exit 1; }
cd "$cwd" && exec claude --resume "$cid"
`;

const TAIL_AGENT_LOGS_SCRIPT = `#!/bin/bash
# Pick a sisyphus agent and view its tmux pane scrollback (last 2000 lines) in less.
# Uses tmux capture-pane — no tail -f, no pipe-pane side effects.
# fzf optional. Requires \`sis session inspect status --json\`.
${SESSION_RESOLVE}

command -v jq &>/dev/null || { echo "jq required"; sleep 1; exit 1; }

agents_json=$(sis session inspect status "$session_id" --json 2>/dev/null)
if [ -z "$agents_json" ]; then
  echo "Failed to read session status"; sleep 1; exit 1
fi

declare -a entries=()
declare -a ids=()
declare -a panes=()
while IFS=$'\\t' read -r aid aname atype astatus pid; do
  [ -z "$aid" ] && continue
  entries+=("$aid  $aname ($atype) — $astatus")
  ids+=("$aid")
  panes+=("$pid")
done < <(echo "$agents_json" | jq -r '.agents[] | [.id, .name, .agentType, .status, .paneId] | @tsv')

(( \${#entries[@]} == 0 )) && { echo "No agents in session"; sleep 1; exit 0; }

if command -v fzf &>/dev/null; then
  idx=$(for (( i=0; i<\${#entries[@]}; i++ )); do echo "$i \${entries[$i]}"; done \\
    | fzf --reverse --height=100% --with-nth=2.. --prompt="Tail logs: " | awk '{print $1}')
  [ -z "$idx" ] && exit 0
else
  for (( i=0; i<\${#entries[@]}; i++ )); do
    printf "  %d) %s\\n" $((i+1)) "\${entries[$i]}"
  done
  printf "\\nPick agent: "
  read -r choice
  idx=$((choice - 1))
  (( idx >= 0 && idx < \${#entries[@]} )) || exit 0
fi

target_pane="\${panes[$idx]}"
[ -z "$target_pane" ] && { echo "Agent has no active pane"; sleep 1; exit 1; }
tmux capture-pane -t "$target_pane" -p -S -2000 | less +G
`;

const KILL_AGENT_SCRIPT = `#!/bin/bash
# Pick a sisyphus agent and kill it (with red confirmation prompt).
# fzf optional. Requires \`sis session inspect status --json\` and \`sis agent ctl kill\`.
${SESSION_RESOLVE}

command -v jq &>/dev/null || { echo "jq required"; sleep 1; exit 1; }

agents_json=$(sis session inspect status "$session_id" --json 2>/dev/null)
if [ -z "$agents_json" ]; then
  echo "Failed to read session status"; sleep 1; exit 1
fi

declare -a entries=()
declare -a ids=()
while IFS=$'\\t' read -r aid aname atype astatus; do
  [ -z "$aid" ] && continue
  entries+=("$aid  $aname ($atype) — $astatus")
  ids+=("$aid")
done < <(echo "$agents_json" | jq -r '.agents[] | [.id, .name, .agentType, .status] | @tsv')

(( \${#entries[@]} == 0 )) && { echo "No agents in session"; sleep 1; exit 0; }

if command -v fzf &>/dev/null; then
  idx=$(for (( i=0; i<\${#entries[@]}; i++ )); do echo "$i \${entries[$i]}"; done \\
    | fzf --reverse --height=100% --with-nth=2.. --prompt="Kill agent: " | awk '{print $1}')
  [ -z "$idx" ] && exit 0
else
  for (( i=0; i<\${#entries[@]}; i++ )); do
    printf "  %d) %s\\n" $((i+1)) "\${entries[$i]}"
  done
  printf "\\nPick agent: "
  read -r choice
  idx=$((choice - 1))
  (( idx >= 0 && idx < \${#entries[@]} )) || exit 0
fi

printf '\\033[31mKill %s? (yes/no): \\033[0m' "\${ids[$idx]}"
read -r answer
[ "$answer" = "yes" ] || exit 0
sis agent ctl kill "\${ids[$idx]}" --session "$session_id"
echo ""
read -n 1 -s -r -p "Press a key to close."
`;

const COPY_AGENT_ID_SCRIPT = `#!/bin/bash
# Pick a sisyphus agent and copy its ID to clipboard.
# Requires \`sis session inspect status --json\`. fzf optional.
${SESSION_RESOLVE}

command -v jq &>/dev/null || { echo "jq required"; sleep 1; exit 1; }

agents_json=$(sis session inspect status "$session_id" --json 2>/dev/null)
if [ -z "$agents_json" ]; then
  echo "Failed to read session status"; sleep 1; exit 1
fi

declare -a entries=()
declare -a ids=()
while IFS=$'\\t' read -r aid aname atype astatus; do
  [ -z "$aid" ] && continue
  entries+=("$aid  $aname ($atype) — $astatus")
  ids+=("$aid")
done < <(echo "$agents_json" | jq -r '.agents[] | [.id, .name, .agentType, .status] | @tsv')

(( \${#entries[@]} == 0 )) && { echo "No agents in session"; sleep 1; exit 0; }

if command -v fzf &>/dev/null; then
  idx=$(for (( i=0; i<\${#entries[@]}; i++ )); do echo "$i \${entries[$i]}"; done \\
    | fzf --reverse --height=100% --with-nth=2.. --prompt="Copy agent ID: " | awk '{print $1}')
  [ -z "$idx" ] && exit 0
else
  for (( i=0; i<\${#entries[@]}; i++ )); do
    printf "  %d) %s\\n" $((i+1)) "\${entries[$i]}"
  done
  printf "\\nPick agent: "
  read -r choice
  idx=$((choice - 1))
  (( idx >= 0 && idx < \${#entries[@]} )) || exit 0
fi

aid="\${ids[$idx]}"
printf '%s' "$aid" | ${CLIP_BIN}
tmux display-message "Copied $aid"
`;

const COPY_LOGS_SCRIPT = `#!/bin/bash
# Copy last 200 lines of the newest cycle log to clipboard.
${SESSION_RESOLVE}

dir="$cwd/.sisyphus/sessions/$session_id/logs"
[ -d "$dir" ] || { tmux display-message "No logs dir"; exit 0; }
latest=$(ls -t "$dir"/cycle-*.md 2>/dev/null | head -1)
[ -z "$latest" ] && { tmux display-message "No cycle logs yet"; exit 0; }
tail -n 200 "$latest" | ${CLIP_BIN}
tmux display-message "Copied last 200 lines of $(basename "$latest")"
`;

const COPY_LATEST_REPORT_SCRIPT = `#!/bin/bash
# Copy the newest report file to clipboard.
${SESSION_RESOLVE}

dir="$cwd/.sisyphus/sessions/$session_id/reports"
[ -d "$dir" ] || { tmux display-message "No reports dir"; exit 0; }
latest=$(ls -t "$dir" 2>/dev/null | head -1)
[ -z "$latest" ] && { tmux display-message "No reports yet"; exit 0; }
cat "$dir/$latest" | ${CLIP_BIN}
tmux display-message "Copied $latest"
`;

const COPY_PATH_SCRIPT = `#!/bin/bash
# Copy the session directory path to clipboard.
${SESSION_RESOLVE}

printf '%s' "$cwd/.sisyphus/sessions/$session_id" | ${CLIP_BIN}
tmux display-message "Copied session path"
`;

const COPY_ID_SCRIPT = `#!/bin/bash
# Copy the session ID to clipboard.
${SESSION_RESOLVE}

printf '%s' "$session_id" | ${CLIP_BIN}
tmux display-message "Copied session ID"
`;

const COPY_CONTEXT_SCRIPT = `#!/bin/bash
# Copy the session context XML to clipboard.
# Requires \`sis session inspect context\`.
${SESSION_RESOLVE}

sis session inspect context "$session_id" --cwd "$cwd" | ${CLIP_BIN}
tmux display-message "Copied session context (XML)"
`;

const EDIT_CONTEXT_FILE_SCRIPT = `#!/bin/bash
# Pick a context file for the current session and open it in nvim.
# Excludes archive/ subdirectory. fzf optional.
${SESSION_RESOLVE}

ctx_dir="$cwd/.sisyphus/sessions/$session_id/context"
[ -d "$ctx_dir" ] || { echo "No context dir for this session"; read -n 1 -s -r -p "Press a key to close."; exit 0; }

mapfile -t files < <(find "$ctx_dir" -type f -not -path '*/archive/*' | sort)
(( \${#files[@]} == 0 )) && { echo "No context files yet"; read -n 1 -s -r -p "Press a key to close."; exit 0; }

if command -v fzf &>/dev/null; then
  picked=$(printf '%s\\n' "\${files[@]}" | sed "s|$ctx_dir/||" \\
    | fzf --reverse --height=100% --prompt="Context file: ")
  [ -z "$picked" ] && exit 0
else
  declare -a display_files=()
  for f in "\${files[@]}"; do
    display_files+=("\${f#$ctx_dir/}")
  done
  for (( i=0; i<\${#display_files[@]}; i++ )); do
    printf "  %d) %s\\n" $((i+1)) "\${display_files[$i]}"
  done
  printf "\\nPick file: "
  read -r choice
  idx=$((choice - 1))
  (( idx >= 0 && idx < \${#display_files[@]} )) || exit 0
  picked="\${display_files[$idx]}"
fi

file="$ctx_dir/$picked"
exec nvim "$file"
`;

// === end Stage 3 script constants ===

// === Stage 4 script constants ===

const QUICK_SPAWN_EXPLORE_SCRIPT = `#!/bin/bash
# Spawn an Explore agent with the clipboard contents as the instruction.
${SESSION_RESOLVE}

instruction=$(${CLIP_BIN} paste 2>/dev/null)
if [ -z "\${instruction// }" ]; then
  echo "Clipboard is empty — copy a task description first"
  read -n 1 -s -r -p "Press a key to close."
  exit 1
fi

if [ "\${#instruction}" -lt 20 ]; then
  echo "Clipboard text too short (\${#instruction} chars; spawn requires 20+)"
  read -n 1 -s -r -p "Press a key to close."
  exit 1
fi

name="explore-$(date +%s)"
sis agent spawn \\
  --agent-type sisyphus:explore \\
  --name "$name" \\
  --session "$session_id" \\
  --instruction "$instruction"
exit_code=$?
[ $exit_code -ne 0 ] && read -n 1 -s -r -p "Press a key to close."
exit $exit_code
`;

const QUICK_SPAWN_DEBUG_SCRIPT = `#!/bin/bash
# Spawn a Debug agent with the clipboard contents as the instruction.
${SESSION_RESOLVE}

instruction=$(${CLIP_BIN} paste 2>/dev/null)
if [ -z "\${instruction// }" ]; then
  echo "Clipboard is empty — copy a task description first"
  read -n 1 -s -r -p "Press a key to close."
  exit 1
fi

if [ "\${#instruction}" -lt 20 ]; then
  echo "Clipboard text too short (\${#instruction} chars; spawn requires 20+)"
  read -n 1 -s -r -p "Press a key to close."
  exit 1
fi

name="debug-$(date +%s)"
sis agent spawn \\
  --agent-type sisyphus:debug \\
  --name "$name" \\
  --session "$session_id" \\
  --instruction "$instruction"
exit_code=$?
[ $exit_code -ne 0 ] && read -n 1 -s -r -p "Press a key to close."
exit $exit_code
`;

const OPEN_LATEST_REPORT_SCRIPT = `#!/bin/bash
# Open the most-recently-modified file in the current session's reports/ in nvim.
${SESSION_RESOLVE}

reports_dir="$cwd/.sisyphus/sessions/$session_id/reports"
if [ ! -d "$reports_dir" ]; then
  echo "No reports/ directory for this session"
  read -n 1 -s -r -p "Press a key to close."
  exit 0
fi

latest=$(ls -t "$reports_dir"/*.md 2>/dev/null | head -1)
if [ -z "$latest" ]; then
  echo "No reports yet"
  read -n 1 -s -r -p "Press a key to close."
  exit 0
fi

exec nvim "$latest"
`;

const CLONE_SESSION_SCRIPT = `#!/bin/bash
# Clone the current session into a new independent session.
# Orchestrator-only — the underlying CLI rejects calls from other panes/agents.
${SESSION_RESOLVE}

printf "Goal for cloned session: "
read -e goal
[ -z "\${goal// }" ] && exit 0

printf "Optional name (blank to skip): "
read -e clone_name

printf "Copy strategy.md? (y/N): "
read -r copy_strategy

args=()
[ -n "$clone_name" ] && args+=(--name "$clone_name")
[ "$copy_strategy" = "y" ] || [ "$copy_strategy" = "Y" ] && args+=(--strategy)

sis session recover clone "\${args[@]}" "$goal"
exit_code=$?
read -n 1 -s -r -p "Press a key to close."
exit $exit_code
`;

const HISTORY_SCRIPT = `#!/bin/bash
# Show rich session detail (history command's per-session view) in a popup.
${SESSION_RESOLVE}
sis session inspect history "$session_id" 2>&1 | less -R
`;

const RECONNECT_SCRIPT = `#!/bin/bash
# Reconnect daemon to an orphaned tmux session for the current cwd.
${SESSION_RESOLVE}
sis session recover reconnect "$session_id"
exit_code=$?
read -n 1 -s -r -p "Press a key to close."
exit $exit_code
`;

const OPEN_SCRATCH_SCRIPT = `#!/bin/bash
# Open a standalone Claude scratch window in the home tmux session for this cwd.
# scratch resolves the home session itself via @sisyphus_cwd; no session_id needed.
exec sis session scratch
`;

// === end Stage 4 script constants ===

function installScript(name: string, content: string): void {
  mkdirSync(join(globalDir(), 'bin'), { recursive: true });
  const path = scriptPath(name);
  writeFileSync(path, content, 'utf8');
  chmodSync(path, 0o755);
}

function installAllScripts(): void {
  // Compose flows (in-session message scripts) launch `NVIM_APPNAME=sisyphus nvim`,
  // which needs ~/.config/sisyphus/init.lua to exist before first use.
  ensureSisyphusInitLua();

  // Existing scripts with real content
  installScript('sisyphus-cycle', CYCLE_SCRIPT);
  installScript('sisyphus-home', homeScript());
  installScript('sisyphus-kill-pane', KILL_PANE_SCRIPT);
  installScript('sisyphus-new', NEW_PROMPT_SCRIPT);
  installScript('sisyphus-msg', MESSAGE_SCRIPT);
  // Cross-platform helpers used by the other embedded scripts. Install these
  // first so paste/copy callers find them on disk by the time they're invoked.
  installScript('sisyphus-clip', SISYPHUS_CLIP_SCRIPT);
  installScript('sisyphus-open', SISYPHUS_OPEN_SCRIPT);
  installScript('sisyphus-kill-session', KILL_SESSION_SCRIPT);
  installScript('sisyphus-delete-session', DELETE_SESSION_SCRIPT);
  installScript('sisyphus-status-popup', STATUS_POPUP_SCRIPT);
  installScript('sisyphus-pick-session', PICK_SESSION_SCRIPT);
  installScript('sisyphus-continue-session', CONTINUE_SESSION_SCRIPT);
  installScript('sisyphus-restart-agent-popup', RESTART_AGENT_SCRIPT);
  installScript('sisyphus-open-roadmap', OPEN_ROADMAP_SCRIPT);
  installScript('sisyphus-open-strategy', OPEN_STRATEGY_SCRIPT);
  installScript('sisyphus-export-session', EXPORT_SESSION_SCRIPT);

  // === Stage 1 (descriptor + generator + stub installs) ===
  const scriptsDir = join(globalDir(), 'bin');

  // Submenu dispatch scripts — one per submenu, generated from descriptor
  for (const [id, def] of Object.entries(KEYMAP.submenus)) {
    installScript(`sisyphus-menu-${id}`, generateSubmenuScript(id, def, scriptsDir));
  }
  // === end Stage 1 ===

  // === Stage 2 (tmux submenu scripts) ===
  installScript('sisyphus-open-goal', OPEN_GOAL_SCRIPT);
  installScript('sisyphus-open-dir', OPEN_DIR_SCRIPT);
  installScript('sisyphus-open-logs', OPEN_LOGS_SCRIPT);
  installScript('sisyphus-resume-session', RESUME_SESSION_SCRIPT);
  installScript('sisyphus-rollback-session', ROLLBACK_SESSION_SCRIPT);
  installScript('sisyphus-go-to-window', GO_TO_WINDOW_SCRIPT);
  installScript('sisyphus-spawn-agent', SPAWN_AGENT_SCRIPT);
  installScript('sisyphus-search-reports', SEARCH_REPORTS_SCRIPT);
  // === end Stage 2 ===

  // === Stage 3 (cursor pickers) ===
  installScript('sisyphus-jump-to-pane', JUMP_TO_PANE_SCRIPT);
  installScript('sisyphus-msg-agent', MSG_AGENT_SCRIPT);
  installScript('sisyphus-rerun-agent', RERUN_AGENT_SCRIPT);
  installScript('sisyphus-open-claude-agent', OPEN_CLAUDE_AGENT_SCRIPT);
  installScript('sisyphus-tail-agent-logs', TAIL_AGENT_LOGS_SCRIPT);
  installScript('sisyphus-kill-agent', KILL_AGENT_SCRIPT);
  installScript('sisyphus-copy-agent-id', COPY_AGENT_ID_SCRIPT);
  installScript('sisyphus-copy-logs', COPY_LOGS_SCRIPT);
  installScript('sisyphus-copy-latest-report', COPY_LATEST_REPORT_SCRIPT);
  installScript('sisyphus-copy-path', COPY_PATH_SCRIPT);
  installScript('sisyphus-copy-id', COPY_ID_SCRIPT);
  installScript('sisyphus-copy-context', COPY_CONTEXT_SCRIPT);
  installScript('sisyphus-edit-context-file', EDIT_CONTEXT_FILE_SCRIPT);
  // === end Stage 3 ===

  // === Stage 4 (creative additions) ===
  installScript('sisyphus-quick-spawn-explore', QUICK_SPAWN_EXPLORE_SCRIPT);
  installScript('sisyphus-quick-spawn-debug', QUICK_SPAWN_DEBUG_SCRIPT);
  installScript('sisyphus-open-latest-report', OPEN_LATEST_REPORT_SCRIPT);
  installScript('sisyphus-clone-session', CLONE_SESSION_SCRIPT);
  installScript('sisyphus-history', HISTORY_SCRIPT);
  installScript('sisyphus-reconnect', RECONNECT_SCRIPT);
  installScript('sisyphus-open-scratch', OPEN_SCRATCH_SCRIPT);
  // === end Stage 4 ===

  // === Stage 6 (help script override) ===
  installScript('sisyphus-help', HELP_SCRIPT);
  // === end Stage 6 ===

  // Side claude pane (direct leader action). Re-runs are idempotent — the CLI
  // detects an existing companion pane for the cwd via the @sisyphus_companion
  // pane marker and focuses it instead of creating a duplicate.
  installScript('sisyphus-companion-pane', COMPANION_PANE_SCRIPT);
}

export function getExistingBinding(key: string, table: string = 'root'): string | null {
  try {
    const output = execSync(`tmux list-keys -T ${table}`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    for (const line of output.split('\n')) {
      if (line.includes(key)) {
        const parts = line.trim().split(/\s+/);
        const keyIdx = parts.indexOf(key);
        if (keyIdx !== -1) {
          return line.trim();
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function isSisyphusBinding(binding: string): boolean {
  return binding.includes('sisyphus');
}

export type SetupResult =
  | { status: 'installed'; message: string }
  | { status: 'already-installed'; message: string }
  | { status: 'conflict'; message: string; existingBinding: string; conflictKey: string }
  | { status: 'unsupported-tmux'; message: string }
  | { status: 'requires-force'; message: string; reason: 'would-modify-user-conf'; userConf: string; manualLine: string }
  | { status: 'conf-modification-declined'; message: string; manualLine: string; userConf: string };

export interface SetupOptions {
  /** Skip the y/N prompt before appending to the user's tmux.conf. */
  assumeYes?: boolean;
  /**
   * Override safety refusals: silently overwrite any existing root-table binding on
   * cycle/prefix keys AND auto-append the source-file line to the user's tmux.conf
   * (implies assumeYes for the conf-append path).
   */
  force?: boolean;
}

async function confirmConfAppend(userConf: string, line: string): Promise<boolean> {
  // Don't block scripted/non-TTY callers; they can opt in with assumeYes.
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const question =
      `\nSisyphus needs to append one line to ${userConf} so its tmux keybindings persist:\n` +
      `  ${line}\n\n` +
      `Append it now? (y/N) `;
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

export async function setupTmuxKeybind(
  cycleKey: string = DEFAULT_CYCLE_KEY,
  prefixKey: string = DEFAULT_PREFIX_KEY,
  opts: SetupOptions = {},
): Promise<SetupResult> {
  installAllScripts();

  // Version check — hard requirement for display-menu flags used
  if (!tmuxVersionAtLeast(3, 2)) {
    let version = 'unknown';
    try { version = execSync('tmux -V', { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); } catch {}
    return {
      status: 'unsupported-tmux',
      message: `tmux 3.2+ required for sisyphus keybindings; got ${version}`,
    };
  }

  // Check for existing bindings before writing anything. With --force, we overwrite
  // them silently (tmux bind-key replaces in place); otherwise refuse so the user can
  // pick alternate keys or explicitly opt in.
  if (!opts.force) {
    for (const [label, key] of [['cycle', cycleKey], ['cycle-back', DEFAULT_CYCLE_BACK_KEY], ['prefix', prefixKey]] as const) {
      const existing = getExistingBinding(key);
      if (existing !== null && !isSisyphusBinding(existing)) {
        return {
          status: 'conflict',
          message: `Tmux key ${key} (${label}) is already bound to something else. Re-run with --force to overwrite, or pass an alternate cycle key (e.g. "sis admin install setup-keybind M-w").`,
          existingBinding: existing,
          conflictKey: key,
        };
      }
    }
  }

  // Detect whether we'd modify the user's tmux.conf BEFORE writing any sisyphus-managed
  // file. Without --force (or --yes), refuse so the user can decide explicitly.
  const userConfPreview = userTmuxConfPath();
  const sisyphusConfPathPreview = sisyphusTmuxConfPath();
  const markedSourceLinePreview = `source-file ${sisyphusConfPathPreview} ${SISYPHUS_CONF_MARKER}`;
  if (userConfPreview !== null && !opts.force && !opts.assumeYes) {
    let alreadySources = false;
    try {
      alreadySources = readFileSync(userConfPreview, 'utf8').includes(sisyphusConfPathPreview);
    } catch {
      /* unreadable — treat as not-sourcing so we err on the side of refusing */
    }
    if (!alreadySources) {
      return {
        status: 'requires-force',
        reason: 'would-modify-user-conf',
        userConf: userConfPreview,
        manualLine: markedSourceLinePreview,
        message:
          `Refusing to modify ${userConfPreview} without explicit consent.\n` +
          `Re-run with --force (persist) or --yes (same effect, conf-append only) to append:\n` +
          `  ${markedSourceLinePreview}\n` +
          `Or run "sis admin check check-keybinds" for the full decision tree (live-only install is also an option).`,
      };
    }
  }

  writeKeymapJson();

  const scriptsDir = join(globalDir(), 'bin');
  const bindings = [
    // C-s → display-menu top-level (descriptor-driven)
    generateTopLevelBinding(prefixKey, KEYMAP.topLevel, scriptsDir),
    // M-s → cycle forward (unchanged)
    `bind-key -T root ${cycleKey} run-shell ${cycleScriptPath()}`,
    // M-S → cycle backward (same script, "prev" direction)
    `bind-key -T root ${DEFAULT_CYCLE_BACK_KEY} run-shell "${cycleScriptPath()} prev"`,
    // smart-kill is reachable via the sisyphus prefix menu (C-s x) — see KEYMAP.topLevel.
    // We deliberately don't override `prefix x` so users keep their default tmux kill-pane.
  ];

  const confPath = sisyphusTmuxConfPath();
  writeFileSync(confPath, `${SISYPHUS_CONF_MARKER}\n${bindings.join('\n')}\n`, 'utf8');

  // Append source line to tmux.conf if not already there
  const userConf = userTmuxConfPath();
  const markedSourceLine = `source-file ${confPath} ${SISYPHUS_CONF_MARKER}`;
  let persistedToConf = false;
  let appendDeclined = false;

  if (userConf !== null) {
    const contents = readFileSync(userConf, 'utf8');
    if (contents.includes(confPath)) {
      persistedToConf = true;
    } else {
      const shouldAppend = opts.assumeYes || opts.force
        ? true
        : await confirmConfAppend(userConf, markedSourceLine);
      if (shouldAppend) {
        const separator = contents.endsWith('\n') ? '' : '\n';
        writeFileSync(userConf, `${contents}${separator}${markedSourceLine}\n`, 'utf8');
        persistedToConf = true;
      } else {
        appendDeclined = true;
      }
    }
  }

  // Apply bindings live
  try {
    for (const b of bindings) {
      execSync(`tmux ${b}`, { stdio: 'pipe' });
    }
  } catch {
    // tmux not running
  }

  if (appendDeclined && userConf !== null) {
    return {
      status: 'conf-modification-declined',
      message:
        `Tmux keybindings applied to the live session, but not persisted.\n` +
        `To persist them, add this line to ${userConf}:\n  ${markedSourceLine}`,
      manualLine: markedSourceLine,
      userConf,
    };
  }

  if (getExistingBinding(cycleKey) !== null && isSisyphusBinding(getExistingBinding(cycleKey)!)) {
    return {
      status: 'already-installed',
      message: `Tmux keybindings already configured: ${cycleKey} (cycle), ${prefixKey}+key (?=help for full list).`,
    };
  }

  const persistNote = persistedToConf
    ? ''
    : `\nNote: No tmux.conf found. Add this to your tmux config for persistence:\n  source-file ${confPath}`;
  return {
    status: 'installed',
    message: `Tmux keybindings set: ${cycleKey} cycles, ${prefixKey}+key (?=help for full list)${persistNote}`,
  };
}

export function removeTmuxKeybind(): void {
  const confPath = sisyphusTmuxConfPath();
  for (const candidate of [join(homedir(), '.tmux.conf'), join(homedir(), '.config', 'tmux', 'tmux.conf')]) {
    if (existsSync(candidate)) {
      const contents = readFileSync(candidate, 'utf8');
      const filtered = contents
        .split('\n')
        .filter((line) => !line.includes(confPath))
        .join('\n');
      if (filtered !== contents) {
        writeFileSync(candidate, filtered, 'utf8');
      }
    }
  }

  if (existsSync(confPath)) {
    unlinkSync(confPath);
  }

  // Unbind live
  try {
    execSync(`tmux unbind-key -T root ${DEFAULT_CYCLE_KEY}`, { stdio: 'pipe' });
    execSync(`tmux unbind-key -T root ${DEFAULT_CYCLE_BACK_KEY}`, { stdio: 'pipe' });
    execSync(`tmux unbind-key -T root ${DEFAULT_PREFIX_KEY}`, { stdio: 'pipe' });
    const output = execSync(`tmux list-keys -T ${KEY_TABLE}`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    for (const line of output.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4 && parts[2] === KEY_TABLE) {
        execSync(`tmux unbind-key -T ${KEY_TABLE} ${parts[3]}`, { stdio: 'pipe' });
      }
    }
  } catch {
    // tmux not running
  }

  // Remove keymap.json
  const kmPath = keymapJsonPath();
  if (existsSync(kmPath)) unlinkSync(kmPath);

  // Remove scripts
  const scripts = [
    'sisyphus-cycle', 'sisyphus-home', 'sisyphus-kill-pane', 'sisyphus-new', 'sisyphus-msg',
    'sisyphus-kill-session', 'sisyphus-delete-session', 'sisyphus-help', 'sisyphus-status-popup',
    'sisyphus-pick-session', 'sisyphus-continue-session', 'sisyphus-restart-agent-popup',
    'sisyphus-open-roadmap', 'sisyphus-open-strategy', 'sisyphus-export-session',
    // Stage 1: submenu dispatch scripts
    ...Object.keys(KEYMAP.submenus).map(id => `sisyphus-menu-${id}`),
    // Stage 1: new stub scripts
    'sisyphus-copy-path', 'sisyphus-copy-id', 'sisyphus-copy-context',
    'sisyphus-copy-logs', 'sisyphus-copy-latest-report', 'sisyphus-copy-agent-id',
    'sisyphus-open-goal', 'sisyphus-open-dir', 'sisyphus-open-logs',
    'sisyphus-open-latest-report', 'sisyphus-open-scratch', 'sisyphus-edit-context-file',
    'sisyphus-spawn-agent', 'sisyphus-msg-agent', 'sisyphus-rerun-agent',
    'sisyphus-jump-to-pane', 'sisyphus-open-claude-agent', 'sisyphus-tail-agent-logs',
    'sisyphus-kill-agent', 'sisyphus-quick-spawn-explore', 'sisyphus-quick-spawn-debug',
    'sisyphus-resume-session', 'sisyphus-rollback-session', 'sisyphus-go-to-window',
    'sisyphus-clone-session', 'sisyphus-history', 'sisyphus-reconnect',
    'sisyphus-search-reports',
  ];
  for (const name of scripts) {
    const path = scriptPath(name);
    if (existsSync(path)) unlinkSync(path);
  }
}
