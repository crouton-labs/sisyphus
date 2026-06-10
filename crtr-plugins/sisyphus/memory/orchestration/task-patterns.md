---
kind: reference
when-and-why-to-read: When the orchestrator is structuring roadmap.md for a specific workflow type — bug fix, feature build, refactor — this reference should be read because it gives the per-workflow plan structure, agent assignments, cycle sequencing, and failure handling.
short-form: Per-workflow work-breakdown patterns for structuring roadmap.md.
system-prompt-visibility: none
file-read-visibility: none
---
# Work Breakdown Patterns

Patterns for how the orchestrator should structure roadmap.md for common workflow types. Each pattern shows the plan structure, agent assignments, cycle sequencing, and failure handling.

---

## Bug Fix

### When to use
Something is broken. User reports a bug, test is failing, behavior is wrong.

### Plan structure
```
## Bug Fix: [description]

- [ ] Diagnose root cause of [bug description]
- [ ] Implement fix for [root cause]
- [ ] Validate fix — regression tests pass, bug is resolved
- [ ] Review fix for unintended side effects
```

### Cycle plan
- **Cycle 1**: Spawn `sisyphus:debug` for diagnosis. Yield.
- **Cycle 2**: Read diagnosis report. If confident root cause found, spawn `sisyphus:implement` for fix with the diagnosis as context. Yield.
- **Cycle 3**: Spawn `sisyphus:validate` for validation. Yield.
- **Cycle 4**: If validation passes, spawn `sisyphus:review` for review. If fails, update plan with failure context and respawn implement. Yield.
- **Cycle 5**: Review results. Complete or address review findings.

### Failure modes
- **Debug inconclusive**: Add more context to plan, respawn debug with narrower scope or different focus areas.
- **Fix breaks other things**: Validation catches this. Feed validation failures back into a new implement cycle.
- **Root cause was wrong**: Update plan with what was learned, respawn debug.

### Parallelization
Usually serial — diagnosis must complete before fix, fix before validation. Exception: if the bug affects multiple independent areas, spawn multiple debug agents in parallel.

---

## Feature Build (Small — 1-3 files)

### When to use
Clear requirements, small scope, no formal requirements document needed.

### Plan structure
```
## Feature: [description]

- [ ] Plan implementation for [feature]
- [ ] Implement [feature]
- [ ] Validate implementation
```

### Cycle plan
- **Cycle 1**: Spawn `sisyphus:plan` for planning. Yield.
- **Cycle 2**: Spawn `sisyphus:implement` with plan path. Yield.
- **Cycle 3**: Spawn `sisyphus:validate` for validation. Yield.
- **Cycle 4**: Complete or fix issues.

### Parallelization
Serial. Too small to benefit from parallel agents.

---

## Feature Build (Medium — 4-10 files)

### When to use
Feature with moderate complexity. Requirements may need clarification. Multiple files across a few modules.

### Plan structure
```
## Feature: [description]

### Requirements & Design
- [ ] (conditional) Problem exploration — if goal is nebulous, explore before spec
- [ ] Requirements — define acceptance criteria
- [ ] Design — architecture, component boundaries, data models
- [ ] Create implementation plan from requirements + design
- [ ] Review plan against requirements + design

### Implementation
- [ ] Phase 1 — [foundation/types/interfaces]
- [ ] Phase 2 — [core logic]
- [ ] Critique phases 1-2
- [ ] Phase 3 — [integration/wiring]
- [ ] Validate — smoketest full feature e2e
- [ ] Review implementation
```

Note: critique and validation are embedded between implementation phases, not deferred to the end. Phase 1 (types) is low-risk and doesn't need its own review, but critique catches issues before Phase 3 builds on them. Validation happens after integration, when all the pieces come together.

### Cycle plan
- **Cycle 0** (conditional): If the problem is nebulous — multiple valid framings, unclear what "done" looks like — spawn `sisyphus:problem` for interactive exploration. Yield `--mode discovery`. Skip if goal is clear and acceptance criteria are obvious.
- **Cycle 1**: Spawn `sisyphus:spec` for combined design + requirements. Yield. (Human iterates inside the spec session.)
- **Cycle 2**: Spawn `sisyphus:plan` for plan. Yield.
- **Cycle 3**: Spawn `sisyphus:review-plan` for review. If fail, respawn plan with issues. Yield.
- **Cycle 4**: Spawn `sisyphus:implement` for Phase 1. Yield.
- **Cycle 5**: Spawn `sisyphus:implement` for Phase 2. Phase 1 is types — low risk, doesn't need its own validation. Yield.
- **Cycle 6**: Spawn `sisyphus:review` for critique of phases 1-2. This is the checkpoint before integration builds on top. Yield.
- **Cycle 7**: Address critique findings + spawn `sisyphus:implement` for Phase 3. Yield.
- **Cycle 8**: `sis orch yield --mode validation` for e2e smoketest. Validation mode proves the feature works — operator for UI, evidence for every claim.
- **Cycle 9**: Address validation failures (back to `--mode implementation`) or complete.

