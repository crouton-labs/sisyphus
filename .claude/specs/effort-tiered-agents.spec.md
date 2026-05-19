# Effort-Tiered Agent Prompts

Add a session-level `effort` tier (LOW / MEDIUM / HIGH / XHIGH) that gates how heavy the orchestration pipeline is and what each spawned agent's prompt looks like. The agent is never told what tier it's in — its rendered prompt simply contains the right instructions for the work expected of it.

## Why

Autopsy of session `2f4efcdb-40e7-4b4e-bc40-9a75c9322c6e` (keymap modernization) found that a wrappers-only refactor across ~5 files triggered the full discovery → spec → planning (parallel `plan` + `test-spec` + `review-plan`) → 6-sub-stage implementation pipeline. The `test-spec` agent produced a 601-line, 95-property behavioral checklist for what was effectively `key X triggers script Y` mappings.

Two structural causes:

1. **`templates/orchestrator-plugin/skills/orchestration/CLAUDE.md:13`** and **`task-patterns.md:149`** prescribe `sisyphus:test-spec` parallel-with-plan at cycle 2 *unconditionally* — no scale clause.
2. **`task-patterns.md`** sizes pipelines by file count (Small ≤3 / Medium 4-10 / Large 10+). It has no axis for *novelty of behavior* — a 5-file mechanical reshuffle gets the same shape as a 5-file new-subsystem.

The fix is an effort tier that's orthogonal to file count. The orchestrator infers it from goal + diff shape; the user can override.

## Design Principles (load-bearing)

These are the principles that emerged from design discussion. They constrain the implementation:

1. **Frontmatter stays standard-conformant.** Do not add new frontmatter fields like `min-effort`, `output-budget`, etc. Subagent frontmatter must remain loadable by Claude Code's standard plugin system. All effort-tier logic lives in **prompt body** content (and in orchestrator-side spawn-gating, which is template content too).
2. **The agent never sees the tier.** No `<!--EFFORT:LOW-->` markers in rendered output, no scaling tables visible, no "at LOW effort, do X" framing in the visible prompt. The renderer strips markers and emits a single coherent set of direct instructions. The agent reads its prompt as the only rule, full stop.
3. **No tier-leakage in prose.** Even within an `EFFORT:LOW` block, instructions read as direct guidance, not as conditional. Not "At LOW effort, cap at 8 properties" — just "Cap properties at 8."
4. **Bail-up on capability mismatch reads as scope, not tier.** When a low-tier agent should escalate, the framing is "if the work appears to need broader scope, bail and report — the orchestrator can re-spawn with broader scope." Never "you are at LOW effort."
5. **Render-time substitution; persist the rendered file.** `prompts/agent-NNN-system.md` is the *rendered* output, with markers stripped and tier resolved. Autopsies stay trivial — read the file, see what the agent actually saw.
6. **HIGH/XHIGH = current body text.** No markers needed for the existing prompts to keep working. Markers add LOW (and MEDIUM where distinct) variants. Migration is additive.

## The Marker Syntax

HTML comments. Single-pass string substitution. No DSL, no template engine.

```markdown
## Depth

<!--EFFORT:LOW-->
Surface-level. List the relevant files, name the key entry points, identify the obvious
patterns. Stop there.
<!--/EFFORT-->
<!--EFFORT:MEDIUM-->
Follow imports, trace data flow through 2-3 layers, read key implementations.
<!--/EFFORT-->
<!--EFFORT:HIGH,XHIGH-->
Exhaustive — full call graphs, all consumers/producers, edge cases, git history.
<!--/EFFORT-->
```

Renderer behavior:

- For session effort `T`, keep the contents of every `<!--EFFORT:T-->...<!--/EFFORT-->` block (with the markers themselves removed). Strip every other `EFFORT:*` block, including its content and markers.
- Tiers in a marker are comma-separated (`<!--EFFORT:HIGH,XHIGH-->` matches both).
- If a section has no `EFFORT:T` block at all, fall back to keeping any unmarked content as-is. (This is how HIGH/XHIGH work without explicit markers in current prompts.)
- Unknown tier names in markers: drop the block (fail closed for unknown tiers; fail open for unrecognized session effort → render as HIGH).
- Malformed markers (unbalanced, nested, etc.): preserve content, log a warning. Never silently drop content.

## Renderer Implementation

