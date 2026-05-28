```
╔═══════════════════════════════════════════════════════╗
║ @@@@@@@@@@@@@@@@@@@@@@@@@@@%%%#*++**#%%@@@@@@@@@@@@@@ ║
║ @@@@@@@@@@@@@@@@@@@@@@@@%*====-----::::-:=%@@@@@@@@@@ ║
║ @@@@@@@@@@@@@@@@@@@@@%#=:.:-=------:...    -%@@@@@@@@ ║
║ @@@@@@@@@@@@@@@@@@%%#= .....:-:..........    *%@@@@@@ ║
║ @@@@@@@@@@@@@@%+==-+%*:  .:---::::....:....   #@@@@@@ ║
║ @@@@@@@@@@@@%#:. ..:.    ..:-...:.....    .  :%@@@@@@ ║
║ @@@@@@@@@@@@#:.:..  :*= ............       . :%@@@@@@ ║
║ @@@@@@@@@@@@#--:..   -%+............... ..   *%#=-:.: ║
║ @@@@@@@@@@%#----.:#%+.::::...       .....    .... .:# ║
║ @@@@@@@@%+-:::.. :%@@@@@@@@%*=:                 ..*%@ ║
║ @@@@@@%*-=:..::.:-..+@@@@@@%%#=:.   ..   . ...   *@@@ ║
║ @@@@#==::%@@@@@@%=:::=%*-:.     ....  .   ...  :%@@@@ ║
║ @@#::=#@@@@%#-.:-...    .::...               :#%@@@@@ ║
║ %=:%%%#####+:.:     .    .....    .  .      *%@@@@@@@ ║
║ :::.:.:::..::.        .                 ..  :#@@@@@@@ ║
║ %#*++===--============++===-::::::::---=====#%@@@@@@@ ║
║    _____ _____ _______   _______ _   _ _   _ _____    ║
║   /  ___|_   _/  ___\ \ / / ___ \ | | | | | /  ___|   ║
║   \ `--.  | | \ `--. \ V /| |_/ / |_| | | | \ `--.    ║
║    `--. \ | |  `--. \ \ / |  __/|  _  | | | |`--. \   ║
║   /\__/ /_| |_/\__/ / | | | |   | | | | |_| /\__/ /   ║
║   \____/ \___/\____/  \_/ \_|   \_| |_/\___/\____/    ║
╚═══════════════════════════════════════════════════════╝
```

# sisyphus

A tmux-integrated orchestration daemon for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) multi-agent workflows.

## What this is

Sisyphus runs multiple Claude Code instances in tmux panes and coordinates them. That's it. Every agent is a real `claude` process with full access to your codebase, your CLAUDE.md, your hooks. Sisyphus just handles the "run N of them in parallel and loop until done" part.

