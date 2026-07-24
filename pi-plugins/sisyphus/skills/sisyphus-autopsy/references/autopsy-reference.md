# Sisyphus runtime reference (for autopsy)

This reference explains how sisyphus orchestrates multi-agent work so you can diagnose a session's history — including when invoked from outside the sisyphus project directory.

## What sisyphus is

A tmux-integrated daemon that orchestrates Claude Code multi-agent workflows. A **stateless orchestrator** decides work, then spawns **agents** in tmux panes to do it. Session state lives on disk in a predictable structure — agents can't talk to each other except through files and the daemon.

## Two-layer agent hierarchy

```
orchestrator (stateless, killed each cycle, re-orients from disk)
  └─ agents (long-running, various models, work in parallel tmux panes)
       └─ sub-agents (spawned via Agent tool inside a parent agent — invisible to orchestrator)
```

- **Orchestrator** owns ambition and process shape — decides *what* to build, *when* to ship. Spawns agents, reads their reports, decides the next move. Killed after every yield; a fresh instance re-orients by reading disk.
- **Agents** own discipline and narrow scope. One job each. Primary failure mode is scope creep. "Bail and report" is load-bearing — agents stop and report unexpected complexity rather than improvising.
- **Sub-agents** are invisible to the orchestrator. Only the parent agent sees them. They don't appear in session events or state.

## Cycle lifecycle

```
spawn → read disk state → decide → spawn agents → wait → read results → yield (die) → respawn fresh
```

Diagnostic consequences:

- Everything the orchestrator "knows" across cycles is in files. If a fact isn't on disk, it was lost.
- Yield prompt (`sis orch yield --prompt "..."`) is the only direct orchestrator → future-orchestrator channel, and it's ephemeral.
- Cycle logs (`logs/cycle-NNN.md`) are the orchestrator's memory of its own decisions.

## Orchestrator modes (phases)

The orchestrator runs in modes that shape its behavior:

- `discovery` — explore problem space and codebase
- `spec` — produce requirements + design (often via interactive TUI agents)
- `planning` — produce plan-stage docs from the design
- `implementation` — spawn implementors against the plan
- `validation` — verify result against goal/requirements
- `completion` — wrap up

Phase transitions are shaped by exit criteria in `roadmap.md`. "Stuck in a phase" usually means the orchestrator can't see its exit criteria or they were never written.

## Communication channels

| Channel | Direction | Mechanism |
|---|---|---|
| Context artifacts | agent → future agents | Files in `context/` — designs, requirements, plans, explorations |
| Reports | agent → orchestrator | `sis agent submit` (terminal) / `sis agent report` (non-terminal) |
| State | daemon → orchestrator | `state.json` — agent statuses, session metadata |
| Events | daemon → history | `events.jsonl` — timestamped lifecycle events |
| Ask | agent → user | `sis ask deck submit <deck.json>` — submits a structured `Deck` of `Interaction[]`; user answers via the dashboard's full-screen resolution mode. Always blocking (caller waits for `output.json`); to avoid tying up a shell, callers invoke via the Bash tool with `run_in_background: true` and observe completion via `BashOutput`. `sis ask state poll <askId>` blocks on a known askId; `sis ask state peek <askId>` is non-blocking |
| Yield prompt | orchestrator → next orchestrator | `sis orch yield --prompt "..."` |

### `sis ask` deck schema

Agents submit a `Deck` (JSON file). Disk layout per ask: `<sessionDir>/context/ask/<askId>/{decisions.json,progress.json,meta.json,output.json,visuals/<qid>.{md,ansi}}`.

```ts
interface Deck {
  title: string;                 // non-empty deck-level inbox topic
  source?: { sessionName?: string; askedBy?: string; blockedSince?: string };
  interactions: Interaction[];   // non-empty
}

interface Interaction {
  id: string;                    // /^[A-Za-z0-9_-]+$/, ≤64 chars, unique within deck
  title: string;                 // non-empty; ≤4 words is convention, not enforced
  subtitle?: string;             // why this matters
  body?: string;                 // optional inline directive-flavored markdown (validated via humanloop's checkMarkdown)
  bodyPath?: string;             // mutually exclusive with body; relative to deck file dir; inlined at submit
  options: InteractionOption[];  // 0..N
  allowFreetext?: boolean;       // user may type instead of / alongside option
  freetextLabel?: string;
  kind?: 'notify' | 'validation' | 'decision' | 'context' | 'error';  // display hint, opaque to humanloop
}

interface InteractionOption { id: string; label: string; description?: string; shortcut?: string }
interface InteractionResponse { id: string; selectedOptionId?: string; freetext?: string }
```

Output (`output.json`) shape: `{responses: InteractionResponse[], completedAt: string}`. Blocking submit prints this JSON to stdout and exits 0.

## Session anatomy

**Project-relative** (the *content* layer): `.sisyphus/sessions/<uuid>/`

```
state.json         # daemon-managed state machine — agents, cycles, status, phase (atomic writes only)
goal.md            # what "done" looks like — should be a crisp paragraph
strategy.md        # completed / current stage / ahead — shape of the work, living document
roadmap.md        # current stage, exit criteria, active context — updated every cycle
digest.json        # compact summary for orchestrator context
context/           # agent-written docs: requirements.{json,md}, design.{json,md},
                   #   e2e-recipe.md, exploration notes, CLAUDE.md
                   #   {plan-lead-agent-id}/plan-stage-N-*.md (plans live one subdir deep per plan-lead)
logs/              # cycle-001.md, cycle-002.md, ... — per-cycle orchestrator log (zero-padded)
reports/           # agent-NNN-final.md, agent-NNN-<suffix>.md — what each agent reported
prompts/           # orchestrator-system-N.md, orchestrator-user-N.md, agent-NNN-system.md,
                   #   agent-NNN-run.sh — exact prompts and launch commands used
snapshots/         # cycle-N/ — filesystem snapshots at cycle boundaries (rollback-restorable;
                   #   NOT zero-padded — don't glob interchangeably with logs/)
```

