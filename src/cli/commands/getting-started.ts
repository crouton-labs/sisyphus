import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { isTmuxInstalled } from '../tmux.js';
import { isNvimAvailable, detectTerminal, checkItermOptionKey } from '../onboard.js';

function templatePath(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'templates', name);
}

function isClaudeCode(): boolean {
  return !!process.env['CLAUDECODE'];
}

function printNonClaudeMessage(): void {
  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║   sis ui guide — Interactive Tutorial            ║
  ╚══════════════════════════════════════════════════╝

  This command provides an interactive tutorial best experienced
  inside Claude Code. Claude will walk you through setup step by step.

  To start:
    1. Open Claude Code:  claude
    2. Run:               sis ui guide

  If you just want the quick reference, run:
    sis --help
    sis admin check doctor
`);
}

function printStep0(): void {
  const tmuxInstalled = isTmuxInstalled();
  const inTmux = !!process.env['TMUX'];
  let tmuxSession: string | null = null;
  if (process.env['TMUX']) {
    const segments = process.env['TMUX'].split(',');
    const pathPart = segments[0];
    if (pathPart) {
      const parts = pathPart.split('/');
      tmuxSession = parts[parts.length - 1] || null;
    }
  }

  console.log(`
<claude-instructions>
# Sisyphus Getting Started — Step 0: Entry & Tmux Gate

## Environment Data
- tmuxInstalled: ${tmuxInstalled}
- inTmux: ${inTmux}
- tmuxSession: ${tmuxSession ?? 'none'}

## Tutorial Overview

This tutorial has 6 steps. Share this overview so the user knows what's coming and can skip ahead:

| Step | Topic | Command |
|------|-------|---------|
| 0 | Entry & tmux gate (you are here) | \`sis ui guide\` |
| 1 | Tmux basics — sessions, panes, navigation | \`--tutorial 1\` |
| 2 | Nvim basics — open, save, quit (optional) | \`--tutorial 2\` |
| 3 | Sisyphus concepts — session model & keybinds | \`--tutorial 3\` |
| 4 | Live demo — launch and observe a real session | \`--tutorial 4\` |
| 5 | What's next — real usage guidance & suggestions | \`--tutorial 5\` |

Tell the user they can skip to any step with \`sis ui guide --tutorial <N>\`.

## Instructions for Claude

You are guiding a user through the Sisyphus interactive tutorial.

### First: Ask if they want the tutorial

Ask the user if they'd like the interactive walkthrough. If they decline, give this quick summary and stop:

> Sisyphus is a multi-agent orchestrator for Claude Code. Start a session with \`sis session lifecycle start "task"\`,
> monitor with \`sis ui dashboard\`, and check health with \`sis admin check doctor\`.

### If they want the tutorial:

**Case 1: tmux is NOT installed (tmuxInstalled: false)**
- Explain what tmux is in 2-3 sentences: "tmux is a terminal multiplexer — it lets you split your terminal into multiple panes and keep sessions running in the background. Sisyphus uses it to give each agent its own workspace."
- Show this ASCII diagram:

\`\`\`
  Regular terminal:          With tmux:
  ┌──────────────┐          ┌──────┬──────┐
  │              │          │ Agent│ Agent│
  │   one view   │          │  001 │  002 │
  │              │          ├──────┼──────┤
  │              │          │ Agent│ Orch │
  └──────────────┘          │  003 │      │
                            └──────┴──────┘
\`\`\`

- Tell them to install tmux:
  - macOS: \`brew install tmux\`
  - Linux: \`apt install tmux\` or their package manager
- After install, re-run: \`sis ui guide --tutorial 0\` to verify

**Case 2: tmux installed but NOT in a tmux session (inTmux: false)**
- Tell the user they need to be inside a tmux session for the tutorial
- Have them run: \`tmux new-session\`
- Then resume the conversation with Claude in the new tmux session: \`claude\`
- Then re-run: \`sis ui guide --tutorial 0\` to verify

**Case 3: In tmux (inTmux: true)**
- Tell the user they're all set — tmux is running
- Proceed by running: \`sis ui guide --tutorial 1\`
</claude-instructions>
`);
}