If you know the [Ralph Wiggum loop](https://ghuntley.com/ralph/) (`while true; do claude --prompt task.md; done`), this is that idea taken further. Instead of one agent in a loop, an orchestrator decomposes work into parallel agents, each looping independently, with structured state that persists across cycles. The orchestrator itself is in a Ralph loop: plan, spawn agents, get killed, respawn fresh with all the results.

## How it works

Most hard tasks aren't hard because any single piece is difficult. They're hard because there are many pieces and context gets lost between them. You're working a 12-file refactor, you hold it all in your head until you don't, and you make a mistake three files from the end because you forgot a constraint from the beginning.

The fix is structural. An orchestrator Claude instance reads the full task, breaks it into subtasks, and spawns parallel agent instances, each in its own tmux pane with a focused instruction. Agents work simultaneously and submit reports when done. Then the orchestrator respawns to review progress and plan the next round.

The trick: the orchestrator is stateless. After it spawns agents and yields, it gets killed. When all agents finish, the daemon respawns a fresh orchestrator with the complete session state (every agent report, every cycle's history, the running plan). Cycle 1 and cycle 15 get the same quality of reasoning because each one starts with a full context window and a clean slate. The boulder rolls back down; Sisyphus walks back down after it, picks it up, and pushes again. But this time he remembers everything from every previous push.

The daemon handles lifecycle: spawning panes, detecting when agents finish, persisting state to disk, respawning the orchestrator.

## Requirements

- Node.js >= 22
- tmux >= 3.2 (you must be inside a tmux session)
- Claude Code CLI (`claude`) installed and authenticated
- Neovim (optional, enables embedded editor in the dashboard)

## Install

```bash
npm install -g sisyphi
```

Then run setup once:

```bash
sis admin setup
```

This installs the background daemon (macOS launchd), tmux keybindings (`M-s` to cycle sessions, `M-S` for dashboard), and checks your environment. The daemon auto-updates when new versions are published.

Verify:

```bash
sis admin doctor
```

## Quick start

```bash
sis session start "your task description"    # Start a session
sis ui dashboard                             # Open the TUI (auto-opens on start)
sis session status                           # Check session state from the CLI
```

Sisyphus is a CLI that Claude Code calls for you. Tell Claude to use it and it handles the rest.

In Claude Code, say something like:

> Use sisyphus to migrate our REST API from Express to Hono. The API lives in src/api/ with 14 route files...

Claude calls `sis session start` with a detailed task description, and tmux panes start appearing with parallel agents working on your codebase.

### Slash command (recommended)

Create `.claude/commands/sisyphus-begin.md` in your project:

~~~markdown
Run `sis session start` with a detailed task description:

```bash
sis session start "your task description"
```

Write a thorough task description. Include what needs to be built or fixed, where relevant code lives, what done looks like, constraints, and adjacent concerns (don't break X, keep Y working). More context produces better results. The orchestrator figures out how to break it down.

Example:
```bash
sis session start "Rip out our hand-rolled RBAC system and replace it with a proper policy engine. Current implementation is scattered across 20+ middleware files in src/middleware/auth/ that each do their own role checks with hardcoded string comparisons. Replace with a centralized policy engine in src/auth/policies/ using a declarative permission model — define resources, actions, and role mappings in a single config, then write one middleware that evaluates policies. Migrate every route that currently calls requireRole() or checkPermission() to the new system. The admin panel (src/routes/admin/) has the most complex rules including org-scoped permissions and delegated access — those need to work exactly as before. Add integration tests that cover the full matrix: superadmin, org-admin, member, and guest across every protected endpoint. Don't break the public API routes in src/routes/v1/public/. The existing test suite (npm test) must pass when you're done."
```
~~~

Then type `/sisyphus-begin` followed by your task in Claude Code.

Or just add a note to your `CLAUDE.md`:

```markdown
## Sisyphus
For large tasks, use the `sis` CLI to orchestrate parallel agents.
Run `sis session start "detailed task description"` inside tmux.
```

### Interactive tutorial

New to tmux or sisyphus? Run the guided walkthrough:

```bash
sis ui guide
```

Covers tmux basics, neovim essentials, sisyphus concepts, and a live demo session.

## Dashboard

Full-screen TUI for watching and controlling sessions.

```bash
sis ui dashboard    # or press M-S (Alt-Shift-S)
```

Auto-opens when you `sis session start`.

Left panel is a session tree (sessions, cycles, agents, reports) with status indicators. Right panel shows detail for whatever's selected: roadmap, agent instructions, report content, live pane output. If neovim is available, files open in an embedded editor. Bottom bar has mode and keybinding hints.

Key bindings — navigate mode:

| Key | Action |
|-----|--------|
| `j/k` or `↑/↓` | Navigate tree / scroll detail |
| `h/l` or `←/→` | Collapse/expand nodes |
| `Tab` | Cycle panel focus |
| `Enter` | Open selection |
| `n` | New session (compose mode) |
| `m` | Message orchestrator |
| `R` | Resume a paused/completed session |
| `g` | Edit goal |
| `p` | Open roadmap |
| `r` | Re-run agent |
| `x` | Restart agent |
| `b` | Jump to session's tmux window |
| `w` | Go to session window |
| `o` | Open (file manager) |
| `e` | Edit context file |
| `S` | Session info |
| `F` | Filter / search |
| `D` | Toggle DANGEROUS mode for the selected session (auto-accepts the default for every ask) |
| `c` | Open companion overlay |
| `/` | Search sessions |
| `q` | Quit |
| `?` | Help overlay |

Key bindings — leader mode (`Space` + key):

| Key | Action |
|-----|--------|
| `Space c …` | Copy submenu: `p` path, `i` id, `c` context, `l` logs, `r` report, `a` agent-id |
| `Space o …` | Open submenu: `g` goal, `r` roadmap, `s` strategy, `l` logs, `d` dir, `R` latest report, `c` scratch, `e` context file |
| `Space a …` | Agent submenu: `s` spawn, `m` message, `r` restart, `R` re-run, `j` jump-pane, `o` claude, `t` tail, `k` kill, `e` quick-Explore, `d` quick-Debug |
| `Space S …` | Session submenu: `n` new, `r` resume, `c` continue, `b` rollback, `k` kill, `d` delete, `e` export, `w` window, `C` clone, `i` history |
| `Space g …` | Go submenu: `w` window, `p` pane-picker, `s` session-picker, `n` next session, `r` reconnect |

Compose mode opens a temp file in neovim for multi-line input (new sessions, messages, resume instructions). Falls back to tmux popups without neovim.

## Agent types

Agents can be spawned with role templates that set their model, behavior, and capabilities. The orchestrator discovers available types and matches them to subtasks.

### Built-in types

| Type | Description |
|------|-------------|
| `sisyphus:worker` | Generic agent (default) |
| `sisyphus:plan` | Plan lead, breaks work into phases |
| `sisyphus:spec` | Interactive design + requirements spec session |
| `sisyphus:problem` | Problem exploration and assumption challenging |
| `sisyphus:review` | Code review |
| `sisyphus:review-plan` | Plan review with parallel sub-reviewers |
| `sisyphus:debug` | Systematic debugging investigation |
| `sisyphus:explore` | Lightweight code exploration |
| `sisyphus:operator` | QA/testing with browser automation |
| `sisyphus:test-spec` | Test specification writing |

### Custom agent types

Create a markdown file with YAML frontmatter:

```markdown
---
name: security-reviewer
description: Reviews code for security vulnerabilities
model: opus
color: red
effort: high
skills: [capture]
permissionMode: bypassPermissions
interactive: false
---

You are a security-focused code reviewer. Analyze the code for OWASP top 10
vulnerabilities, injection risks, auth bypasses, and data exposure...
```

Resolution order (first match wins):
1. `.claude/agents/{name}.md` (project-local)
2. `~/.claude/agents/{name}.md` (user-global)
3. Bundled `sisyphus:{name}`
4. Installed Claude Code plugins

### Frontmatter options

| Field | Description |
|-------|-------------|
| `model` | LLM model (`opus`, `sonnet`, `gpt-4`, `codex-mini`, etc.) |
| `color` | Tmux pane border color |
| `effort` | `low` / `medium` / `high` / `max` |
| `interactive` | `true` = agent can pause for user input |
| `skills` | Claude Code skills to enable |
| `permissionMode` | Permission handling mode |

`gpt-` and `codex-` prefixed models automatically route to the OpenAI provider (Codex CLI).

## Tmux integration

### Status bar

The daemon puts a live status indicator in your tmux status bar, scoped to the current working directory:

- Yellow dot: orchestrator processing
- Yellow diamond: agents running
- Green dot: session completed
- Red dot: waiting for input
- Gray: idle / between cycles

Updates every 5 seconds. Focused session is highlighted.

### Keybindings

Installed by `sis admin setup` into `~/.sisyphus/tmux.conf`. Requires tmux ≥ 3.2.

| Key | Action |
|-----|--------|
| `M-s` | Cycle through sisyphus sessions in current project |
| `M-S` | Jump to dashboard window |
| `Ctrl-S` | Open the which-key popup (anchored bottom-right) |
| `prefix-x` | Smart kill: pane or session depending on context |

The which-key popup shows direct actions and submenu prefixes. Press the mnemonic key to fire an action; press a submenu prefix (`c`, `o`, `a`, `S`, `g`) to enter that submenu. Submenus follow the same letter conventions as the dashboard `Space` leader, so muscle memory transfers.

Press `Ctrl-S ?` to see the full reference.

### Native notifications (macOS)

Sisyphus builds a native notification helper (`SisyphusNotify.app`) during install. Notifications fire on session completion, agent crashes, and other lifecycle events. Clicking one switches your terminal to the relevant session.

Falls back to `terminal-notifier` or `osascript` if the native app isn't available.

## Companion

A persistent character that tracks your work across sessions. Earns XP, levels up (30 levels from *Boulder Intern* to *The Absurd Hero*), unlocks achievements, and shifts mood based on usage patterns (time of day, session length, crash frequency, efficiency).

Shows up as a mood-colored face in the tmux status bar, generates commentary on lifecycle events via Haiku, and has 66 unlockable badges.

```bash
sis companion              # View profile, stats, and achievements
sis companion --badges     # Full achievement gallery
sis companion --name Bub   # Rename your companion
```

Press `c` in the dashboard (nav mode) to open the companion overlay.

## Configuration

Project `.sisyphus/config.json` overrides global `~/.sisyphus/config.json`:

```json
{
  "model": "sonnet",
  "orchestratorEffort": "high",
  "agentEffort": "medium",
  "pollIntervalMs": 5000,
  "autoUpdate": true,
  "notifications": {
    "enabled": true,
    "sound": "/System/Library/Sounds/Hero.aiff"
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `model` | *(Claude Code default)* | LLM model for orchestrator and agents |
| `orchestratorEffort` | `high` | Effort level for orchestrator (`low`/`medium`/`high`/`max`) |
| `agentEffort` | `medium` | Effort level for agents |
| `orchestratorPrompt` | *(built-in)* | Path to custom orchestrator system prompt |
| `pollIntervalMs` | `5000` | Daemon poll interval in milliseconds |
| `autoUpdate` | — | Auto-update via npm on new releases |
| `notifications.enabled` | `true` | Desktop notifications on lifecycle events |
| `notifications.sound` | macOS Hero | Notification sound file path |
| `requiredPlugins` | `[devcore]` | Claude Code plugins to auto-install for agents |
| `upload` | — | Worker-proxy upload target — see [Session upload](#session-upload-optional) below |

### Session upload (optional)

On session completion, sisyphus zips the session directory and uploads it to an operator-managed Cloudflare R2 bucket through a Worker proxy — asynchronously, never blocking completion. Use `sis admin upload <id>` to re-run the upload on demand (retry or in-progress sessions). `sis session export` is unchanged; upload is purely additive.

**Token workflow** — the operator mints a per-user token and shares a URL of the form:

```
https://<worker-host>/upload?token=sisyphus_pat_...
```

Run `configure-upload` with that URL to write credentials to `~/.sisyphus/config.json`:

```bash
# Safest — no argv leak:
pbpaste | sis admin report configure-upload --stdin

# Interactive prompt:
sis admin report configure-upload

# Direct argv (triggers a leak warning — token visible via `ps` and shell history):
sis admin report configure-upload "https://<worker-host>/upload?token=sisyphus_pat_..."
```

**Config** — `configure-upload` always writes to `~/.sisyphus/config.json`. The `upload` block is only honored from the global config; a project-local `.sisyphus/config.json` with an `upload` block is ignored with a warning (security hardening — prevents project files from redirecting your uploads).

```json
{
  "upload": {
    "url": "https://<worker-host>",
    "token": "sisyphus_pat_..."
  }
}
```

**Manifest** — the zip includes a `manifest.json` with session metadata. Fields sent on the wire (13 fields):

- `sessionId`, `sisyphusVersion`, `hostname`, `platform`
- `status` (`completed` / `failed` / `cancelled`), `completedAt`, `durationMs`, `wallClockMs`
- `model`, `effortTier` (`low` / `medium` / `high` / `xhigh`)
- `cycleCount`, `agentCount`, `goal`

`userId` is **not sent by the client** — the Worker injects it from the token, so it is opaque to end-users and non-operators.

**Privacy / consent** — presence of `Config.upload` is consent. No upload happens unless the block is configured. The manifest is content-free metadata; the full session zip lands in private R2 owned by the operator.

**State fields** — the session JSON surfaces `uploadStatus` (`pending` / `uploaded` / `failed`), `uploadKey` (e.g. `users/{userId}/{sessionId}.zip`), `uploadError`, and `uploadCompletedAt`.

**Manual retry:**

```bash
sis admin upload <session-id>     # re-uploads any session (active or completed)
sis admin upload                  # uploads the active session in this cwd
```

**Disable** — omit the `upload` config block. Daemon skips silently.

Operator setup (token minting, Worker deployment, R2 provisioning): see [`workers/upload-proxy/README.md`](workers/upload-proxy/README.md).

## CLI reference

Session lifecycle: `session kill`, `session resume`, `session continue`, `session rollback`, `session complete`

Agent and orchestrator: `agent spawn`, `agent submit`, `agent report`, `orch yield`, `orch message`, `agent restart`, `session task`

Monitoring: `session status` (`--verbose`), `session list` (`--all`), `ui dashboard`

Setup: `admin setup`, `admin init`, `admin doctor`, `ui guide`, `companion`, `admin uninstall`

### history

Browse session history and metrics.

```bash
sis session history                        # List recent sessions
sis session history <session-id>           # Inspect a specific session
sis session history --stats                # Aggregate statistics
sis session history --events               # Raw event timeline
```

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Filter by project directory |
| `--status <status>` | Filter by status (`completed`, `killed`) |
| `--since <duration>` | Filter by recency (e.g. `7d`, `24h`, `2w`) |
| `--search <query>` | Search task text and messages |
| `--events` | Show raw event timeline |
| `--stats` | Show aggregate statistics |
| `--json` | Output as JSON |
| `-n, --limit <n>` | Max sessions to show (default: 20) |

### clone

Clone a session into a new independent session with a different goal.

```bash
sis session clone "new goal"
sis session clone "new goal" --strategy    # carry over strategy.md from source
sis session clone "new goal" --name my-clone --context "extra context"
```

Useful for branching off a variant approach without starting from scratch.

### reconnect

Reconnect the daemon to an orphaned tmux session (e.g. after a daemon restart). Makes no state changes and does not spawn the orchestrator.

```bash
sis session reconnect <session-id>
```

### delete

Delete a session and all its data.

```bash
sis session delete <session-id>
sis session delete <session-id> --cwd /path/to/project
```

---

`sis --help` or `sis <command> --help` for full usage.

## Output and exit codes

**JSON output** — `-j, --json` is available on `session status`, `session list`, `await`, `read`, and `session history`. Each command emits data to stdout: a single JSON object or array, or JSONL (one object per line) for `read`.

**ANSI color** — auto-detected from stdout TTY. Disable with `NO_COLOR=1`; force-enable with `FORCE_COLOR=1`.

**Exit codes** — `0` on success, `1` on error (message on stderr).

**stdout vs stderr** — stdout is reserved for data (use it with `jq`, pipes, or `$()`). All diagnostics, progress, and status messages go to stderr.

## License

MIT
