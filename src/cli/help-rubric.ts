import type { Command } from 'commander';

/**
 * Walk cmd.parent to the root, collect .name(), reverse, drop the root ("sis"),
 * join with single spaces.
 *
 * Examples:
 *   `start` under `lifecycle` under `session` → "session lifecycle start"
 *   `session` (direct child of root)          → "session"
 */
export function commandPath(cmd: Command): string {
  const parts: string[] = [];
  let cur: Command | null = cmd;
  while (cur !== null) {
    parts.push(cur.name());
    cur = cur.parent as Command | null;
  }
  parts.reverse();
  // Drop the root name ("sis")
  parts.shift();
  return parts.join(' ');
}

export const RUBRICS: Record<string, { short: string; useWhen: string }> = {
  'session': { short: 'Manage tracked orchestration sessions', useWhen: 'acting on a unit of orchestrated work' },
  'agent': { short: 'Operate on worker agents', useWhen: 'directing or reading a spawned agent' },
  'orch': { short: 'Talk to / steer the orchestrator', useWhen: "guiding the session's orchestrator" },
  'ask': { short: 'Human-in-the-loop question I/O', useWhen: 'answering or polling a blocking ask' },
  'ui': { short: 'Interactive surfaces', useWhen: 'a human wants the dashboard, guide, or scratch' },
  'segment': { short: 'Status-line segment registration', useWhen: 'wiring tmux status indicators' },
  'admin': { short: 'Install, verify, and report', useWhen: 'setting up or diagnosing the install' },
  'companion': { short: 'Companion-pane helper', useWhen: 'driving the companion Claude pane' },
  'deploy': { short: 'Provision cloud boxes (Terraform)', useWhen: 'standing up or tearing down infra' },
  'cloud': { short: 'Per-repo workflow on a deployed box', useWhen: 'syncing work to/from the box' },
  'feedback': { short: 'Report a problem with sisyphus itself', useWhen: 'the user complains about the tool or workflow' },

  'session lifecycle': { short: 'Start/stop/advance a session', useWhen: 'changing whether a session runs' },
  'session inspect': { short: 'Read session state', useWhen: 'you need status/history/context without mutating' },
  'session config': { short: "Change a session's settings", useWhen: 'adjusting task, effort, or dangerous mode' },
  'session recover': { short: 'Repair or relocate a session', useWhen: 'a session is stuck, lost, or needs rollback' },
  'session scratch': { short: 'Open a standalone (non-sisyphus) Claude', useWhen: 'you want a throwaway Claude in this repo' },

  'session lifecycle start': { short: 'Start a new session', useWhen: 'beginning work on a new task' },
  'session lifecycle complete': { short: 'Mark the current cycle complete', useWhen: 'the orchestrator finished its work' },
  'session lifecycle continue': { short: 'Continue past completion into a new cycle', useWhen: 'more work follows completion' },
  'session lifecycle resume': { short: 'Resume a paused/handed-off session', useWhen: 'bringing a stopped session back' },
  'session lifecycle kill': { short: 'Stop a session, keep its state', useWhen: 'halting work but preserving the record' },
  'session lifecycle delete': { short: 'Remove a session and its state', useWhen: 'discarding a session permanently' },

  'session inspect status': { short: 'Show live session status', useWhen: 'checking what is running now' },
  'session inspect list': { short: 'List sessions', useWhen: 'enumerating sessions in this repo' },
  'session inspect history': { short: 'Show past sessions/cycles', useWhen: 'reviewing prior runs' },
  'session inspect context': { short: "Print the orchestrator's context", useWhen: 'auditing what the orchestrator sees' },
  'session inspect export': { short: 'Export session transcript/state', useWhen: 'archiving or sharing a session' },
  'session inspect requirements': { short: 'Show/export the session requirements', useWhen: 'reviewing the locked requirements doc' },

  'session config task': { short: "Set the session's task text", useWhen: 'retargeting what the session works on' },
  'session config effort': { short: 'Set the effort tier', useWhen: 'tuning model effort for a session' },
  'session config dangerous': { short: 'Toggle dangerous (skip-permissions) mode', useWhen: 'allowing unattended tool use' },

  'session recover rollback': { short: 'Roll back to an earlier cycle', useWhen: 'a cycle went wrong' },
  'session recover reconnect': { short: 'Reattach the daemon to a live session', useWhen: 'the tmux/daemon link dropped' },
  'session recover quiesce': { short: 'Pause a session at the next safe point', useWhen: 'you need it to stop cleanly' },
  'session recover clone': { short: 'Clone a session toward a new goal', useWhen: 'forking work from an existing session' },

  'agent spawn': { short: 'Spawn a worker agent', useWhen: 'delegating a scoped sub-task' },
  'agent submit': { short: "Submit this agent's result upstream", useWhen: "from inside an agent, its work is done" },
  'agent report': { short: 'Post a progress report', useWhen: 'from inside an agent, updating mid-task' },
  'agent await': { short: 'Block until a spawned agent submits', useWhen: "you need an agent's result before continuing" },
  'agent ctl': { short: 'Agent process control', useWhen: 'killing or restarting an agent process' },
  'agent io': { short: 'Agent message I/O', useWhen: 'sending text to or reading an agent' },

  'agent ctl kill': { short: 'Kill an agent', useWhen: 'an agent must stop immediately' },
  'agent ctl restart': { short: 'Restart an agent', useWhen: 'an agent is wedged and should start over' },

  'agent io tell': { short: 'Send text to an agent', useWhen: 'injecting instructions into a running agent' },
  'agent io read': { short: "Read an agent's transcript", useWhen: 'inspecting what an agent produced' },

  'orch yield': { short: 'Yield control back to the human/parent', useWhen: 'the orchestrator is done or blocked' },
  'orch tell': { short: 'Send text to the orchestrator', useWhen: 'injecting guidance into the orchestrator' },
  'orch message': { short: 'Queue a message for the orchestrator', useWhen: 'leaving async input for the next turn' },
  'orch read': { short: "Read the orchestrator's transcript", useWhen: 'inspecting orchestrator output' },

  'ask submit': { short: 'Submit an ask deck for a human', useWhen: 'an agent needs a human decision' },
  'ask poll': { short: "Block until an ask is answered", useWhen: "you need the human's answer before continuing" },
  'ask peek': { short: "Read an ask's state without blocking", useWhen: 'checking ask status non-blocking' },

  'ui dashboard': { short: 'Open the TUI dashboard', useWhen: 'a human wants the monitoring UI' },
  'ui guide': { short: 'Print the full usage guide', useWhen: 'a human needs end-to-end docs' },

  'segment register': { short: 'Register a status-line segment', useWhen: 'adding a tmux status indicator' },
  'segment unregister': { short: 'Remove a status-line segment', useWhen: 'tearing one down' },

  'admin install': { short: 'Install / uninstall sisyphus bits', useWhen: 'first setup or removal' },
  'admin check': { short: 'Verify the installation', useWhen: 'diagnosing a broken or partial install' },
  'admin report': { short: 'Diagnostics & telemetry', useWhen: 'filing a bug or uploading session data' },

  'admin install setup': { short: 'Run first-time setup', useWhen: 'installing sisyphus on this machine' },
  'admin install setup-keybind': { short: 'Install the tmux keybind', useWhen: 'wiring the dashboard hotkey' },
  'admin install init': { short: 'Initialize repo-local config', useWhen: 'onboarding a new repo' },
  'admin install uninstall': { short: 'Remove sisyphus', useWhen: 'fully removing the install' },

  'admin check doctor': { short: 'Run install diagnostics', useWhen: 'something is not working and you want a health check' },
  'admin check check-keybinds': { short: 'Verify tmux keybinds', useWhen: 'the dashboard hotkey does not fire' },
  'admin check check-statusbar': { short: 'Verify status-line wiring', useWhen: 'status segments do not render' },

  'admin report bug': { short: 'File a bug report', useWhen: 'reporting a defect with context' },
  'admin report upload': { short: 'Upload session data', useWhen: 'sharing a session for support' },
  'admin report configure-upload': { short: 'Configure the upload target', useWhen: 'setting where uploads go' },

  'admin clean-zombies': { short: 'Sweep stale zombie processes', useWhen: 'cleaning up after a crashed daemon or hung agent' },

  'cloud box': { short: 'Provision / operate the box for this repo', useWhen: 'working with the box-side environment' },
  'cloud handoff': { short: 'Move a session between local and box', useWhen: 'relocating in-flight work' },

  'cloud box sync': { short: 'Rsync this repo to the box', useWhen: 'pushing local code to the box' },
  'cloud box install': { short: 'Run the package install on the box', useWhen: 'box deps are missing/stale' },
  'cloud box session': { short: 'Create/refresh the box tmux home', useWhen: 'the box-side session is absent' },
  'cloud box attach': { short: 'Attach to the box session', useWhen: 'you want to work on the box interactively' },
  'cloud box status': { short: 'Print box-side status', useWhen: 'checking box state for this repo' },
  'cloud box login': { short: 'Run claude auth login on the box', useWhen: 'the box needs Claude credentials' },
  'cloud box up': { short: 'Sync+install+session in one shot', useWhen: 'bringing the box up from cold' },

  'cloud handoff push': { short: 'Hand a live session off to the box', useWhen: 'moving local work to the cloud' },
  'cloud handoff pull': { short: 'Reclaim a handed-off session locally', useWhen: 'bringing cloud work back home' },

  'agent types': { short: 'Agent-type catalog', useWhen: 'discovering installable agent types' },
  'agent types list': { short: 'List agent types', useWhen: 'enumerating spawnable agent types' },
  'deploy list': { short: 'List deploy providers', useWhen: 'discovering supported providers' },
  'companion profile': { short: 'Print companion profile', useWhen: 'reading the combined memory + context + badges blob' },

  'companion memory': { short: 'Show accumulated companion observations', useWhen: 'reviewing what the companion noticed' },
  'companion context': { short: 'Emit per-prompt companion context', useWhen: 'the companion plugin hook needs context' },
  'companion pane': { short: 'Open/focus the side claude pane', useWhen: 'you want the companion pane by the dashboard' },
  'companion popup-test': { short: 'Show a test commentary popup', useWhen: 'validating feedback-key handling' },

  'deploy auth': { short: 'Configure provider auth', useWhen: 'setting up Tailscale/provider credentials' },
  'deploy hetzner': { short: 'Hetzner box lifecycle', useWhen: 'targeting Hetzner' },
  'deploy aws': { short: 'AWS box lifecycle', useWhen: 'targeting AWS' },

  'deploy auth tailscale': { short: 'Configure Tailscale OAuth', useWhen: 'joining the box to your tailnet' },

  'deploy * up': { short: 'Provision the box', useWhen: 'standing the box up' },
  'deploy * down': { short: 'Destroy the box', useWhen: 'tearing the box down' },
  'deploy * status': { short: 'Print box outputs', useWhen: 'checking IP/cost/instance' },
  'deploy * ssh': { short: 'SSH/mosh into the box', useWhen: 'getting a shell on the box' },
  'deploy * logs': { short: 'Tail cloud-init + daemon logs', useWhen: 'diagnosing a box-side failure' },
  'deploy * update': { short: 'Upgrade sisyphus on the box', useWhen: 'pulling the latest daemon onto the box' },
};