function printStep1(): void {
  console.log(`
<claude-instructions>
# Sisyphus Getting Started — Step 1: Tmux Basics

## Instructions for Claude

Teach the user tmux fundamentals. Be conversational and encouraging.

### 1. Explain the concepts with diagrams

**Sessions, Windows, and Panes:**

\`\`\`
tmux session "work"
├── window 1: "code"
│   ┌──────────┬──────────┐
│   │  pane 1  │  pane 2  │
│   │  (editor)│  (tests) │
│   └──────────┴──────────┘
└── window 2: "servers"
    ┌──────────────────────┐
    │       pane 1         │
    │    (dev server)      │
    └──────────────────────┘
\`\`\`

- **Session**: A collection of windows. Persists even if you close the terminal.
- **Window**: Like a tab. Each window fills the screen.
- **Pane**: A split within a window. Sisyphus puts each agent in its own pane.

### 2. Hands-on: Create a test split

Run this command for the user:
\`\`\`
tmux split-window -h
\`\`\`

Tell them: "I just split your terminal. You should see two panes side by side."

Explain navigation:
- \`Ctrl+l\`: move to the right pane
- \`Ctrl+h\`: move to the left pane
- \`Ctrl+j\`: move to the pane below
- \`Ctrl+k\`: move to the pane above
- No prefix key needed — just hold Ctrl and press the direction letter
- For windows: \`Ctrl+n\` next window, \`Ctrl+p\` previous window

Ask them to try navigating between panes.

### 3. Clean up the test pane

Once they confirm they can navigate, close the extra pane:
\`\`\`
tmux kill-pane -t {the other pane}
\`\`\`

Or tell them they can type \`exit\` in the extra pane to close it.

### 4. Teach essential commands

- **Detach**: \`Ctrl-b d\` — leaves tmux running in background, returns to normal terminal
- **Reattach**: \`tmux attach\` (or \`tmux a\`) — reconnects to the running session
- **Scroll up/down**: \`Ctrl+u\` / \`Ctrl+d\` — scroll half-page up/down (no prefix needed). Press \`q\` to exit scroll mode.
- **New window**: \`Ctrl-b n\` — opens a new window in the current directory
- **Kill pane**: \`Ctrl-b x\` — closes the current pane and rebalances layout
- **Re-tile**: \`Ctrl-b =\` — rebalance all panes to equal widths

### 5. Verification

Ask the user to confirm: "Can you navigate between panes with Ctrl+h and Ctrl+l?"

Once confirmed, proceed:
\`\`\`
sis ui guide --tutorial 2
\`\`\`
</claude-instructions>
`);
}

function printStep2(): void {
  const nvimInstalled = isNvimAvailable();

  console.log(`
<claude-instructions>
# Sisyphus Getting Started — Step 2: Nvim Basics

## Environment Data
- nvimInstalled: ${nvimInstalled}

## Instructions for Claude

This step is OPTIONAL. Nvim is useful for reviewing and editing files when you jump into agent panes, but not required.

Note: The sisyphus dashboard has keys that auto-open files in nvim — users don't need to know how to open files from the command line. Focus on what they'll need once they're INSIDE nvim.

### If nvim is NOT installed (nvimInstalled: false)

Ask the user: "Neovim is handy for reviewing and editing files in tmux panes. Want me to install it, or skip this step?"

- **Install**: Run \`brew install neovim\` (macOS) or suggest their package manager
- **Skip**: That's fine — they can use \`cat\`, \`less\`, or any editor they prefer. Proceed to step 3.

### If nvim IS installed (nvimInstalled: true)

Briefly explain the key concept — nvim has two modes:

- **Normal mode** (default): Keys are commands, not text. This is where you navigate.
- **Insert mode**: Press \`i\` to enter. Now you type normally. \`Esc\` goes back to normal.

Tell them the basics they need once they're inside nvim: \`i\` to enter insert mode, \`Esc\` to return to normal mode, \`:w\` to save, \`:q\` to quit, \`:wq\` to save and quit.

### Verification

Ask if they were able to edit and save the file (or if they skipped).

Proceed:
\`\`\`
sis ui guide --tutorial 3
\`\`\`
</claude-instructions>
`);
}