**Global** (the *timeline* layer, daemon-tracked): `~/.sisyphus/history/<uuid>/`

```
session.json       # SessionSummary — final state, agents, cycles, messages, mood,
                   #   achievements, efficiency, completion report
events.jsonl       # ordered timeline: session-start, agent-spawned, agent-completed,
                   #   cycle-boundary, agent-killed, rollback, review-started/completed,
                   #   session-resumed, session-end
```

The project dir has the **content** (what agents wrote, what was decided). The global dir has the **timeline** (what happened, when). Diagnostics usually need both.

If invoked outside the project: the global history dir is always accessible at `~/.sisyphus/history/<uuid>/`. To find the project dir for a given session, read `session.json` — it usually records `cwd`. If the project dir isn't accessible, you can still do a lot from the global timeline alone (events, summary, completion report, mood, efficiency).

## `sis session history` CLI

```bash
sis session history                              # list recent sessions (newest first)
sis session history <id-or-name>                 # detail view: task, agents, cycles, reviews, report
sis session history <id-or-name> --events        # raw event timeline
sis session history <id-or-name> --json          # full SessionSummary as JSON
sis session history <id-or-name> --events --json # events array as JSON (for grep/jq)
sis session history --stats                      # aggregate metrics
sis session history --search "<query>"           # substring search across task/messages
sis session history --cwd <path>                 # filter by project dir
sis session history --since 7d                   # filter by recency
sis session history --status killed              # filter by terminal status
```

Session resolution order: exact UUID → UUID prefix → exact name → name substring. Short substrings can be ambiguous — prefer UUID prefixes when the name isn't unique.

## Workflow shapes

```
discovery → spec → planning → implementation → validation     # full feature
exploration → spike → implementation → validation              # uncertain feasibility
investigation → recommendation → (user decides)                # advisory
analysis → phased-transformation → verification                # refactor
```

Small tasks (1–3 files, single domain) often skip most stages entirely. The shape is the biggest orchestrator lever; a mismatched shape miscalibrates the whole session.

## Human-in-the-loop

The user is a stakeholder, not a project manager. They answer clarifying questions, express preferences, and approve — but don't drive.

| Stage | Human decision | Why here |
|---|---|---|
| Strategy | Confirm goal interpretation | Wrong goal = wasted session |
| Spec | Approve design + requirements | Wrong spec = wrong implementation |
| Implementation | Intervene if something looks wrong | Mostly autonomous |
| Validation | Sign off on final result | Only human confirms "done" |

Interactive agents (`sisyphus:requirements`, `sisyphus:design`, `sisyphus:spec`) talk directly to the user in their tmux pane. Their `activeMs` is **TUI wait time, not compute** — don't flag it as inefficiency in efficiency analysis.

## Recovery mechanics

- `sis agent restart <id>` — respawn a killed/failed agent in a new pane (preserves session)
- `sis session rollback <sessionId> <cycle>` — destructive rewind to a prior cycle boundary
- Agent failures don't kill the session; orchestrator reads the failure next cycle and decides
- If the orchestrator dies mid-cycle, agents keep working

## Healthy document shapes

When a session is running well, its artifacts have these shapes. Deviations are smells:

- **goal.md** — one crisp paragraph; definition of done. Long verification/acceptance criteria belong in a dedicated context doc (`context/verification.md` or similar), not in goal.md itself.
- **strategy.md** — stages (completed / current / ahead) with exit criteria; lives as an action plan, not a wiki. Scope should match the task — under-scoping misses work, over-scoping balloons into unrelated effort.
- **roadmap.md** — current stage (with a status line describing what is happening right now), exit criteria, active context. No "next steps" or predictions. Should update every cycle.
- **requirements.md** — scoped constraints with priorities, not a wish-list brainstorm.
- **design.md** — architecture decisions tied to requirements; names specific files, types, boundaries.
- **plan-stage-N-*.md** — sharp stages with files / signatures / exit criteria. Not bureaucratic step lists; not vague either.
- **Any context file over ~1000 lines** — smell regardless of which file. No single agent-written doc should be that long.

## Key insights for diagnostics

- **The orchestrator knows nothing across cycles that isn't on disk.** If a decision isn't in `strategy.md` / `roadmap.md` / cycle log / yield prompt, it evaporated.
- **Yield prompt is ephemeral.** Reasoning monologued into the yield prompt is lost next cycle; it should have been distilled into `strategy.md` / `roadmap.md`.
- **Strategy is the biggest lever.** Wrong shape or scope in `strategy.md` miscalibrates the whole session.
- **Same-mode repetition without rhythm-break is a smell.** The healthy rhythm is implementation → validation → (more impl / new discovery / new planning). Re-spawning the same agent *type* is fine; skipping the validation break is not.
- **Implementor without plan doc is a smell.** Implementor without a *design agent* is not a smell if a plan doc exists — especially for small tasks. Missing both design and plan is the smell.
- **Interactive agent activeMs is wait-time, not compute.** Don't flag `sisyphus:requirements` / `sisyphus:design` / `sisyphus:spec` activeMs as wasted work.
