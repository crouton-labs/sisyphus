import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { globalConfigPath, daemonPidPath } from '../../shared/paths.js';
import type { StatusBarConfig } from '../../shared/types.js';

const SISYPHUS_LEFT_TOKEN = '@sisyphus_left';
const SISYPHUS_RIGHT_TOKEN = '@sisyphus_right';
// tmux's compiled-in defaults (vary slightly by version, but these are the canonical
// strings new users see). Used for "is the user on stock tmux?" detection.
const TMUX_DEFAULT_STATUS_LEFT = '[#S] ';
const TMUX_DEFAULT_STATUS_RIGHT_PREFIX = '"#{=21:pane_title}"'; // matches default tmux right

interface TmuxOptionSnapshot {
  status: string | null;
  statusLeft: string | null;
  statusRight: string | null;
  statusPosition: string | null;
  statusStyle: string | null;
  statusInterval: string | null;
}

interface UserConfState {
  path: string | null;
  setsStatusLeft: boolean;
  setsStatusRight: boolean;
  sourcesSisyphusManaged: boolean;
}

type StatusBarState =
  | 'wired'
  | 'partial-left-only'
  | 'partial-right-only'
  | 'custom-no-sisyphus'
  | 'tmux-default'
  | 'disabled'
  | 'tmux-not-ready';

interface CheckResult {
  tmuxInstalled: boolean;
  tmuxServerRunning: boolean;
  daemonRunning: boolean;
  tmuxOptions: TmuxOptionSnapshot;
  userConf: UserConfState;
  globalConfig: StatusBarConfig | null;
  state: StatusBarState;
  // Convenience for the renderer.
  referencesSisyphusLeft: boolean;
  referencesSisyphusRight: boolean;
}