function printStep3(): void {
  // Detect iTerm Right Option Key status for environment data
  let rightOptionKeyStatus = 'unknown';
  const terminal = detectTerminal();
  if (!terminal.isIterm) {
    rightOptionKeyStatus = 'not-iterm';
  } else {
    const result = checkItermOptionKey();
    if (!result.checked) {
      rightOptionKeyStatus = 'could-not-check';
    } else if (result.allCorrect) {
      rightOptionKeyStatus = 'ok';
    } else {
      rightOptionKeyStatus = `incorrect:${result.incorrectProfiles.join(',')}`;
    }
  }

  console.log(`
<claude-instructions>
# Sisyphus Getting Started — Step 3: Sisyphus Concepts & Keybinds

## Environment Data
- rightOptionKeyStatus: ${rightOptionKeyStatus}

## Instructions for Claude

### 1. CRITICAL FIRST: Right Option Key Setup

**This must be done before anything else.** Sisyphus keybinds use the Option key as "Meta". By default, macOS terminals send special characters when you press Option (e.g., Option+s types \`ß\`). We need the RIGHT Option key to send escape sequences instead.

**Check the environment data above:**

- **rightOptionKeyStatus: ok** — They're all set, briefly confirm and move on.

- **rightOptionKeyStatus: incorrect:ProfileName** — Walk them through the fix:

  > Your Right Option key isn't configured correctly yet. Here's how to fix it:
  >
  > 1. Open **iTerm2 Settings** (Cmd+,)
  > 2. Go to **Profiles** → select your profile (shown above)
  > 3. Click the **Keys** tab
  > 4. At the bottom, find **Right Option Key**
  > 5. Change it from **Normal** to **Esc+**
  >
  > \`\`\`
  >   ┌─ iTerm2 Settings ──────────────────────────┐
  >   │  Profiles > Keys                            │
  >   │                                             │
  >   │  Right Option Key:                          │
  >   │    ○ Normal  (sends special chars like ß)   │
  >   │    ● Esc+    (sends escape sequences) ← ✓   │
  >   └─────────────────────────────────────────────┘
  >  \`\`\`
  >
  > **Why right and not left?** You'll still want the left Option key for
  > typing special characters (accents, symbols). The right Option key
  > becomes your "Meta" key for tmux/sisyphus keybinds.

  After they change it, have them verify by re-running \`sis admin check doctor\` — look for "Right Option Key: Esc+".

- **rightOptionKeyStatus: not-iterm** — They're not using iTerm2. Explain:
  > Sisyphus keybinds use Option as Meta. In iTerm2 this is configured via
  > "Right Option Key → Esc+". For your terminal, look for a similar setting
  > like "Option sends Meta" or "Option sends Esc+". Without this, pressing
  > Option+s will type a special character instead of triggering the keybind.

- **rightOptionKeyStatus: could-not-check** or **unknown** — Ask them to manually check:
  > Press Option+s in your terminal. If you see \`ß\` (or another special character),
  > your Option key needs to be reconfigured. In iTerm2: Settings → Profiles → Keys →
  > Right Option Key → Esc+.

### 2. Explain the session model

This is the KEY concept. Use the diagram and be clear:

\`\`\`
  YOUR tmux session ("work")        Sisyphus tmux session ("sisyphus-abc123")
  ┌─────────────────────┐          ┌──────────┬──────────┬──────────┐
  │                     │          │  Orch    │  Agent   │  Agent   │
  │  Your normal work   │   ←──→   │  (yellow)│  (blue)  │  (green) │
  │  + dashboard        │          │          │          │          │
  │                     │          │  Plans & │  Writes  │  Writes  │
  │                     │          │  assigns │  code    │  tests   │
  └─────────────────────┘          └──────────┴──────────┴──────────┘
\`\`\`

Key points:
- Sisyphus creates its OWN tmux session — it doesn't clutter yours
- The **orchestrator** (yellow pane) plans work and spawns agents
- **Agents** (colored panes) work in parallel on subtasks
- Your session stays clean — you get a **dashboard** for monitoring
- You can jump between your session and the sisyphus session to observe

### 3. Teach keybinds

Two keybinds to remember (both use the RIGHT Option key):

| Keybind | Action |
|---------|--------|
| Right Option + s | Cycle through sisyphus sessions |
| Right Option + Shift + s | Jump back to dashboard |

### 4. Verify keybinds are installed (REQUIRED before step 5)

Run \`sis admin check check-keybinds\` and follow the decision tree it emits. The output is
structured for you — it tells you the current state and which path to take (Path A
through Path F). Do NOT skip this and do NOT ask the user to test a keybind until
both \`M-s\` and \`C-s\` read "sisyphus" in that command's output.

Common paths:
- **Path A (already wired):** confirm and move on.
- **Path B (safe auto-install):** run \`sis admin install setup-keybind --yes\`.
- **Path C (would touch user's tmux.conf):** ask the user — persistent (\`--force\`) or
  live-only (no flag, non-TTY auto-declines the conf write).
- **Path D (binding conflict):** pick alternate keys or wire directly.
- **Path E (hidden prefix collision):** their tmux prefix is C-s; explain and offer
  alternatives.
- **Path F (tmux not ready):** fix the precondition first.

After acting, re-run \`sis admin check check-keybinds\` to confirm success.

### 5. Test the keybind

Once check-keybinds reports both keys as "sisyphus", have the user try pressing
Right Option + s. Nothing should happen yet (no sisyphus session running) — and that's
fine. The important thing is no special character appears.

If they see \`ß\` or similar, circle back to the Right Option Key setup above.

### 6. Verification

Confirm:
- They understand the two-session model (their session vs sisyphus session)
- \`sis admin check doctor\` shows keybinds installed AND Right Option Key: Esc+
- Right Option + s doesn't produce a special character

Proceed:
\`\`\`
sis ui guide --tutorial 4
\`\`\`
</claude-instructions>
`);
}