/**
 * Returns the rubric string for a subcommand, formatted for Commander's
 * subcommandDescription slot. Mirrors Commander's default fallback
 * (node_modules/commander/lib/help.js:313-315).
 */
export function subcommandRubric(cmd: Command): string {
  if (cmd.name() === 'help') {
    return cmd.summary() || cmd.description();
  }

  const p = commandPath(cmd);
  let key = p;

  const deployProviderMatch = p.match(/^deploy (hetzner|aws) (.+)$/);
  if (deployProviderMatch) {
    key = `deploy * ${deployProviderMatch[2]}`;
  }

  const r = RUBRICS[key];
  if (r) {
    return `${r.short}  | use when ${r.useWhen}`;
  }

  return cmd.summary() || cmd.description();
}

export const CONCEPTS_BLOCK: string = `
Concepts
  session       a tracked unit of orchestrated work on one task
  agent         a worker Claude spawned to execute a scoped sub-task
  orchestrator  the Claude that owns a session: decomposes, spawns, advances
  cycle         one discovery→plan→implement→validate iteration; the rollback unit
  ask           a blocking question surfaced for a human to answer
  mode          the session's current phase, driving orchestrator behavior
`;

/**
 * Root-only help footer: the full exit-code enum + JSON error envelope. This is
 * reference material for CLI scripters that belongs on the human-facing `sis -h`,
 * but is noise inside an LLM prompt. `injectHelp()` strips it from the injected
 * root overview; `index.ts` prints it via `addHelpText('after', ...)`. Shared so
 * the strip stays in sync with what's actually printed.
 */
export const ROOT_AFTER_HELP: string = `
I/O contract: flags and positional args on input, JSON on stdout (JSONL for streams).

Exit codes:
  0   success
  1   permanent error (fallback)
  2   usage error (bad args/shape)
  3   not found
  4   ambiguous (multiple matches — see error.candidates)
  5   conflict (already-exists, wrong-state)
  60  transient (retry-safe: daemon down, timeout, lock contention)

Errors:
  {"ok": false,
   "error": {"code": "<stable-enum>", "kind": "<usage|not_found|ambiguous|conflict|transient|permanent>",
             "message": "...", "received"?: ..., "expected"?: ..., "next"?: "...", "candidates"?: [...]}}
`;