The renderer plugs into the agent spawn pipeline at the point where the system prompt is composed. Today's pipeline (`src/daemon/agent.ts:240` and surroundings) reads the agent template, composes any session-context appendix, and writes the final system prompt to `prompts/agent-NNN-system.md`.

Add a single transform between "read template" and "write rendered file":

```
read agent template (frontmatter + body)
  → apply variable substitution ($SISYPHUS_AGENT_ID, etc.)  // existing
  → apply EFFORT marker substitution (new)                   // new
  → write rendered system prompt to prompts/agent-NNN-system.md
```

The same transform applies to orchestrator system prompts (`prompts/orchestrator-system-N.md`) — `templates/orchestrator-base.md` carries the same `EFFORT:*` markers for spawn-gating doctrine and the inference heuristic (see "Orchestrator-side Spawn Gates" below). The orchestration skill files (`CLAUDE.md`, `task-patterns.md`) are loaded by Claude Code as skills and are not rendered through `renderEffortMarkers`.

## Effort Tier Source

- **Default = inferred** at strategy-write time by the orchestrator. Heuristic in `templates/orchestrator-base.md` (the `<effort-tiers>` section): tier should reflect novelty of behavior, not just file count. Wrapper-shaped work (no new invariants, just plumbing) → LOW or MED. New subsystems → HIGH. New protocols / cross-domain orchestration / novel concurrency → XHIGH.
- **User override** via `sis session effort <low|medium|high|xhigh>` (or `sis start --effort <tier>` at session creation). Override is sticky — persists in `state.json` and takes precedence over inference each cycle.
- **Persistence**: store as `state.session.effort` and surface in `digest.json`. Show in `sis status` output.
- **Display in dashboard** is out of scope for this spec; can come later.

If effort is unset (older sessions): treat as HIGH (preserve existing behavior).

## Per-Agent LOW Renders (the substantive deliverable)

EFFORT markers were inserted into 6 agent templates: `review`, `review-plan`, `plan`, `test-spec`, `research-lead`, and `problem`. These agents legitimately change fan-out shape across tiers (e.g., `review-plan` spawns 1 sub-agent at LOW, multiple at HIGH), making per-tier body text load-bearing.

Five agents originally scoped for tier-specific renders — `explore`, `debug`, `implementor`, `operator`, and `spec` (Stage 3 collapse) — were reverted to tier-agnostic. Their depth and scope flow from the orchestrator's dispatch instructions, not from hardcoded tier variants in the prompt body. Locking behavior via markers would cap autonomy in ways that should live at dispatch time. The subsections below are preserved as historical record of the path not taken.

For the 6 active agents, MEDIUM renders are usually "halfway between LOW and HIGH" — for most, leave MEDIUM = current text (HIGH default) until evidence shows we need more granularity. Where MEDIUM is explicitly distinct, it's noted.

### `explore.md` (reverted — see preamble) — replaces `## Depth` (current L47-55)

```markdown
## Depth

Surface-level. List the relevant files, name the key entry points, identify the obvious
patterns. Stop there. Do not follow imports past one hop. Do not trace data flow across
layers. Do not read git history. The output is a map, not an analysis — downstream agents
will go deeper if needed.
```

### `debug.md` (reverted — see preamble) — replaces `## Phase 2: Investigate` (current L55-66)

```markdown
## Phase 2: Investigate

Investigate solo. Read the suspect files, walk the data flow, check git blame on recent
changes near the failure. Do not spawn sub-agents.

If the bug appears to require coordinated theory-testing across 3+ modules, or behaves
intermittently in ways you can't reproduce in two read passes, **bail and report that
the dispatch scope is too narrow**. The orchestrator can re-spawn with broader scope —
under-investigating silently is the failure mode to avoid.
```

### `implementor.md` (reverted — see preamble) — replaces `## Parallelizing via Sub-agents` (current L61-72)

```markdown
## Sub-agents

Do not spawn sub-agents. Implement the slice yourself with parallel tool calls (Read /
Grep / Edit) for pattern discovery and editing.

If the slice genuinely decomposes into 2+ independent sub-slices that would benefit from
parallel execution, bail and report — the orchestrator should have spawned multiple
implementors rather than handing one slice to a single agent with sub-fan-out.
```

### `operator.md` (reverted — see preamble) — replaces `## Be Relentless` + `## Scale Your Testing` (current L94-113) with a single `## Posture` section