function printStep4(): void {
  // Anchor the demo inside the user's cwd (under ./tmp/) instead of system /tmp,
  // so sisyphus runs in a path the user can see and reason about. Absolute path
  // emitted so the commands keep working even if Claude later changes cwd.
  const demoPath = join(process.cwd(), 'tmp', 'sisyphus-tutorial-demo');
  console.log(`
<claude-instructions>
# Sisyphus Getting Started — Step 4: Demo Session

## Instructions for Claude

This is the grand finale — a live demo session.

### 1. Health check

Run \`sis admin check doctor\` first. If any checks are failing, help the user fix them before proceeding.
All core checks (tmux, daemon, keybinds) should be ✓.

### 2. BEFORE launching: Teach navigation

**This is critical.** When \`sis session lifecycle start\` runs, it auto-opens the dashboard in a new tmux window. The user will suddenly be looking at the dashboard and may feel "stuck". Teach them how to navigate BEFORE launching:

Explain clearly:

> Before we launch, you need to know how to move between tmux windows. Right now you're in a window with Claude. When sisyphus starts, it'll open a dashboard in a new window. Think of windows like tabs:
>
> \`\`\`
>   Window 1 (you are here)    Window 2 (dashboard)
>   ┌──────────────────┐      ┌──────────────────┐
>   │  Claude Code     │      │  Sisyphus        │
>   │  (this session)  │  →   │  Dashboard       │
>   └──────────────────┘      └──────────────────┘
>       Ctrl+n →                  ← Ctrl+p
> \`\`\`
>
> - **\`Ctrl+n\`** — next window (go to dashboard)
> - **\`Ctrl+p\`** — previous window (come back here)
>
> And remember from step 3:
> - **Right Option + s** — jump to the sisyphus agent session (where you can watch agents work live)
> - **Right Option + Shift + s** — jump back to dashboard

Have the user confirm they understand these keybinds before proceeding.

### 3. Set expectations, copy demo app, and launch

First, copy the demo todo app into ./tmp/ under the user's current directory and init a git repo (sisyphus needs git). Run from the user's current shell — don't \`cd\` away first:
\`\`\`
mkdir -p ${join(process.cwd(), 'tmp')}
rm -rf ${demoPath}
cp -r ${templatePath('tutorial-demo')} ${demoPath}
git -C ${demoPath} init
git -C ${demoPath} add -A
git -C ${demoPath} commit -m "Initial todo app"
\`\`\`

Tell the user:

> I've set up a small todo app in ${demoPath} — a Node.js API
> with a few files. It lives under \`tmp/\` in your current directory so sisyphus
> runs somewhere you can see, not in system /tmp. I'm going to launch sisyphus
> on it. Here's what will happen:
> 1. The dashboard opens automatically (you'll be switched to it)
> 2. Press **Ctrl+p** to come back here to Claude — I'll guide you through what to watch
> 3. The session takes a few minutes. You can watch agents work live!

Then launch from the demo directory (sisyphus operates in whichever directory you launch it from, so we \`cd\` in so the \`.sisyphus/\` state lands inside the demo):
\`\`\`
cd ${demoPath} && sis session lifecycle start "Add three improvements to this todo app: (1) add a priority field (high/medium/low) to todos, (2) add a GET /todos/stats endpoint that returns counts of total/done/pending todos, (3) add tests for the new features. Explain your thinking at each step." -c "TUTORIAL DEMO: A user is watching this session to learn how sisyphus works. Be EXTRA VERBOSE — explain your reasoning, narrate what you're doing, and make your planning visible. When spawning agents, give each agent context that this is a tutorial demo and they should explain their work clearly. Keep scope small: 2-3 agents, 1-2 cycles."
\`\`\`

After launching, tell them:

> The dashboard just opened. Press **Ctrl+p** to come back here — I'll provide live commentary as the session runs so you know what's happening.

Wait for them to confirm they're back, then start live commentary.

### 4. Live commentary loop

**This is the most important part of the demo.** Don't just launch and wait — actively narrate.

Once the user is back, start a polling loop. Every ~45 seconds, run \`sis session inspect status --verbose <session-id>\` and provide SHORT, contextual commentary about what's happening. The \`--verbose\` flag shows agent instructions, full roadmap, cycle logs, and live pane output from the orchestrator and running agents — use this rich data to narrate what's actually happening, not just phase names.

**How to narrate each phase:**

- **Cycle 1, no agents yet**: "The orchestrator is reading the codebase and planning. It's figuring out how to split the work. Check the dashboard (\`Ctrl+n\`) — you'll see the roadmap updating."

- **Agents spawning**: "Agents just spawned! You should see new panes appearing. Try \`Right Option + s\` to jump to the sisyphus session and watch them work. Each colored pane is an independent Claude instance."

- **Agents working**: "Agent-001 is working on [X], Agent-002 is on [Y]. They're working in parallel — this is the key advantage of sisyphus. Jump over and watch if you like (\`Right Option + s\`)."

- **Agents submitting**: "Agent-001 just submitted its report! [N] more to go. When all agents finish, the orchestrator will respawn to review."

- **Between cycles**: "All agents done. The orchestrator is respawning with fresh context to review the reports and decide what's next. This is the cycle boundary — the orchestrator never runs out of context because it starts fresh each time."

- **Completion**: "The session is complete! Let me show you the results."

**Important:**
- Keep commentary to 1-3 sentences per check — don't wall-of-text
- Remind them of navigation keys when relevant ("jump over with Right Option + s to see this live")
- If agents are still working with no change, say so briefly ("Still working... Agent-001 is the furthest along")
- Reference specific agent names and tasks from the status output
- Stop polling when status shows "completed"

Between polls, encourage the user to explore:
> "While we wait, try jumping around: \`Ctrl+n\` for dashboard, \`Right Option + s\` for the agent session, \`Right Option + Shift + s\` to jump back. I'll keep narrating here."

### 5. After completion

Once the session shows "completed":

- Show them what the agents built: \`cd ${demoPath} && git log --oneline\`
- Run the tests to prove the work: \`cd ${demoPath} && node --test test.js\`
- Show the session artifacts: find the session dir in \`.sisyphus/sessions/\` and show \`roadmap.md\`
- Explain: "Every session creates a roadmap, agent reports, and logs — all stored in .sisyphus/sessions/"

### 6. Proceed to wrap-up

Tell the user the demo is done. Then run:
\`\`\`
sis ui guide --tutorial 5
\`\`\`
</claude-instructions>
`);
}

