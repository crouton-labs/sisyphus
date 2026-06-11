---
kind: knowledge
when-and-why-to-read: When you are writing or updating strategy.md, this reference should be read because it gives the stage patterns, process shapes, and document format for mapping the shape of the work across stages.
short-form: Stage patterns and format for authoring strategy.md.
system-prompt-visibility: none
file-read-visibility: none
---
# Strategy Reference

Reference material for writing and updating strategy.md — the document that maps the shape of the work across stages.

## strategy.md Format

```markdown
## Completed
[Compressed summaries of finished stages — delete detail, keep outcomes]

## Current Stage: [name]
[Detailed process flow with exit criteria and backtrack triggers]

## Ahead
[Sketched future stages — one line each: name + what it covers]
[Only as far as you can currently see — it's OK if this is vague]
```

**Principles:**
- **Detail the current stage** — concrete enough that the orchestrator can execute without re-reading this skill
- **Sketch what's ahead** — enough continuity that future updates don't lose the thread, not so much that you're committing to unknowns
- **Every detailed stage gets exit criteria** — concrete enough to evaluate, not so rigid they become checkboxes
- **Include user gates** — where does this stage need the user? What decision or approval?

## Stages name kinds of work, not areas of code

A strategy stage is a **process phase** — `discovery`, `planning`, `implementation`, `validation`, `spike`. It describes the *kind* of thinking happening that stage. It is **not** a work-area label like `auth-refactor`, `tui-panel`, `migration-script`, or `foundations`.

Work areas are the plan agent's job. They live in `context/{plan-lead-agent-id}/plan-stage-N-*.md` and structure the implementation phase from the inside. Keep them out of `strategy.md`.

<example>
✓ Correct — process phases:
```
## Ahead
- **implementation** — phased build per the plan outline (5 sub-stages: foundations → ask-cli → tui → orphan-handling → migration). Critique + validate per stage.
- **validation** — run e2e recipe end-to-end, capture evidence, user gate.
```