```markdown
## Posture

Validate the requested flow end-to-end. Add one obvious failure case (empty submission,
back-button mid-flow, or whichever maps cleanly to the flow under test). Stop there.

Do not click every interactive element. Do not stress-test edge cases beyond the one.
Do not spawn parallel sub-agents — work the flow yourself, sequentially. If the scope
genuinely needs broad surface coverage, bail and report that the dispatch should have
been a multi-flow validation rather than a single operator spawn.
```

### `plan.md` — replaces `## Scope Decision: Small or Split` through `## Hard Constraint: Master Plan ≤ 200 Lines` (current L71-225) with a single `## Plan Structure` section

```markdown
## Plan Structure

Single file. Save as `context/$SISYPHUS_AGENT_ID/plan-{topic}.md`. Keep it under 200 lines.

\`\`\`markdown
# {Topic} Implementation Plan

## Overview
[What and why, 2-3 sentences]

## Phases

### Phase 1: {Name}
- `path/to/new-file.ts` (new) — [what it contains, pattern to follow]
- `path/to/existing.ts` (modify) — [what changes]

### Phase 2: {Name}
**Depends on:** Phase 1
- ...

## Verification
[How to confirm it works]
\`\`\`

Do not spawn sub-planner sub-agents. Do not spawn review-plan sub-agents. If the work
genuinely decomposes into multiple domains or exceeds 200 lines of plan, bail and
report — the dispatch should have been re-scoped before reaching this agent.
```