function printStep5(): void {
  // Recompute the demo path so cleanup targets the same dir Step 4 created.
  const demoPath = join(process.cwd(), 'tmp', 'sisyphus-tutorial-demo');
  const demoExists = existsSync(demoPath);

  // Gather codebase context for suggestions
  let recentCommits = '';
  let topLevelFiles = '';
  try {
    recentCommits = execSync('git log --oneline -15 2>/dev/null', { encoding: 'utf-8' }).trim();
  } catch { /* not in a git repo */ }
  try {
    topLevelFiles = execSync('ls -1 2>/dev/null', { encoding: 'utf-8' }).trim();
  } catch { /* ignore */ }

  console.log(`
<claude-instructions>
# Sisyphus Getting Started — Step 5: What's Next

## Environment Data
- demoPath: ${demoPath}
- demoExists: ${demoExists}

## Codebase Context
<recent-commits>
${recentCommits || '(no git repo detected)'}
</recent-commits>

<top-level-files>
${topLevelFiles || '(could not list)'}
</top-level-files>

## Instructions for Claude

### 1. Congratulate them

Tell them they've completed the tutorial and recap what they learned:
- tmux basics (sessions, panes, navigation)
- nvim basics for reviewing files
- The sisyphus session model (separate tmux session for orchestrator + agents)
- Monitoring with dashboard and keybinds
- A live session lifecycle

### 2. Navigation cheat sheet

| Key | Action |
|-----|--------|
| \`Ctrl+n\` / \`Ctrl+p\` | Next/previous tmux window |
| \`Ctrl+h/j/k/l\` | Navigate between panes |
| \`Right Option + s\` | Jump to sisyphus agent session |
| \`Right Option + Shift + s\` | Jump to dashboard |

### 3. How to use sisyphus for REAL work

This is the most important part. Explain clearly:

> **Sisyphus is for big, end-to-end features — the kind that need exploration,
> planning, and parallel implementation across multiple systems.**
>
> You don't need to define the task precisely. Broad is fine — the orchestrator
> will explore the codebase, write specs, plan phases, and break it down itself.

**Real sisyphus sessions (from production use):**
- "Design and implement a human-in-the-loop agent inbox system" — exploration, spec writing, DB schema, API endpoints, UI components, webhook integration, e2e validation
- "Build multi-user organization features — invites, privilege gating, org switcher, workspace sharing, credit tracking" — touched auth, DB, API, UI, billing, permissions
- "Rework all 5 worker onboarding templates to match production pipeline patterns" — mapped existing patterns, designed new architecture, implemented across templates, validated with e2e tests
- "Autonomous failure detection system across 8 sequential phases" — monitoring, alerting, recovery, dashboard, with each phase building on the last
- "Comprehensive code quality audit — find and fix dead code, null handling, useless fallbacks" — systematic codebase-wide analysis and cleanup
- "Implement @requirements.md" — point it at a spec and let it go

**NOT good for sisyphus:**
- Five unrelated small tasks bundled together ("fix the login bug, update the README, add a loading spinner") — these aren't one feature, they're a todo list
- Something Claude Code in plan mode would handle — plan mode already handles substantial single-engineer work. If it fits in one Claude session, just do it directly.
- Quick fixes, bug fixes, small refactors — use regular Claude Code

**How to start:**
The easiest way is the \`/sisyphus:begin\` slash command inside Claude Code. Just tell Claude
what you want to build and it'll hand it off to sisyphus with the right context.

Or directly: \`sis session lifecycle start "your task" -c "any background context"\`

### 4. Suggest real tasks for THEIR codebase

Look at the recent commits and top-level files above. Based on what you can see of their project, suggest 2-3 concrete sisyphus-scale tasks they could try. Be specific to their codebase — reference actual directories, patterns, or areas you can see.

If there are no commits or files (e.g., they ran this from an empty scratch dir, or from the tutorial demo dir itself at tmp/sisyphus-tutorial-demo), skip this section.

Format as:
> Based on your codebase, here are some tasks sisyphus would be great for:
> - "..."
> - "..."

### 5. Clean up the demo dir

**Only if demoExists is true** (see Environment Data above). The tutorial dropped a
demo todo app at \`${demoPath}\` with its own \`.sisyphus/\` session state. Ask the user
before deleting — they may want to poke around the session files first.

Ask exactly:

> Want me to remove the tutorial demo at \`${demoPath}\`? It's safe to delete — it
> only contains the demo todo app and the session sisyphus just ran on it.

If they say yes, run:
\`\`\`
rm -rf ${demoPath}
\`\`\`

Then check whether \`${join(process.cwd(), 'tmp')}\` is now empty, and if so remove it too:
\`\`\`
rmdir ${join(process.cwd(), 'tmp')} 2>/dev/null || true
\`\`\`

If they say no or want to explore first, leave it. They can clean up later with the same
\`rm -rf\` command.

### 6. There's more to learn

Tell them:

> There's actually a lot of depth to how sisyphus works — the design is intentional
> and there's real reasoning behind why it does things the way it does. If you want
> to understand the philosophy, or you want a deeper rundown on the dashboard,
> monitoring, configuration, or how to steer sessions — just ask and I'll explain.

If the user says yes or asks to learn more, run \`sis ui guide --explain\`
and use its output to explain the system to them conversationally. Don't dump the whole
thing — answer what they're curious about, using the reference as your source material.
</claude-instructions>
`);
}