function isTmuxInstalled(): boolean {
  try {
    execSync('which tmux', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function isTmuxServerRunning(): boolean {
  try {
    execSync('tmux list-sessions', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function isDaemonRunning(): boolean {
  const pidFile = daemonPidPath();
  if (!existsSync(pidFile)) return false;
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (Number.isNaN(pid) || pid <= 0) return false;
    // Signal 0 — checks existence without sending a real signal. Throws if process is gone.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function showOption(name: string): string | null {
  try {
    const out = execSync(`tmux show-options -g ${name}`, { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim();
    if (out.length === 0) return null;
    // tmux output: `<name> "<value>"` or `<name> <value>`
    const prefix = `${name} `;
    const stripped = out.startsWith(prefix) ? out.slice(prefix.length) : out;
    // Strip surrounding quotes if present.
    if (stripped.startsWith('"') && stripped.endsWith('"') && stripped.length >= 2) {
      return stripped.slice(1, -1);
    }
    return stripped;
  } catch {
    return null;
  }
}

function probeTmuxOptions(serverRunning: boolean): TmuxOptionSnapshot {
  if (!serverRunning) {
    return {
      status: null,
      statusLeft: null,
      statusRight: null,
      statusPosition: null,
      statusStyle: null,
      statusInterval: null,
    };
  }
  return {
    status: showOption('status'),
    statusLeft: showOption('status-left'),
    statusRight: showOption('status-right'),
    statusPosition: showOption('status-position'),
    statusStyle: showOption('status-style'),
    statusInterval: showOption('status-interval'),
  };
}

function findUserTmuxConf(): string | null {
  const xdg = join(homedir(), '.config', 'tmux', 'tmux.conf');
  const dotfile = join(homedir(), '.tmux.conf');
  if (existsSync(xdg)) return xdg;
  if (existsSync(dotfile)) return dotfile;
  return null;
}

function probeUserConf(): UserConfState {
  const path = findUserTmuxConf();
  if (path === null) {
    return { path: null, setsStatusLeft: false, setsStatusRight: false, sourcesSisyphusManaged: false };
  }
  let contents = '';
  try {
    contents = readFileSync(path, 'utf-8');
  } catch {
    return { path, setsStatusLeft: false, setsStatusRight: false, sourcesSisyphusManaged: false };
  }
  // Match "set -g status-left" or "set-option -g status-left" (loose grep, ignore commented lines).
  const lines = contents.split('\n').filter((line) => !line.trim().startsWith('#'));
  const setsStatusLeft = lines.some((line) => /^\s*(set|set-option)\s+-g(?:\s+-\w+)*\s+status-left\b/.test(line));
  const setsStatusRight = lines.some((line) => /^\s*(set|set-option)\s+-g(?:\s+-\w+)*\s+status-right\b/.test(line));
  const sourcesSisyphusManaged = contents.includes(join(homedir(), '.sisyphus', 'tmux.conf'));
  return { path, setsStatusLeft, setsStatusRight, sourcesSisyphusManaged };
}

function loadGlobalSisyphusConfig(): StatusBarConfig | null {
  const path = globalConfigPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { statusBar?: StatusBarConfig };
    return parsed.statusBar === undefined ? null : parsed.statusBar;
  } catch {
    return null;
  }
}

function classifyState(opts: TmuxOptionSnapshot, serverRunning: boolean): {
  state: StatusBarState;
  referencesSisyphusLeft: boolean;
  referencesSisyphusRight: boolean;
} {
  if (!serverRunning) {
    return { state: 'tmux-not-ready', referencesSisyphusLeft: false, referencesSisyphusRight: false };
  }
  if (opts.status === 'off') {
    return { state: 'disabled', referencesSisyphusLeft: false, referencesSisyphusRight: false };
  }
  const referencesSisyphusLeft = opts.statusLeft !== null && opts.statusLeft.includes(SISYPHUS_LEFT_TOKEN);
  const referencesSisyphusRight = opts.statusRight !== null && opts.statusRight.includes(SISYPHUS_RIGHT_TOKEN);
  if (referencesSisyphusLeft && referencesSisyphusRight) {
    return { state: 'wired', referencesSisyphusLeft, referencesSisyphusRight };
  }
  if (referencesSisyphusLeft) {
    return { state: 'partial-left-only', referencesSisyphusLeft, referencesSisyphusRight };
  }
  if (referencesSisyphusRight) {
    return { state: 'partial-right-only', referencesSisyphusLeft, referencesSisyphusRight };
  }
  // Distinguish stock tmux vs user-customized.
  const isStock =
    (opts.statusLeft === TMUX_DEFAULT_STATUS_LEFT || opts.statusLeft === null) &&
    (opts.statusRight === null || opts.statusRight.includes(TMUX_DEFAULT_STATUS_RIGHT_PREFIX));
  return {
    state: isStock ? 'tmux-default' : 'custom-no-sisyphus',
    referencesSisyphusLeft,
    referencesSisyphusRight,
  };
}

function runCheck(): CheckResult {
  const tmuxInstalled = isTmuxInstalled();
  const tmuxServerRunning = tmuxInstalled ? isTmuxServerRunning() : false;
  const tmuxOptions = probeTmuxOptions(tmuxServerRunning);
  const userConf = probeUserConf();
  const globalConfig = loadGlobalSisyphusConfig();
  const daemonRunning = isDaemonRunning();
  const { state, referencesSisyphusLeft, referencesSisyphusRight } = classifyState(tmuxOptions, tmuxServerRunning);
  return {
    tmuxInstalled,
    tmuxServerRunning,
    daemonRunning,
    tmuxOptions,
    userConf,
    globalConfig,
    state,
    referencesSisyphusLeft,
    referencesSisyphusRight,
  };
}

function fmtOption(value: string | null): string {
  if (value === null) return '(unset)';
  return JSON.stringify(value);
}

function renderConfigSummary(cfg: StatusBarConfig | null): string {
  if (cfg === null) return '(no statusBar block in ~/.sisyphus/config.json — defaults apply)';
  const parts: string[] = [];
  if (cfg.enabled === false) parts.push('enabled: false (DISABLED)');
  if (cfg.left !== undefined) parts.push(`left: [${cfg.left.join(', ')}]`);
  if (cfg.right !== undefined) parts.push(`right: [${cfg.right.join(', ')}]`);
  if (cfg.colors !== undefined) parts.push(`colors: ${JSON.stringify(cfg.colors)}`);
  if (cfg.segments !== undefined) {
    const segNames = Object.keys(cfg.segments);
    if (segNames.length > 0) parts.push(`per-segment overrides: ${segNames.join(', ')}`);
  }
  if (parts.length === 0) return '(statusBar block exists but is empty — defaults apply)';
  return parts.join('\n  ');
}

function printInstructions(r: CheckResult): void {
  const userConfPath = r.userConf.path === null ? '~/.tmux.conf (none found)' : r.userConf.path;
  const userConfForCopy = r.userConf.path === null ? '~/.tmux.conf' : r.userConf.path;

  console.log(`
<claude-instructions>
# Sisyphus Statusbar Helper

This is a READ-ONLY check. Use it to figure out how to help the user improve their
tmux statusbar with sisyphus segments WITHOUT clobbering their existing setup. The
user's tmux config is theirs — never overwrite it. Append, suggest snippets, or
nudge them to edit ~/.sisyphus/config.json.

## Environment Data
- tmuxInstalled: ${r.tmuxInstalled}
- tmuxServerRunning: ${r.tmuxServerRunning}
- daemonRunning: ${r.daemonRunning}  (false = @sisyphus_left/@sisyphus_right won't get populated, statusbar will look broken until daemon is up)

### Live tmux options
- status: ${fmtOption(r.tmuxOptions.status)}
- status-left: ${fmtOption(r.tmuxOptions.statusLeft)}
- status-right: ${fmtOption(r.tmuxOptions.statusRight)}
- status-position: ${fmtOption(r.tmuxOptions.statusPosition)}
- status-style: ${fmtOption(r.tmuxOptions.statusStyle)}
- status-interval: ${fmtOption(r.tmuxOptions.statusInterval)}
- referencesSisyphusLeft: ${r.referencesSisyphusLeft}
- referencesSisyphusRight: ${r.referencesSisyphusRight}

### User tmux config
- path: ${userConfPath}
- setsStatusLeft: ${r.userConf.setsStatusLeft}
- setsStatusRight: ${r.userConf.setsStatusRight}
- sourcesSisyphusManaged: ${r.userConf.sourcesSisyphusManaged}  (sources ~/.sisyphus/tmux.conf — keybinds, NOT statusbar; included for context)

### Sisyphus statusbar config (~/.sisyphus/config.json → statusBar)
  ${renderConfigSummary(r.globalConfig)}

### Available segments
- session-name (left default) — current tmux session name
- windows (left default) — tmux window list with active highlight
- sessions (right default) — all tmux sessions with claude-state colors
- sisyphus-sessions (right default) — sisyphus-managed sessions with phase indicators
- companion (right default) — companion mood/state pill
- clock — separate %H:%M (NOT a sisyphus segment; tmux renders it inline; the default
  ~/.tmux.conf appends \`#[fg=...]#[bg=...] %H:%M \` after #{E:@sisyphus_right})

## Detected state: **${r.state}**

Pick exactly one path. Each path tells you what to ask the user and what to do.

### Path A — Already wired (state: wired)
**Trigger:** status-left and status-right both reference @sisyphus_left/@sisyphus_right.
**Action:** ${r.state === 'wired' ? '✓ THIS IS YOUR PATH.' : '(not applicable)'}

The plumbing is correct. ${r.daemonRunning ? '' : 'BUT daemon is not running — run `sisyphusd start` (or restart) so the @sisyphus_* options get populated. '}Now offer to **customize** what's shown:

  1. **Reorder or hide segments.** Edit \`~/.sisyphus/config.json\`, set \`statusBar.left\` / \`statusBar.right\` to the array of segment ids you want (in order). Example to hide windows and reorder:
     \`\`\`json
     {
       "statusBar": {
         "left": ["session-name"],
         "right": ["sisyphus-sessions", "companion"]
       }
     }
     \`\`\`
  2. **Recolor.** \`statusBar.colors\` overrides processing/stopped/idle/activeBg/activeText/inactiveText. \`statusBar.segments.<id>.bg\` overrides per-segment band background.
  3. **Disable a single segment.** Remove its id from the left/right arrays.
  4. **Disable the whole bar.** \`statusBar.enabled: false\` — daemon stops writing the options; the user's status-left/right will then render as literal \`#{E:@sisyphus_left}\` (which tmux silently treats as empty).
  5. **Restart the daemon** after any config change: \`sisyphusd restart\`. Changes don't auto-apply.

Ask the user what they want to change. Edit \`~/.sisyphus/config.json\` for them — that file is sisyphus-managed config, safe to edit. Don't touch their \`~/.tmux.conf\`.

### Path B — Partial wiring (state: partial-left-only or partial-right-only)
**Trigger:** Only one side references sisyphus.
**Action:** ${r.state === 'partial-left-only' || r.state === 'partial-right-only' ? '✓ THIS IS YOUR PATH.' : '(not applicable)'}

Their config is half-wired. Show them the missing side:
  - Missing left → suggest adding \`set -g status-left "#{E:@sisyphus_left}"\` to ${userConfForCopy}
  - Missing right → suggest adding \`set -g status-right "#{E:@sisyphus_right}#[fg=#2d2f33]#[bg=#2d2f33,fg=#b0a898] %H:%M "\`

Don't auto-edit their config — present the snippet and ask if they want you to append it.

### Path C — Stock tmux statusbar (state: tmux-default)
**Trigger:** status-left/right are tmux defaults; user has no custom statusbar.
**Action:** ${r.state === 'tmux-default' ? '✓ THIS IS YOUR PATH.' : '(not applicable)'}

Easiest case. Two options to offer:

  1. **Full sisyphus statusbar.** Append these lines to ${userConfForCopy} (NOT a clobber — pure additive):
     \`\`\`tmux
     # --- Sisyphus statusbar ---
     set -g status on
     set -g status-style "bg=#1d1e21,fg=#d4cbb8"
     set -g status-position bottom
     set -g status-left "#{E:@sisyphus_left}"
     set -g status-left-length 250
     set -g status-right "#{E:@sisyphus_right}#[fg=#2d2f33]#[bg=#2d2f33,fg=#b0a898] %H:%M "
     set -g status-right-length 250
     set -g status-interval 2
     set -g window-status-format ""
     set -g window-status-current-format ""
     set -g window-status-separator ""
     \`\`\`
     ${r.userConf.path === null ? `Note: no tmux config exists yet. Create ${userConfForCopy} with these lines.` : ''}

  2. **Minimal sisyphus pill on the right.** If they want to keep the stock left side and just add a single sisyphus pill on the right:
     \`\`\`tmux
     set -g status-right "#{E:@sisyphus_right}#[default] %H:%M "
     set -g status-right-length 200
     \`\`\`

After appending, run \`tmux source-file ${userConfForCopy}\` so the change takes effect immediately.

### Path D — User has a custom statusbar (state: custom-no-sisyphus)
**Trigger:** status-left/right are user-customized but don't reference sisyphus tokens.
**Action:** ${r.state === 'custom-no-sisyphus' ? '✓ THIS IS YOUR PATH.' : '(not applicable)'}

This is the most delicate case — they care enough to have customized their bar. **Do not overwrite.** Show them the current contents and offer additive integration:

Their current right side is currently:
  \`\`\`
  ${r.tmuxOptions.statusRight === null ? '(unset)' : r.tmuxOptions.statusRight}
  \`\`\`
And left side:
  \`\`\`
  ${r.tmuxOptions.statusLeft === null ? '(unset)' : r.tmuxOptions.statusLeft}
  \`\`\`

Offer three integration patterns and let the user pick:

  1. **Append sisyphus to the right side** (most common — leaves their left alone):
     \`\`\`tmux
     set -g status-right "${r.tmuxOptions.statusRight === null ? '' : r.tmuxOptions.statusRight}#{E:@sisyphus_right}"
     \`\`\`
     Or prepend it (sisyphus content appears first/leftmost):
     \`\`\`tmux
     set -g status-right "#{E:@sisyphus_right}${r.tmuxOptions.statusRight === null ? '' : r.tmuxOptions.statusRight}"
     \`\`\`

  2. **Append to the left side** (if they want session/windows pills at the start):
     \`\`\`tmux
     set -g status-left "${r.tmuxOptions.statusLeft === null ? '' : r.tmuxOptions.statusLeft}#{E:@sisyphus_left}"
     \`\`\`

  3. **Slim sisyphus only.** If they only want one specific signal (e.g., just sisyphus-sessions), they can set \`statusBar.right: ["sisyphus-sessions"]\` in \`~/.sisyphus/config.json\` and then append \`#{E:@sisyphus_right}\` to their existing right side. The composed string will only contain that one segment.

Important: the user's existing string may include format conditionals or special characters; use the exact value above when proposing the snippet (do not retype). Confirm with the user before editing ${userConfForCopy} — present the diff first.

### Path E — Statusbar is disabled (state: disabled)
**Trigger:** \`set -g status off\`.
**Action:** ${r.state === 'disabled' ? '✓ THIS IS YOUR PATH.' : '(not applicable)'}

The user explicitly turned off the statusbar. Don't enable it without asking. Suggest:
  - "I noticed you have the statusbar disabled (\`set -g status off\` in your config). Sisyphus needs it on to show session state. Want me to enable it and add a minimal sisyphus pill, or leave it as-is?"

If they say yes → fall through to Path C, option 2 (minimal pill).

### Path F — tmux not ready (state: tmux-not-ready)
**Trigger:** tmux isn't installed or no server is running.
**Action:** ${r.state === 'tmux-not-ready' ? '✓ THIS IS YOUR PATH.' : '(not applicable)'}

Don't propose statusbar changes yet:
  - tmuxInstalled=false → install tmux first (\`brew install tmux\` on macOS)
  - tmuxServerRunning=false → user needs to run \`tmux\` (or attach to a session)

Re-run \`sis admin check check-statusbar\` once tmux is up.

## Daemon reminder
Even with status-left/right perfectly wired, the bar will show literal \`#{E:@sisyphus_left}\` (rendered as empty) until the daemon is running and has populated the option at least once. Always end this flow by checking \`daemonRunning: true\` above; if false, run \`sisyphusd start\` (or \`sisyphusd restart\` if it's stuck).

## After acting
Re-run \`sis admin check check-statusbar\` to verify the new state. If anything looks wrong, the JSON form (\`sis admin check check-statusbar --json\`) is easier to diff against expected values.
</claude-instructions>
`);
}

export function registerCheckStatusbar(program: Command): void {
  program
    .command('check-statusbar')
    .description('Inspect tmux statusbar state and emit a Claude decision tree for non-clobbering integration')
    .addHelpText(
      'after',
      `
check-statusbar: inspect tmux statusbar state and emit an agent decision tree for non-clobbering integration.

Input
  (no options)

Output (stdout, plain text — agent decision tree embedded in <claude-instructions> tags; not a JSON envelope)
  Environment data snapshot (tmux install/server state, daemon state, live status-left/right values,
  user conf state, sisyphus config summary).
  Decision tree (Paths A–F) indicating how to integrate or configure the sisyphus statusbar.

Effects
  Read-only: probes tmux options, reads ~/.tmux.conf and ~/.sisyphus/config.json. No writes.

Exit codes: 0 ok`,
    )
    .action(() => {
      const result = runCheck();
      printInstructions(result);
    });
}