(`## Plans Are Maps`, `## Phase-Scoped Planning`, `## Quality Standards`, `## Process` sections all stay — they're tier-neutral.)

### `review.md` — replaces `## Process` step 3 (Classify, current L55-61) and `## Scaling Sub-agents` (current L78-89)

```markdown
3. **Classify** — Treat the change as **minimal** depth regardless of change type.
   Sensitive code (auth, crypto, PII paths) is the one carve-out — treat that as
   standard depth.
```

```markdown
## Sub-agents

Spawn one `quality` sub-agent. Pass it the diff and file boundaries. Do not include
hypotheses or "look for X" — leading conclusions cause anchoring.

If the diff touches sensitive code (auth, crypto, PII), additionally spawn `security`
(opus). Do not spawn `reuse`, `efficiency`, `compliance`, or `tests`.
```

### `review-plan.md` — replaces `## Process` step 4 (current L50-56)

```markdown
4. **Spawn one sub-agent** — `requirements-coverage` (sonnet). Pass it the requirements,
   design documents, plan(s), and relevant codebase context. Its job is to verify every
   requirement and design constraint maps to a concrete plan section, classified as
   Covered / Partial / Missing.

   Do not spawn `security`, `code-smells`, or `pattern-consistency`. A coverage check is
   the assessment this review provides; deeper analysis is out of scope.
```

### `test-spec.md` — replaces the property-count bullet in `### Output discipline` (current L27) and the `## Standards` block (current L83-87)

`### Output discipline` (the relevant bullet, replacing current L27):

```markdown
- Cap the spec at 8 properties total. Skip the "Edge Cases" and "Negative Properties"
  sections — neither is part of this dispatch.
- Default to submitting `{ "testsNeeded": false }`. Only write properties when the change
  introduces a behavioral invariant a validator could not otherwise catch — security
  guarantees, ordering constraints, idempotency, data integrity. Mechanical input→output
  mappings (key→action, route→handler, field→column) are not invariants and do not need
  a test spec.
```

`## Standards`:

```markdown
## Standards

- **State behaviors, not implementations.** "Users can log in with email/password" not
  "loginHandler calls bcrypt.compare"
- Each property must be independently verifiable.
- If the change is mechanical input→output mapping with no behavioral invariant, submit
  `{ "testsNeeded": false }` without writing a spec file. This is the expected outcome
  for most dispatches at this scope.
- Otherwise, after writing the test spec file, call submit with `{ "testsNeeded": true }`.
```

The `## Output Format` template (current L51-79) renders without the "Edge Cases" and "Negative Properties" section headers (they're explicitly skipped at LOW).

### `research-lead.md` — replaces `## Process` Decompose / Search / Critique / Iterate / Synthesize (current L43-121) with a leaner sequence

```markdown
### 1. Decompose

Break the question into 2-3 sub-questions. Avoid overlap. The queue is flat — no
follow-up rounds, no gap questions.

### 2. Search — Dispatch Researchers

Spawn 1-2 `researcher` sub-agents in parallel via the Agent tool. One sub-question per
researcher. No round-2 follow-ups.

### 3. Draft

Maintain a living draft at `$SISYPHUS_SESSION_DIR/context/research-{topic}.md`. After
researchers return, update the draft with their findings.

### 4. Synthesize

Skip the critic step. Rewrite the draft into a final report with executive summary,
detailed sections, and source list. Surface contradictions explicitly. If evidence is
thin or sources contradict irreducibly, say so in the report — do not spawn additional
researchers to resolve it. Bail and report scope-too-narrow if the question genuinely
cannot be answered from 1-2 researcher passes.
```

### `problem.md` — replaces `### Perspective agents` (current L54-69)

```markdown
### Multi-perspective thinking — inline only

Cycle through the perspective lenses (First Principles, User Empathy, Simplifier, Systems
Thinker, Contrarian, Time Traveler, Adversarial, Precedent) inside the conversation as
you and the user explore. Weave them into your messages naturally — one lens per turn at
most.

Do not spawn perspective sub-agents. Multi-perspective fan-out is not part of this
dispatch.
```

**Note:** `problem` is heavy interactive work. The right answer is usually that the orchestrator doesn't spawn it at LOW at all (see "Orchestrator-side spawn gates"). This body conditional is the safety net for when the user explicitly forces it.

### `spec.md` and `spec-deck.md` (reverted — see preamble) — at MEDIUM (NOT LOW), Stage 3 collapses

LOW should never reach these agents (orchestrator-gated). At MEDIUM, replace `## Process: Stage 3 — Deepen` (current L162-202 in `spec.md`, L305-345 in `spec-deck.md`) with:

```markdown
## Process: Stage 3 — Finalize

### 1. Export Requirements

Run synchronously:

\`\`\`bash
sis admin requirements --export --session-id $SISYPHUS_SESSION_ID
\`\`\`

This generates `context/requirements.md` from `requirements.json`.

### 2. Final Summary

Write `meta.stage = 'stage-3-done'` to `requirements.json`. Present a summary table to
the user.

### 3. Submit

Submit the final report via `sis agent submit` with paths to the artifacts produced
(`design.json`, `design.md`, `requirements.json`, `requirements.md`).
```

The Stage 3 engineer dispatch (deepen) is removed — `design.md` from Stage 1 plus `requirements.json` from Stage 2 are the deliverable. The Subagent Dispatch Contracts section drops the "Engineer — Stage 3 (deepen)" subsection entirely. The state-machine sanity check on `design.json.meta.draft < 2` also drops, since draft 2 doesn't exist at MEDIUM.

The Bounce-to-design loop, Stage 1 readiness criterion, and Stage 2 process stay — they're correctness, not depth.

## Orchestrator-side Spawn Gates

Tier-aware orchestrator behavior lives in `templates/orchestrator-base.md`, which is the only orchestrator-side template assembled into the rendered system prompt (`prompts/orchestrator-system-N.md`). Skill files (`templates/orchestrator-plugin/skills/orchestration/*`) are loaded by Claude Code as skills and are not rendered through `renderEffortMarkers` — they revert to single-tier reference content.

The base prompt carries an `<effort-tiers>` section with three concerns:

1. **Per-tier spawn gates** for `test-spec`, `review-plan`, `spec`, `problem` — encoded as `<!--EFFORT:LOW-->...<!--/EFFORT-->`, `<!--EFFORT:MEDIUM-->...<!--/EFFORT-->`, and `<!--EFFORT:HIGH,XHIGH-->...<!--/EFFORT-->` blocks. LOW instructs the orchestrator to skip these spawns; MEDIUM gates them on behavioral-invariant criteria; HIGH/XHIGH carries the full-pipeline expectations.
2. **Per-tier default pipeline shape** — LOW = `plan → implement → validate`; MEDIUM = the LOW shape plus optional spec/test-spec/review-plan when invariants warrant; HIGH/XHIGH = the current full pipeline.
3. **Effort-inference heuristic** — wrapper-shaped → LOW; refactor/migration → LOW or MEDIUM; new feature in existing subsystem → MEDIUM; new subsystem / cross-domain → HIGH; novel concurrency / new security boundary → XHIGH. The user can override via `sis session effort`.

## Out of Scope

- Per-tier model selection (e.g., haiku at LOW, opus at HIGH). Frontmatter must stay standard-conformant; we don't touch `model:`. Defer to a future spec if model-tier-by-effort proves necessary.
- Dashboard rendering of the effort tier (icon, badge, etc.).
- Effort tier for already-running sessions (back-fill). New sessions only; existing sessions default to HIGH.
- Per-cycle effort changes (auto-escalation when a low-tier session hits unexpected complexity). For now, escalation is the orchestrator's manual call after reading a bail-up report.
- Validation that an agent's bail-up reasoning is correct (the orchestrator trusts the bail).

## Open Questions

1. Where does `effort` live in `state.json`? Suggested: `state.session.effort` as `'low' | 'medium' | 'high' | 'xhigh'`. Confirm with the daemon code before implementing.
2. Should `sis session effort` only affect future cycles, or trigger an immediate re-render of running agent prompts? Suggested: future cycles only. Running agents keep their original prompt.
3. MEDIUM is currently underspecified per agent (most agents have only LOW + HIGH/XHIGH defined). Decide per agent during implementation whether MEDIUM = LOW, MEDIUM = HIGH, or MEDIUM is its own variant. The conservative default is MEDIUM = HIGH (current behavior) for now.

## Verification

- Spawn an agent at each tier and inspect `prompts/agent-NNN-system.md`. Confirm: (a) no `<!--EFFORT-->` markers in the file, (b) the prompt body matches the tier's intended render, (c) no occurrences of the strings "LOW", "MEDIUM", "HIGH", "XHIGH" as effort labels in the rendered prompt.
- Run a session at LOW with a wrappers-only task. Confirm: orchestrator does not spawn `test-spec` or `review-plan`; `plan` produces a single file under 200 lines; `implementor` does not fan out sub-agents.
- Re-run the autopsied keymap-modernization workload at LOW. Compare cycle count and artifact sizes against session `2f4efcdb`. Target: ≤4 cycles vs the original's planned 8+, no `test-spec.md`, no `review-plan` invocation.

## Files Touched

- `src/daemon/agent.ts` (renderer wiring; effort field plumbing)
- `src/daemon/state.ts` (effort field on session state)
- `src/cli/commands/start.ts` (`--effort` flag)
- `src/cli/commands/set-effort.ts` (new)
- `src/daemon/lib/effort-render.ts` (new — `renderEffortMarkers` implementation)
- `templates/orchestrator-base.md` (new `<effort-tiers>` section with EFFORT markers for spawn gates, pipeline shape, and inference heuristic)
- `templates/agent-plugin/agents/{review,review-plan,plan,test-spec,research-lead,problem}.md` (6 files, marker insertion)
  - (`explore`, `debug`, `implementor`, `operator`, `spec` — reverted to tier-agnostic; markers stripped.)
- Skill files (`templates/orchestrator-plugin/skills/orchestration/*`) — no edits; reference content stays single-tier.

## A Note on Process for This Session

This is a wrapper-shaped + template-edit feature. The autopsy that motivated it found that sisyphus over-pipelines this exact shape. **This session should run at MEDIUM effort or LOW effort itself** — a single plan, no `test-spec`, no `review-plan`, implementor + validate. If the orchestrator's strategy reaches for parallel `test-spec` or multi-stage review-plan, that's exactly the smell this spec exists to fix. Dogfood the principle.

## Update 2026-05-01: Spawn predicate simplified

The original spec gated `sisyphus:test-spec` at MEDIUM on a "behavioral invariant" predicate (security, ordering, idempotency, data integrity) and at HIGH/XHIGH spawned it unconditionally. Autopsy of session `ddfabd77-…` (credit-counter feature) showed the predicate was still over-firing — a frontend pill + one endpoint generated a 96-invariant checklist that bound the validation cycle to a 96-item contract.

The gating predicate has been replaced with a simpler rule across all tiers: **spawn `sisyphus:test-spec` only when the user's initial prompt or goal.md explicitly requested tests** (e.g. "with tests", "TDD", "include unit tests", "test coverage"). Silence is a "no" — the orchestrator does not proactively ask, does not infer from feature risk. Reviews and validation cover correctness without a test-spec.

The agent's own LOW/MEDIUM/HIGH internal scaling (cap at 8 properties at LOW, full Edge Cases + Negative Properties at HIGH/XHIGH) is unchanged. Only the orchestrator-side spawn predicate moved.

Files updated: `templates/orchestrator-planning.md`, `templates/orchestrator-plugin/skills/orchestration/strategy.md`, `…/task-patterns.md`, `…/workflow-examples.md`, `templates/agent-plugin/agents/test-spec.md` (description only).