function buildCommandTable(root: Command): string {
  const lines: string[] = ['| Command | Purpose |', '|---------|---------|'];

  const fmtArgs = (c: Command) =>
    c.registeredArguments.map(a => a.required ? `<${a.name()}>` : `[${a.name()}]`).join(' ');

  function walk(cmd: Command, prefix: string): void {
    if ((cmd as unknown as { _hidden: boolean })._hidden) return;
    if (cmd.name() === 'help') return;

    const fullPrefix = prefix ? `${prefix} ${cmd.name()}` : cmd.name();
    const hasOwnAction = (cmd as unknown as { _actionHandler?: unknown })._actionHandler != null;
    const visibleSubs = cmd.commands.filter(
      c => !(c as unknown as { _hidden: boolean })._hidden && c.name() !== 'help'
    );

    // If the node has its own action handler, emit a row for it
    if (hasOwnAction) {
      const args = fmtArgs(cmd);
      const usage = args ? `sis ${fullPrefix} ${args}` : `sis ${fullPrefix}`;
      lines.push(`| \`${usage}\` | ${cmd.description()} |`);
    }

    if (visibleSubs.length === 0) {
      // Leaf with no own action (shouldn't normally happen, but emit a row)
      if (!hasOwnAction) {
        const args = fmtArgs(cmd);
        const usage = args ? `sis ${fullPrefix} ${args}` : `sis ${fullPrefix}`;
        lines.push(`| \`${usage}\` | ${cmd.description()} |`);
      }
    } else {
      // Recurse into children
      for (const sub of visibleSubs) {
        walk(sub, fullPrefix);
      }
    }
  }

  for (const cmd of root.commands) {
    walk(cmd, '');
  }

  return lines.join('\n');
}