### Failure modes
- **Spec needs human input**: Mark session as needing human review. Orchestrator notes open questions.
- **Plan fails review**: Feed review issues back, respawn planner.
- **Critique finds issues in foundation**: Fix before starting integration — don't build on shaky ground.
- **Validation fails**: Feed specifics back to implement agent for the failing area.

### Parallelization
Phases without dependencies can run in parallel. Types/interfaces (Phase 1) must complete before implementation phases that consume them. Critique can run alongside detail-planning for the next phase.

---

## Feature Build (Large — 10+ files)

### When to use
Cross-cutting feature, multiple domains, needs team coordination. Uses **progressive planning** — high-level outline first, then detail-plan each stage as it's reached.

### Plan structure
```
## Feature: [description]

### Requirements & Design
- [ ] (conditional) Problem exploration — if goal is nebulous
- [ ] Requirements
- [ ] Design

### Stage Outline (high-level only — no file-level detail yet)
1. [domain A foundation] — no deps — ~N cycles
2. [domain B foundation] — no deps — ~N cycles
   → critique stages 1-2 (foundation is low-risk individually, but review before building on it)
3. [domain A implementation] — depends on 1 — ~N cycles
4. [domain B implementation] — depends on 2 — ~N cycles
   → critique + validate stages 3-4 (core logic, high risk — verify before integration)
5. [integration layer] — depends on 3, 4 — ~N cycles
   → validate end-to-end (integration is where accumulated assumptions break)
6. [final review] — depends on all

### Current Stage: [whichever is active]
See context/{plan-lead-agent-id}/plan-stage-N-{name}.md for detail plan. (Path comes from the plan lead's submission report.)
- [ ] [task-level items from detail plan]
```

Note: verification checkpoints are embedded in the stage outline, not deferred to a final phase. The level of rigor varies — foundation stages get a light critique, core logic gets critique + validation, integration gets full e2e validation. This is judgment, not formula.

### Cycle plan
- **Cycle 0** (conditional): If the problem is nebulous, spawn explore agents for technical landscape (yield `--mode discovery`), then spawn `sisyphus:problem` for interactive problem exploration (yield `--mode discovery`). May take 1-3 discovery cycles. Skip if the goal and scope are already clear.
- **Cycle 1**: Spawn `sisyphus:spec` for combined design + requirements. Yield. (Human iterates inside the spec session.)
- **Cycle 2**: Spawn `sisyphus:plan` for **high-level stage outline only**. Instruction: "Outline stages, dependencies, one-sentence descriptions, cycle estimates. Include verification checkpoints between stages based on risk." If the user's initial prompt or goal.md explicitly requested tests, also spawn `sisyphus:test-spec` for test properties in parallel; otherwise skip. Yield.
- **Cycle 4**: Review outline. Spawn `sisyphus:plan` to **detail-plan stage 1 only** (provide outline as context). The plan agent saves under its own subdir and reports the full path — carry that path forward for the implement cycle. Yield.
- **Cycle 5**: Spawn `sisyphus:implement` for stage 1. If stage 2 is independent, spawn `sisyphus:plan` to detail-plan stage 2 in parallel. Yield.
- **Cycle 6**: Spawn `sisyphus:implement` for stage 2 (if detail-planned). Spawn `sisyphus:review` to critique stages 1-2 in parallel — foundation review before core logic builds on it. Detail-plan stage 3 in parallel. Yield.
- **Cycle 7**: Address critique findings. Spawn `sisyphus:implement` for stage 3. Yield.
- **Cycle 8**: Spawn `sisyphus:implement` for stage 4. Spawn `sisyphus:review` to critique stage 3 in parallel. Yield.
- **Cycle 9**: Spawn `sisyphus:validate` for stages 3-4 — core logic checkpoint before integration. Address stage 3 critique. Yield.
- **Cycle 10+**: Implement integration stage. Final review. Then `sis orch yield --mode validation` for comprehensive e2e proof.

