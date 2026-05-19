import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import {
  DEFAULT_CYCLE_KEY,
  DEFAULT_PREFIX_KEY,
  getExistingBinding,
  isSisyphusBinding,
  sisyphusTmuxConfPath,
  tmuxVersionAtLeast,
  userTmuxConfPath,
} from '../tmux-setup.js';

type KeyState =
  | { kind: 'sisyphus'; binding: string }
  | { kind: 'conflict'; binding: string }
  | { kind: 'unbound' };

interface CheckResult {
  tmuxInstalled: boolean;
  tmuxServerRunning: boolean;
  tmuxVersion: string | null;
  tmuxVersionOk: boolean;
  inTmux: boolean;
  cycleKey: { key: string } & KeyState;
  prefixKey: { key: string } & KeyState;
  // tmux's *prefix* setting (set -g prefix). Hidden conflict: if user set prefix to C-s,
  // a root-table bind on C-s would silently shadow it.
  tmuxPrefix: string | null;
  prefixCollision: boolean;
  userConfPath: string | null;
  userConfAlreadySources: boolean;
  sisyphusConfPath: string;
}

function isTmuxInstalled(): boolean {
  try {
    execSync('which tmux', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function getTmuxVersion(): string | null {
  try {
    return execSync('tmux -V', { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
  } catch {
    return null;
  }
}

function isTmuxServerRunning(): boolean {
  try {
    // `tmux list-sessions` errors with "no server running" when no server is up
    execSync('tmux list-sessions', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function getTmuxPrefix(): string | null {
  try {
    return execSync('tmux show-options -gv prefix', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim() || null;
  } catch {
    return null;
  }
}

function classifyKey(key: string, serverRunning: boolean): KeyState {
  if (!serverRunning) return { kind: 'unbound' };
  const binding = getExistingBinding(key);
  if (binding === null) return { kind: 'unbound' };
  if (isSisyphusBinding(binding)) return { kind: 'sisyphus', binding };
  return { kind: 'conflict', binding };
}

function runCheck(): CheckResult {
  const tmuxInstalled = isTmuxInstalled();
  const tmuxVersion = tmuxInstalled ? getTmuxVersion() : null;
  const tmuxVersionOk = tmuxInstalled ? tmuxVersionAtLeast(3, 2) : false;
  const tmuxServerRunning = tmuxInstalled ? isTmuxServerRunning() : false;
  const inTmux = !!process.env['TMUX'];
  const cycleKey = { key: DEFAULT_CYCLE_KEY, ...classifyKey(DEFAULT_CYCLE_KEY, tmuxServerRunning) };
  const prefixKey = { key: DEFAULT_PREFIX_KEY, ...classifyKey(DEFAULT_PREFIX_KEY, tmuxServerRunning) };
  const tmuxPrefix = tmuxServerRunning ? getTmuxPrefix() : null;
  const prefixCollision = tmuxPrefix !== null && tmuxPrefix === DEFAULT_PREFIX_KEY;

  const sisyphusConfPath = sisyphusTmuxConfPath();
  const userConfPath = userTmuxConfPath();
  let userConfAlreadySources = false;
  if (userConfPath !== null) {
    try {
      userConfAlreadySources = readFileSync(userConfPath, 'utf-8').includes(sisyphusConfPath);
    } catch {
      /* unreadable conf — treat as not-sourcing */
    }
  }

  return {
    tmuxInstalled,
    tmuxServerRunning,
    tmuxVersion,
    tmuxVersionOk,
    inTmux,
    cycleKey,
    prefixKey,
    tmuxPrefix,
    prefixCollision,
    userConfPath,
    userConfAlreadySources,
    sisyphusConfPath,
  };
}

function fmtKeyState(k: { key: string } & KeyState): string {
  switch (k.kind) {
    case 'sisyphus':
      return `${k.key}: sisyphus (${k.binding})`;
    case 'conflict':
      return `${k.key}: CONFLICT — already bound: ${k.binding}`;
    case 'unbound':
      return `${k.key}: unbound`;
  }
}

function printInstructions(r: CheckResult): void {
  const bothSisyphus = r.cycleKey.kind === 'sisyphus' && r.prefixKey.kind === 'sisyphus';
  const anyConflict = r.cycleKey.kind === 'conflict' || r.prefixKey.kind === 'conflict';
  const wouldModifyUserConf = r.userConfPath !== null && !r.userConfAlreadySources;
  const safeAutoInstall = !anyConflict && !r.prefixCollision && !wouldModifyUserConf;

  const tmuxVersionLabel = r.tmuxVersion === null ? '(none)' : r.tmuxVersion;
  const tmuxPrefixLabel = r.tmuxPrefix === null ? '(default C-b)' : r.tmuxPrefix;
  const userConfLabel = r.userConfPath === null ? '(none found)' : r.userConfPath;
  const userConfForCopy = r.userConfPath === null ? '~/.tmux.conf' : r.userConfPath;

  console.log(`
<claude-instructions>
# Sisyphus Keybind Precheck

Run this BEFORE asking the user to try any sisyphus keybind (e.g. \`Right Option+s\`,
\`C-s h\`, \`C-s ?\`). If the keybinds aren't actually wired up, the user will press
the key and nothing will happen — confusing, looks broken.

## Environment Data
- tmuxInstalled: ${r.tmuxInstalled}
- tmuxVersion: ${tmuxVersionLabel}
- tmuxVersionOk: ${r.tmuxVersionOk}  (sisyphus needs 3.2+ for display-menu)
- tmuxServerRunning: ${r.tmuxServerRunning}
- inTmux (\$TMUX set): ${r.inTmux}
- ${fmtKeyState(r.cycleKey)}
- ${fmtKeyState(r.prefixKey)}
- tmuxPrefix (\`set -g prefix\`): ${tmuxPrefixLabel}
- prefixCollision: ${r.prefixCollision}  (true = user's tmux prefix is ${DEFAULT_PREFIX_KEY}; binding it in root would shadow it)
- userConfPath: ${userConfLabel}
- userConfAlreadySources: ${r.userConfAlreadySources}
- sisyphusConfPath: ${r.sisyphusConfPath}

## Decision

Pick exactly one path. Do NOT proceed past this check until both keys read "sisyphus".

### Path A — All wired, proceed
**Trigger:** cycleKey is "sisyphus" AND prefixKey is "sisyphus".
**Action:** ${bothSisyphus ? '✓ THIS IS YOUR PATH.' : '(not applicable)'} Confirm briefly and continue with the onboarding step that needs keybinds.

### Path B — Safe to auto-install
**Trigger:** No conflicts, no prefix collision, AND (no user tmux.conf OR it already sources sisyphus).
**Action:** ${safeAutoInstall && !bothSisyphus ? '✓ THIS IS YOUR PATH.' : '(not applicable)'} Run:
\`\`\`
sis admin install setup-keybind --yes
\`\`\`
This installs the helper scripts in ~/.sisyphus/bin/ and applies the bindings to the live
tmux server. No user files are clobbered (none to clobber, or already wired).

### Path C — Would append a line to the user's tmux.conf
**Trigger:** No conflicts, no prefix collision, but ${userConfForCopy} exists and doesn't yet source ${r.sisyphusConfPath}.
**Action:** ${!safeAutoInstall && !anyConflict && !r.prefixCollision && wouldModifyUserConf && !bothSisyphus ? '✓ THIS IS YOUR PATH.' : '(not applicable)'} Ask the user to choose:

  1. **Persistent (recommended).** "I'll add one line to ${userConfForCopy} so the bindings survive tmux restarts. The line is marked \`# sisyphus-managed — do not edit\` and is grep-removable later."
     Run: \`sis admin install setup-keybind --yes\`

  2. **Live only, no file changes.** "I'll wire the bindings into your current tmux server without touching any config file. They'll vanish when you restart tmux, and you can re-run \`sis admin install setup-keybind\` anytime to make them stick."
     Run: \`sis admin install setup-keybind\` (no --yes; non-TTY auto-declines the conf prompt while still applying live bindings + installing helper scripts)

### Path D — Conflict on ${DEFAULT_CYCLE_KEY} or ${DEFAULT_PREFIX_KEY}
**Trigger:** cycleKey or prefixKey is "CONFLICT".
**Action:** ${anyConflict ? '✓ THIS IS YOUR PATH.' : '(not applicable)'} The user already has these keys bound to something else. Show them the conflicting bindings (above) and offer:

  1. **Pick alternate keys.** Re-run with a different cycle key — e.g. \`M-S\`, \`M-w\`, \`M-j\`, \`M-\\\`\`:
     \`\`\`
     sis admin install setup-keybind M-w
     \`\`\`
     This still uses C-s for the prefix; if the prefix also conflicts, you'll need to wire
     directly (option 3 below), since setup-keybind only takes a custom cycle key.

  2. **Skip keybinds entirely.** The user can drive sisyphus from the CLI: \`sis ui dashboard\`,
     \`sis session inspect status\`, \`sis session lifecycle start\`, \`sis session lifecycle resume\`. Lose tmux quick-actions, keep
     existing bindings.

  3. **Wire commands directly (advanced).** Bypass setup-keybind and bind individual
     sisyphus actions to keys the user picks. Helper scripts must already exist — if
     ~/.sisyphus/bin/sisyphus-cycle is missing, you cannot use this path until setup-keybind
     has run at least once successfully (try option 1 first).
     \`\`\`
     # cycle sessions on a key the user chooses (replace M-w):
     tmux bind-key -T root M-w run-shell "$HOME/.sisyphus/bin/sisyphus-cycle"

     # open the dashboard directly on a key (replace M-h):
     tmux bind-key -T root M-h run-shell "$HOME/.sisyphus/bin/sisyphus-home"
     \`\`\`
     These apply only to the running tmux server. To persist, append the same lines to
     ${userConfForCopy}.

### Path E — Hidden prefix collision
**Trigger:** prefixCollision is true (the user's \`set -g prefix\` is already ${DEFAULT_PREFIX_KEY}).
**Action:** ${r.prefixCollision ? '✓ THIS IS YOUR PATH.' : '(not applicable)'} \`tmux list-keys\` won't surface this as a binding conflict, but installing the C-s root-table menu would shadow the user's prefix. Tell the user:

  > "Your tmux prefix is set to ${DEFAULT_PREFIX_KEY}. Sisyphus wants to bind ${DEFAULT_PREFIX_KEY} in the root table for its menu, which would shadow your prefix. Options: (a) move your prefix (e.g. \`set -g prefix C-a\`) and let sisyphus take ${DEFAULT_PREFIX_KEY}, or (b) skip the menu binding — only \`${DEFAULT_CYCLE_KEY}\` cycle gets installed."

  For (b), wire just the cycle key directly:
  \`\`\`
  sis admin install setup-keybind ${DEFAULT_CYCLE_KEY}
  # then unbind C-s if setup-keybind ended up taking it:
  tmux unbind-key -T root ${DEFAULT_PREFIX_KEY}
  \`\`\`

### Path F — tmux not ready
**Trigger:** any of: tmuxInstalled=false, tmuxVersionOk=false, tmuxServerRunning=false.
**Action:** ${(!r.tmuxInstalled || !r.tmuxVersionOk || !r.tmuxServerRunning) ? '✓ THIS IS YOUR PATH.' : '(not applicable)'} Don't install keybinds yet. Fix the precondition:
- tmuxInstalled=false → \`brew install tmux\` (macOS) or your package manager
- tmuxVersionOk=false → upgrade tmux to 3.2+
- tmuxServerRunning=false → user needs to run \`tmux\` (or attach to an existing session) before live bindings can be installed or tested

After fixing, re-run \`sis admin check check-keybinds\`.

## After acting
Re-run \`sis admin check check-keybinds\` to confirm both keys read "sisyphus", THEN ask the
user to try the keybind. Don't skip the verification — \`setup-keybind\` can fail silently
if the tmux server dies between commands.
</claude-instructions>
`);
}

export function registerCheckKeybinds(program: Command): void {
  program
    .command('check-keybinds')
    .description('Verify tmux keybind state before asking the user to try a sisyphus keybind')
    .addHelpText(
      'after',
      `
check-keybinds: verify tmux keybind state before asking the user to try a sisyphus keybind.

Input
  (no options)

Output (stdout, plain text — agent decision tree embedded in <claude-instructions> tags; not a JSON envelope)
  Environment data snapshot (tmux version, server state, key binding status for cycle + prefix keys).
  Decision tree (Paths A–F) indicating which setup action to take based on the data.

Effects
  Read-only: probes tmux state and reads ~/.tmux.conf. No writes.

Exit codes: 0 ok`,
    )
    .action(() => {
      const result = runCheck();
      printInstructions(result);
    });
}