function printExplain(root: Command): void {
  console.log(`
<claude-instructions>
# Sisyphus — Comprehensive Reference

This is a detailed reference for how sisyphus works. The user asked to understand
sisyphus more deeply. Use this to answer their questions conversationally — don't dump
the whole thing. Read through it, then respond to what they're curious about.

## Design Philosophy

Sisyphus is built on specific insights about how to get the best work out of LLM agents.
These aren't arbitrary — each design decision solves a real failure mode.

### 1. The Orchestrator as "Human-in-the-Loop"

When you use Claude Code effectively, YOU are the orchestrator — you review work,
steer direction, break problems down, and assign the next piece. Sisyphus automates
that human role. The orchestrator does what a skilled developer does when prompting
Claude: explore the codebase, understand the problem, write specs, plan phases,
assign focused work, review results, and iterate.

The strategy layer mirrors how developers actually work on end-to-end features:
explore, understand, spec, plan, implement, review, validate. The orchestrator
follows this same workflow, but runs it with parallel agents.

### 2. Fresh Context Kills Shortcuts

The orchestrator is KILLED after every cycle and respawned fresh. This is the most
important design decision.

When an LLM accumulates context over a long session, it starts taking shortcuts.
It "knows" what it did earlier, so it skips re-reading, assumes things still hold,
and builds on stale understanding. A fresh start forces honest reassessment every
cycle — the orchestrator reads the actual state, not its memory of it.

This is inspired by adversarial training (think GANs) — better results come from
adversarial pressure. Each fresh orchestrator effectively audits the previous cycle's
work because it has no stake in defending prior decisions. It sees the roadmap, the
reports, the code — and judges them with fresh eyes.

### 3. Single-Focus Agents

Each agent gets ONE task with a fully self-contained instruction. No context switching,
no juggling multiple concerns, no "also while you're there could you..."

LLMs perform dramatically better when focused. An agent implementing a priority field
doesn't think about the stats endpoint. It reads the relevant context, does its one
thing well, and reports back. The orchestrator handles decomposition — agents handle
execution.

### 4. Shared Context Directory (Saved Research)

Every session has a context/ directory where agents save research, specs, plans, and
design docs. These files persist across ALL cycles and are visible to the orchestrator
and subsequent agents.

This means research is never repeated. Cycle 1 agents explore and write findings to
context/explore-auth-system.md. Cycle 3 agents read those findings and build on them.
Knowledge accumulates even though the orchestrator itself is stateless.

Plan lead agents save their plans under context/{agent-id}/ so parallel plan agents
don't interfere with each other's validation.

### 5. Two-Layer Planning (Strategy + Roadmap)

The system maintains two documents at different abstraction levels:

**strategy.md** — The high-level problem-solving map. What phases exist, what gates
between them, what backtrack paths exist. Updated every few cycles when the shape of
work changes. Helps the orchestrator see the forest.

**roadmap.md** — Working memory. Updated every cycle. Current Stage, Exit Criteria,
Active Context, Next Steps. The orchestrator reads this first each cycle to understand
where things stand. Helps the orchestrator see the trees.

This prevents the failure mode where a single document becomes either too abstract
to act on or too detailed to show the big picture.

### 6. Adversarial Review Is Built In

The orchestrator doesn't just implement — it runs mandatory critique cycles. After
implementation, review agents attack different dimensions: code reuse, quality,
efficiency, correctness. Fix agents address the findings. Re-review until only nits
remain. Multiple agents auditing each other produces better results than any single
agent reviewing its own work.

The rule: never let 2+ stages complete without critique. Small issues compound into
architectural problems if unchecked.

### 7. Evidence Over Assumptions

Validation requires PROOF — command output, test results, HTTP responses. "The code
looks correct" is not evidence. "All 14 tests pass" is. This catches the gap between
code that looks right and code that works.

## Architecture Overview

\`\`\`
┌─────────────────────────────────────────────────────────────────────┐
│                        USER'S TMUX SESSION                          │
│                                                                     │
│  ┌─────────────────────────┐  ┌──────────────────────────────────┐  │
│  │ Window 1: Claude Code   │  │ Window 2: Dashboard (TUI)        │  │
│  │                         │  │                                  │  │
│  │  User's normal work     │  │  Real-time session monitor       │  │
│  │  + this conversation    │  │  Roadmap, agents, reports        │  │
│  │                         │  │  Interactive controls            │  │
│  └─────────────────────────┘  └──────────────────────────────────┘  │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ Right Option+s / Right Option+Shift+s
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     SISYPHUS TMUX SESSION                           │
│                    (created per sisyphus session)                   │
│                                                                     │
│  ┌──────────┬──────────┬──────────┬──────────┐                      │
│  │ Orch     │ Agent    │ Agent    │ Agent    │  ← panes             │
│  │ (yellow) │ (blue)   │ (green)  │ (magenta)│                      │
│  │          │          │          │          │                      │
│  │ Plans,   │ Impl     │ Tests    │ Docs     │  ← each is a         │
│  │ assigns, │ feature  │          │          │    Claude Code       │
│  │ reviews  │          │          │          │    instance          │
│  └──────────┴──────────┴──────────┴──────────┘                      │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          DAEMON (sisyphusd)                         │
│                     Background process via launchd                  │
│                                                                     │
│  Listens on ~/.sisyphus/daemon.sock                                 │
│  Manages session lifecycle, pane monitoring, state persistence      │
│  Polls panes to detect when agents/orchestrator finish              │
└─────────────────────────────────────────────────────────────────────┘
\`\`\`

## The Session Lifecycle (in detail)

\`\`\`
  ┌──────────────────────────────────────────────────────────────────┐
  │                    SESSION LIFECYCLE                             │
  │                                                                  │
  │  sis session lifecycle start "task"                              │
  │       │                                                          │
  │       ▼                                                          │
  │  ┌─────────┐     spawn agents     ┌──────────────┐               │
  │  │  Orch   │ ──────────────────→  │  Agents work │               │
  │  │ plans   │     then yields      │  in parallel │               │
  │  └────┬────┘                      └──────┬───────┘               │
  │       │                                  │ each calls            │
  │       │ orchestrator                     │ sis agent submit      │
  │       │ is KILLED                        │ when done             │
  │       │                                  ▼                       │
  │       │                           ┌──────────────┐               │
  │       │                           │ All agents   │               │
  │       │                           │ finished?    │               │
  │       │                           └──────┬───────┘               │
  │       │                                  │ yes                   │
  │       │           ┌──────────────────────┘                       │
  │       │           ▼                                              │
  │       │     ┌─────────┐                                          │
  │       └──── │ Respawn │  Fresh orchestrator with full state      │
  │  next cycle │  Orch   │  Reviews reports, plans next cycle       │
  │             └────┬────┘                                          │
  │                  │                                               │
  │                  ▼                                               │
  │          ┌───────────────┐         ┌───────────┐                 │
  │          │ More work     │──yes──→ │ Spawn     │ → (loop)        │
  │          │ needed?       │         │ agents    │                 │
  │          └───────┬───────┘         └───────────┘                 │
  │                  │ no                                            │
  │                  ▼                                               │
  │          ┌───────────────┐                                       │
  │          │ sisyphus      │                                       │
  │          │ complete      │                                       │
  │          └───────────────┘                                       │
  └──────────────────────────────────────────────────────────────────┘
\`\`\`

**Key insight**: The orchestrator is STATELESS. It gets killed after each yield and
respawned fresh with the complete session state (roadmap, agent reports, cycle history).
This means it never runs out of context, no matter how many cycles a session takes.

## The Dashboard

The dashboard is a real-time TUI that shows session state. Launch with \`sis ui dashboard\`
or it auto-opens when a session starts.

**Dashboard sections:**
- **Header**: Session ID, status, task description
- **Roadmap**: Current strategic plan with checked/unchecked items
- **Agents**: List of all agents with status, duration, and report summaries
- **Cycles**: Orchestrator cycle history
- **Messages**: Recent session messages

**Dashboard keys:**
| Key | Action |
|-----|--------|
| \`m\` | Message the orchestrator (steer direction mid-session) |
| \`w\` | Jump to the sisyphus tmux session (watch agents work) |
| \`k\` | Kill the session |
| \`r\` | Resume a paused/completed session |
| \`q\` | Quit the dashboard |
| \`↑/↓\` | Scroll through content |
| \`Tab\` | Cycle through sections |

**The \`m\` key is the most powerful feature.** You can message the orchestrator at any time
to course-correct: "Focus on the API layer first", "Skip the tests for now",
"The approach for auth is wrong, use JWT instead". The orchestrator reads these
messages when it respawns each cycle.

## Monitoring Strategy

Sisyphus sessions should be actively monitored. Here's what to watch for:

**Things that go wrong:**
- Agents stuck waiting for user input (they're autonomous — they shouldn't need input)
- Agents going down rabbit holes or working on the wrong thing
- Merge conflicts between agents touching the same files
- Orchestrator spawning too many agents or too few
- Agents crashing or getting killed unexpectedly

**When to intervene:**
- Use \`m\` in the dashboard to message the orchestrator with corrections
- Use \`sis session lifecycle kill <id>\` to stop a runaway session
- Use \`sis session lifecycle resume <id> "new instructions"\` to restart with different direction

**Useful monitoring commands:**
\`\`\`
sis session inspect status <id>              # Quick status check
sis session inspect status --verbose <id>    # Full detail: roadmap, pane output, agent instructions
sis ui dashboard                     # Interactive TUI
tail -f ~/.sisyphus/daemon.log       # Daemon activity log
\`\`\`

## The .sisyphus/ Directory

Everything sisyphus does lives in a \`.sisyphus/\` directory at the root of your project.
This is project-local — each project gets its own. It contains:

\`\`\`
.sisyphus/
├── config.json              # Project-specific config (model, poll interval, etc.)
├── orchestrator.md          # Optional custom orchestrator prompt override
└── sessions/
    ├── <session-id-1>/      # Each session gets its own directory
    ├── <session-id-2>/
    └── ...
\`\`\`

There's also a global directory at \`~/.sisyphus/\` for the daemon socket, PID file,
logs, keybind scripts, and global config. But the session state — the roadmaps,
reports, context files, cycle logs — all lives in your project's \`.sisyphus/sessions/\`.

## Session Files

Every session creates a directory at \`.sisyphus/sessions/<id>/\` with:

\`\`\`
.sisyphus/sessions/<id>/
├── state.json          # Session state (agents, cycles, status)
├── roadmap.md          # Strategic plan (updated by orchestrator each cycle)
├── goal.md             # Original task description
├── initial-prompt.md   # Immutable record of the initial user prompt
├── strategy.md         # High-level strategy notes
├── logs/
│   ├── cycle-000.md    # What the orchestrator did in cycle 0
│   ├── cycle-001.md    # What it did in cycle 1, etc.
│   └── ...
├── reports/
│   ├── agent-001-final.md    # Agent's final report
│   ├── agent-002-update.md   # Agent's progress update
│   └── ...
├── prompts/            # System/user prompts sent to orchestrator and agents
└── context/            # Shared context files for agents
\`\`\`

## Configuration

**Global config**: \`~/.sisyphus/config.json\`
**Project config**: \`.sisyphus/config.json\` (overrides global)

Options:
- \`model\` — Claude model for orchestrator and agents
- \`orchestratorPrompt\` — Path to custom orchestrator prompt
- \`pollIntervalMs\` — How often daemon checks pane status (default: 2000)

## Starting Sessions — Best Practices

**The /sisyphus:begin slash command** is the recommended way to start. Inside Claude Code:
\`\`\`
/sisyphus:begin
\`\`\`
Then describe your task. Claude will hand it off with the right context.

**Direct CLI:**
\`\`\`
sis session lifecycle start "task description" -c "background context"
sis session lifecycle start "Implement @requirements.md" -n my-feature
\`\`\`

**Reference files with @**: \`sis session lifecycle start "Build @docs/spec.md"\` — the orchestrator
will read the referenced file as part of its planning.

**The -c flag** adds background context the orchestrator sees but doesn't act on directly.
Use it for constraints: \`-c "Don't modify the auth module, use the existing API"\`

**The -n flag** gives the session a human-readable name for easier tracking.

## CLI Command Reference

${buildCommandTable(root)}

## Troubleshooting

**Daemon not running:**
\`\`\`
sisyphusd restart
\`\`\`

**Keybinds not working (special characters appear):**
iTerm2 → Settings → Profiles → Keys → Right Option Key → Esc+

**Agents stuck:** Check \`sis session inspect status --verbose <id>\` to see pane output. If an
agent is waiting for input, kill the session and restart with clearer instructions.

**Dashboard not opening:** Run \`sis ui dashboard\` manually. Must be inside tmux.

**Session seems hung:** Check \`tail -20 ~/.sisyphus/daemon.log\` for errors.
The daemon polls panes every 2s — if a pane dies unexpectedly, it'll be detected.
</claude-instructions>
`);
}