### Failure modes
- **Detail-plan agent can't produce quality output**: The stage is still too large. Break it into sub-stages in the outline and detail-plan each sub-stage individually.
- **Integration failures**: Often means contracts between domains don't match. Spawn debug agent targeting the integration seam.
- **Stage N implementation invalidates stage N+1 outline**: Update the high-level outline. This is expected — it's why you don't detail-plan everything upfront.
- **Critique finds issues after multiple stages built on top**: This is the scenario verification checkpoints exist to prevent. If it happens, you waited too long to review — add earlier checkpoints to the roadmap going forward.

### Parallelization
Maximize within the progressive pattern. Independent stages run in parallel. Detail-planning the next stage runs alongside implementing the current one. Critique and validation agents run alongside the next stage's planning or implementation. Foundation stages complete before dependent stages. Integration waits for all domain implementations.

---

## Refactor

### When to use
Restructure code without changing behavior. Move files, rename abstractions, consolidate patterns.

### Plan structure
```
## Refactor: [description]

- [ ] Analyze current structure and plan refactor
- [ ] Capture behavioral snapshot (existing tests + manual checks)
- [ ] Execute refactor phase 1 — [structural changes]
- [ ] Execute refactor phase 2 — [update consumers]
- [ ] Validate behavior preserved — all original tests pass
- [ ] Review for missed references, dead code, broken imports
```

### Cycle plan
- **Cycle 1**: Spawn `sisyphus:plan` for analysis + `sisyphus:validate` to capture baseline (parallel). Yield.
- **Cycle 2**: Spawn `sisyphus:implement` for phase 1. Yield.
- **Cycle 3**: Spawn `sisyphus:implement` for phase 2 + `sisyphus:validate` for phase 1 (parallel). Yield.
- **Cycle 4**: Spawn `sisyphus:validate` for full validation. Yield.
- **Cycle 5**: Spawn `sisyphus:review` for final review. Complete.

### Key principle
**Behavior preservation is the only metric.** The refactor is correct if and only if all existing tests pass and externally observable behavior is unchanged.

### Parallelization
Limited. Refactor phases are often sequential (move before update consumers). Validation can run in parallel with the next phase if they touch different files.

---

## Code Review

### When to use
PR review, pre-merge check, or periodic quality audit.

### Plan structure
```
## Review: [scope]

- [ ] Review [scope] for issues
- [ ] (conditional) Fix critical/high issues found
- [ ] Verify fixes landed (type-check, tests pass)
```

### Cycle plan
- **Cycle 1**: Spawn `sisyphus:review` for review. Yield.
- **Cycle 2**: If critical/high issues, spawn `sisyphus:implement` for fixes. If clean, complete.
- **Cycle 3**: Verify fixes landed by reading fix-agent reports + running type-check/tests. Complete. Do **not** spawn a second review pass — review runs once, validation catches regressions.

### Parallelization
Review itself parallelizes internally (subagents per concern). Fix cycle is usually serial.

---

## Investigation / Spike

### When to use
Need to understand something before committing to an approach. Prototype, explore, or answer a technical question.

### Plan structure
```
## Investigation: [question/area]

- [ ] Investigate [question/area]
- [ ] Summarize findings and recommendation
```

### Cycle plan
- **Cycle 1**: Spawn `sisyphus:debug` (for code investigation) or `sisyphus:general` (for broader research). Yield.
- **Cycle 2**: Spawn `sisyphus:general` to synthesize findings. Complete.

### Parallelization
If investigating multiple independent areas, spawn parallel agents each exploring a different angle.

---

## Tactician-Driven Implementation

### When to use
The plan exists and you want automated cycle-by-cycle execution without manual orchestrator decisions. The tactician reads the plan, dispatches one phase at a time, and tracks progress.

### Plan structure
```
## Tactician Execution

- [ ] Execute implementation plan at [path] using tactician loop
```

### Cycle plan
This is a single-item pattern. The orchestrator spawns the tactician once:
- **Cycle 1**: Spawn `sisyphus:tactician` with plan path. The tactician internally dispatches implement/validate agents via submit tool actions. The orchestrator's role is minimal — just monitor the tactician's completion report.

### When NOT to use
- When you need human checkpoints between phases
- When phases have external dependencies (waiting on API access, design review, etc.)
- When the task requires creative decisions the tactician shouldn't make alone