✗ Wrong — work areas masquerading as stages:
```
## Ahead
- **foundations** — humanloop refactor + ask-store helpers
- **ask-cli + haiku + template** — CLI command and tool-use loop
- **tui-integration** — inbox panel and key routing
- **orphan-handling** — kill/complete paths
- **migration + e2e validation** — drop old command, run recipe
```
The second list is a roadmap of code work. Strategy.md collapses into a task list and the process shape (when do we critique? when do we validate? what's the user gate?) disappears.
</example>

When you're tempted to name a stage after a code area, that signals you're sketching the plan, not the strategy. Push that detail down into the plan agent's output and keep `strategy.md` at the process-shape layer.

## Default Pipeline Shape

The session's effort tier dictates the default pipeline. **Use this shape unless the problem explicitly demands more or less.** The user can change tiers via `sis session effort <low|medium|high|xhigh>`.

<!--EFFORT:LOW-->
**Pipeline:** `plan → implement → validate`

A single plan agent, a single implement agent, a single validate agent. No spec, problem, test-spec, or review-plan stages — the user's request is the requirement; ask in-band if anything's ambiguous. If the work is wrapper-shaped (every change backs onto an existing CLI/API/handler), move directly from discovery into implementation mode without a planning-mode cycle at all.
<!--/EFFORT-->

<!--EFFORT:MEDIUM-->
**Pipeline:** `(spec, if behavior changes) → plan → implement → validate`

Add `sisyphus:review-plan` only when the plan covers multi-domain integration. Add `sisyphus:test-spec` **only when the user's initial prompt or goal.md explicitly requested tests** (e.g. "with tests", "TDD", "include unit tests", "test coverage"). Silence is a "no" — do not proactively ask, do not infer from feature risk. Spawn `sisyphus:spec` and `sisyphus:problem` only when the goal has multiple valid framings or the design space is genuinely open.
<!--/EFFORT-->

<!--EFFORT:HIGH,XHIGH-->
**Pipeline:** `discovery → spec → planning (with parallel review-plan) → phased implementation with critique/validate checkpoints → validation`

`sisyphus:review-plan` runs after the plan is drafted. `sisyphus:spec` spawns whenever a feature adds user-visible behavior. `sisyphus:problem` spawns when the goal is nebulous. Append `+ test-spec` to the planning stage **only when the user's initial prompt or goal.md explicitly requested tests** (e.g. "with tests", "TDD", "include unit tests", "test coverage"); silence is a "no." When justified, `sisyphus:test-spec` spawns in parallel with the high-level plan at Cycle 2, not after implementation — post-implementation test-spec silently describes what the code does rather than what it should do.
<!--/EFFORT-->

**Re-evaluate the tier when scope shifts mid-session.** A MEDIUM feature that uncovers a new subsystem may have crossed into HIGH; a HIGH feature whose scope was narrowed may have dropped to MEDIUM. Re-run `sis session effort` and re-invoke this skill rather than continuing under the old tier's pipeline.

## Choosing a Different Shape

If the default doesn't match the problem, these canonical progressions are the next-best starting points — pick the closest one and prune what's already clear, rather than inventing custom shapes:

```
discovery → spec → planning → implementation → validation
exploration → spike → design → implementation → validation
investigation → recommendation → (user decides) → implementation
analysis → phased-transformation → verification
discovery → product-design → technical-investigation → architecture → implementation → validation
```

Add a new stage *type* only when the problem demands a kind of work the patterns don't cover — for example a `spike` to prove feasibility, a `compatibility-check` before a migration, or a `prototype` before committing. The test for "is this a real new stage?" is whether it names a different kind of thinking, not a different slice of code.

## Stage Patterns

Use these as starting points. Invent new stage types when the problem demands it. Add backtrack edges where you can foresee things going wrong.

### discovery
**Use when:** Goal is undefined, ambiguous, or has shifted — need to clarify what "done" looks like before any other stage runs. Also re-entered mid-session when a pivot invalidates the current goal.
- Process: read prior context (goal.md, prior strategy if any) → if the goal is provably clear, write goal.md and run the clarity-confirmation deck → otherwise spawn `sisyphus:problem` for interactive exploration → user iterates → fold result into goal.md → set effort tier → write or revise strategy.md
- Exit: goal.md is current and confirmed; effort tier is set; strategy.md exists for this iteration
- Produces: goal.md, strategy.md, optionally context/problem.md or context/problem-bifurcation.md
- Backtrack: if scope reveals multiple independent projects, issue a decomposition deck and let the user pick a lead — record the others under "Known follow-ups" in goal.md

### exploration
**Use when:** Need to understand the technical landscape before committing to an approach.
- Process: spawn explore agents (each producing a focused context doc) → review findings → identify gaps → re-explore or converge
- Exit: enough understanding to make decisions — key questions answered, relevant patterns documented
- Produces: context documents (one per investigation angle, not one sprawling doc)

### spike
**Use when:** Feasibility is uncertain — need to prove an approach works before investing in full design.
- Process: identify the riskiest assumption → build a minimal prototype that tests it → evaluate results → present findings to user if the spike changes the approach
- Exit: feasibility confirmed or denied with evidence, decision on path forward
- Produces: spike findings in context/, prototype code (may be throwaway)
- Backtrack: if spike fails → re-explore alternatives

### spec
**Use when:** Need to define what to build and how, in a single interactive session.
- Process: spawn sisyphus:spec → lead explores codebase, asks user questions, dispatches engineer for design and a single writer for requirements → user reviews via TUI → lead deepens design with findings
- Exit: user-approved design + requirements with testable acceptance criteria
- Produces: context/design.md + context/design.json + context/requirements.json + context/requirements.md
- Backtrack: if problem was misframed → re-explore or re-discover

### planning
**Use when:** Design approved, need an executable breakdown.
- Process: spawn plan lead with spec outputs (requirements + design) as inputs → adversarial review of plan → create e2e verification recipe
- Exit: reviewed plan + executable e2e-recipe.md that defines how to prove the feature works
- Produces: phased implementation plan + e2e recipe in context/
- Backtrack: if plan reveals design infeasibility → revisit spec

### implementation
**Use when:** Plan exists, time to build.
- Process: for each phase → detail-plan → spawn implement agents → single critique pass → refine → validate phase
- Exit: all phases validated with evidence, no critical review findings remain
- Loops: none within a phase — review runs once, fixes land, then validation. If review surfaces architectural issues, backtrack to plan; otherwise advance.
- Backtrack: if 2+ agents hit same unexpected complexity → revisit plan or spec; if review finds architectural issues → revisit plan

### validation
**Use when:** Implementation complete, need to prove it works end-to-end.
- Process: run full e2e recipe → collect evidence (command output, screenshots, responses) → assess against success criteria → step back and check if the goal is actually met
- Exit: all recipe steps pass with concrete evidence, original goal satisfied
- Produces: validation report with evidence
- Backtrack: if bugs found → implementation; if architectural issues → spec

## Mid-session shape revisions

When the work in flight reveals the strategy itself is off, escalate up this ladder — reach for the lowest-cost move that fits.

1. **Revise in place.** Stage detail evolved but the pipeline shape holds. Edit `strategy.md` and `roadmap.md`; continue.
2. **`sisyphus:strategize`.** Approach is wrong but artifacts (specs, explorations, reports) still apply. Annotates the pivot into `strategy.md` and yields `--mode discovery` with a fresh orchestrator.
3. **`sis session clone <goal>`.** The session is actually two (or more) independent projects. Forks scope into a new top-level session; update `goal.md`/`roadmap.md` here to drop what was cloned.
4. **`sis session rollback <sessionId> <cycle>`.** A specific cycle introduced state to discard. Rewinds and pauses the session — cycles after the target are lost. Last resort; the others preserve history.

When the user is the source of the change, update `goal.md` first — strategy revision is downstream of goal.

## Design Philosophy

Frameworks to inform process shape selection — use them to *choose the right shape*, not to follow mechanically:

- **Double Diamond** — Diverge to explore, converge on a definition; diverge on solutions, converge on implementation. Use when requirements are unclear or the problem needs defining.
- **OODA (Observe–Orient–Decide–Act)** — Tight sensing/reacting loops. Use when the situation is fluid and the cost of wrong moves is low (debugging, spikes, incident response).
- **Cynefin** — Match approach to domain. Clear → best practice. Complicated → analyze then execute. Complex → probe, sense, respond. Chaotic → act to stabilize.