const STEPS: Array<() => void> = [printStep0, printStep1, printStep2, printStep3, printStep4, printStep5];

export function registerGettingStarted(parent: Command, root: Command): void {
  parent
    .command('guide')
    .description('Interactive tutorial (best with Claude Code)')
    .option('--tutorial <step>', 'Tutorial step (0-5)', parseInt)
    .option('--explain', 'Comprehensive reference for how sisyphus works')
    .addHelpText(
      'after',
      `
guide: interactive onboarding tutorial for sisyphus (best experienced inside Claude Code).

Input
  --tutorial <step>    optional — jump to a specific tutorial step; must be 0-5 (integer).
  --explain            optional boolean — print the comprehensive sisyphus reference
                       instead of the tutorial.

Output (stdout, plain text — human-readable guide, not JSON)
  Prints <claude-instructions> blocks the Claude Code agent interprets and
  presents interactively. Falls back to a short "open Claude Code first" message
  when run outside a Claude Code session.

Effects
  None. Read-only. Prints to stdout.

Exit codes: 0 ok | 2 usage (invalid --tutorial value)`,
    )
    .action((opts) => {
      if (opts.explain) {
        printExplain(root);
        return;
      }
      if (opts.tutorial !== undefined) {
        const step = opts.tutorial as number;
        if (step < 0 || step > 5 || Number.isNaN(step)) {
          console.error(`Invalid tutorial step: ${opts.tutorial}. Must be 0-5.`);
          process.exit(1);
        }
        STEPS[step]!();
        return;
      }
      if (!isClaudeCode()) {
        printNonClaudeMessage();
        return;
      }
      printStep0();
    });
}
