---
kind: skill
when-and-why-to-read: When you are about to reason about a sisyphus session, diagnose an orchestration failure, or author a sisyphus extension, this skill should be read because it gives the runtime mental model — orchestrator/agent/sub-agent boundaries, the daemon, cycles, and workflow patterns — that the rest only makes sense against.
short-form: Runtime mental model and agent boundaries for the sisyphus multi-agent orchestration system.
system-prompt-visibility: name
file-read-visibility: none
---
# Sisyphus Runtime Model

Sisyphus is a tmux-integrated daemon that orchestrates Claude Code multi-agent workflows. Understanding how it works is essential for reasoning about sessions, diagnosing failures, and making good decisions about how to structure work.

## The Stateless Orchestrator

The orchestrator is the central coordination point — but it's **stateless and ephemeral**. After every yield, the orchestrator process is killed. A fresh instance is respawned for the next cycle. It has no memory of previous cycles except what's on disk.

This means:
- All state lives in files: `state.json`, `goal.md`, `strategy.md`, `roadmap.md`, context artifacts
- The orchestrator re-orients every cycle by reading these files
- If a file wasn't written, the knowledge is lost — there's no implicit state
- `sis orch yield` is a death sentence for the current process, not a pause

**Cycle lifecycle:** spawn → read disk state → decide what to do → spawn agents → wait for completion → read results → yield (die) → respawn fresh

## Two-Layer Agent Hierarchy

```
orchestrator (stateless, opus, killed each cycle)
  └─ agents (long-running, various models, work in parallel tmux panes)
       └─ sub-agents (spawned by parent agent via Agent tool, invisible to orchestrator)
```

**Orchestrator** owns ambition, quality standards, and process shape. It decides *what* to build and *when* to ship. It spawns agents, reads their reports, and decides the next move.

**Agents** own discipline and narrow scope. Each agent has one job. Their primary failure mode is scope creep, not lack of ambition. The "bail and report" pattern (stop work, report unexpected complexity, let orchestrator decide) is load-bearing — over-reporting is cheap, a bad implementation is expensive.

**Sub-agents** are invisible to the orchestrator. Only the parent agent spawns and manages them. They're defined as `.md` files in a subdirectory matching the parent agent's name (e.g., `agents/spec/engineer.md`). The daemon copies these into the agent's plugin directory at spawn time.

### When to use each level

| Level | Use when | Examples |
|---|---|---|
| Mode (orchestrator phase) | The *kind of thinking* changes | strategy → planning → implementation → validation |
| Agent | Independent, parallelizable work unit | implement a feature, explore a subsystem, review code |
| Sub-agent | Domain expertise within a parent's scope | engineer writes design, critic reviews plan, writer produces requirements |

## Communication Channels

Agents can't talk to each other directly. All communication is mediated through files and the daemon.

| Channel | Direction | Mechanism |
|---|---|---|
| Context artifacts | agent → future agents | Files in `context/` — exploration docs, designs, requirements, plans |
| Reports | agent → orchestrator | `sis agent submit` (terminal) or `sis agent report` (non-terminal) |
| State | daemon → orchestrator | `state.json` — agent statuses, session metadata |
| Events | daemon → history | `events.jsonl` — timestamped lifecycle events |
| Yield prompt | orchestrator → next orchestrator | `sis orch yield --prompt "..."` — continuation instructions |

**Key insight:** the yield prompt is the orchestrator's only way to talk to its future self. Everything important must be either in a file or in the yield prompt. The cycle log (`logs/cycle-NNN.md`) is the orchestrator's memory.

## Human-in-the-Loop

The user is a stakeholder, not a project manager. They answer questions, express preferences, and approve — but they don't drive the process. The orchestrator does.

**Where yields land and why:**

| Stage | Human decision | Why here |
|---|---|---|
| Strategy | Confirm goal interpretation | Wrong goal = entire session wasted |
| Spec | Approve design + requirements | Wrong spec = wrong implementation |
| Planning | (usually none) | Plans are internal — user sees results |
| Implementation | Intervene if something looks wrong | Mostly autonomous |
| Validation | Sign off on final result | Only human can confirm "done" |

**Interactive agents** (like `sisyphus:spec` and `sisyphus:problem`) talk directly to the user in their pane. The orchestrator spawns them and waits — it doesn't intermediate the conversation.

## Rollback and Recovery

- `sis agent restart <id>` — respawn a killed/failed agent in a new pane (preserves session state)
- `sis session rollback <sessionId> <cycle>` — destructive rewind to a prior cycle boundary
- Agent failures don't kill the session — the orchestrator reads the failure in the next cycle and decides what to do
- The daemon keeps agents alive independently; if the orchestrator dies mid-cycle, agents continue working

## Session Anatomy

```
.sisyphus/sessions/<uuid>/
  state.json          # daemon-managed, atomic writes only
  goal.md             # what "done" looks like
  strategy.md         # shape of work (living document)
  roadmap.md          # cycle-to-cycle progress
  digest.json         # dashboard summary
  context/            # all artifacts — designs, requirements, plans, explorations
  logs/               # cycle-NNN.md — orchestrator's memory
  reports/            # agent-NNN-final.md — agent deliverables
```

## Common Workflow Shapes

```
discovery → spec → planning → implementation → validation     # full feature
exploration → spike → implementation → validation              # uncertain feasibility
investigation → recommendation → (user decides)               # advisory
analysis → phased-transformation → verification               # refactor
```

The orchestrator picks the shape that fits the problem. Stages can be skipped, repeated, or invented. Small tasks (1-3 files, single domain) skip most stages entirely.

## Debugging Sessions

```bash
tail -f ~/.sisyphus/daemon.log    # daemon logs (real-time)
sisyphus status                    # session + agent state snapshot
sis admin doctor              # health check: tmux, Claude CLI, launchd
sis admin history             # browse past sessions
sis admin history show <id>   # inspect a specific session's events
```

When investigating a session failure, read the cycle logs (`logs/cycle-NNN.md`) first — they capture the orchestrator's reasoning and decisions at each step. Agent reports (`reports/agent-NNN-final.md`) have the detailed work output.

## Source Material

For deeper reading on specific topics:
- `templates/CLAUDE.md` — orchestrator lifecycle, session directory structure, phase transitions
- `templates/agent-plugin/agents/CLAUDE.md` — agent constraints, context chain, review actions
- `.claude/rules/agent-prompts.md` — prompt design philosophy (narrow scope, defensive posture, bail-and-report)
- `.claude/rules/orchestrator-prompts.md` — orchestrator prompt philosophy (ambition, quality standards, process over motivation)
