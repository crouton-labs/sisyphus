---
name: implementation
description: Execute the plan — spawn agents, maximize parallelism, review results. Use when planning is complete and the roadmap is ready for execution.
---

# Implementation Phase

<stage-execution>

## Maximize Parallelism

Before each cycle, ask: **which stages or tasks are independent right now?** If two stages touch different subsystems, spawn them concurrently.

Maximize parallelism **within your development cycle, not by skipping parts of it.** Running a review alongside the next stage's implementation is good parallelism. Skipping review because the next stage is ready is cutting corners.

If the plan has stages that share no file dependencies, run them in parallel from the start. The development cycle for each stage:

1. **Detail-plan it** — expand the outline into specific file changes. If complex, spawn a `sisyphus:spec` agent first to align design + requirements.
2. **Implement it** — spawn agents with self-contained instructions.
3. **Critique and refine it** — spawn review agents, fix what they find.
4. **Validate it** — verify the stage actually works end-to-end.

Not every stage needs every step — use the rigor calibration table above to decide.

**When multiple stages have completed without any critique or validation, stop implementing and catch up on verification.** Don't let unverified work compound.

Don't detail-plan all stages up front. What you learn implementing earlier stages should inform later ones.

</stage-execution>

<agent-instructions>

Implementation agent prompts must be **fully self-contained** — include everything the agent needs so it doesn't have to re-explore or guess:

- The overall session goal (one sentence)
- This agent's specific task (files to create/modify, what the change does, done condition)
- References to relevant context files (`conventions.md`, `explore-architecture.md`, etc.)
- The e2e recipe reference (`context/e2e-recipe.md`) for self-verification

Tell every implementation agent to report clearly when done: what they built, what files they changed, and any issues or uncertainties.

<delegate-outcomes>

### Delegate outcomes, not implementations

Define **what needs to happen and why**, not the code to write. If you're writing exact code snippets or line-by-line fix instructions in agent prompts, you're doing the agent's job.

<example>
<bad>
"Change line 45 from `x === y` to `crypto.timingSafeEqual(Buffer.from(x), Buffer.from(y))`, handle length mismatch..."
</bad>
<good>
"Fix the timing-safe comparison issue in authMiddleware.ts — see report at reports/agent-002-final.md, Major #3"
</good>
</example>

For fix agents: **pass the review report path and tell the agent to action the items.** The agent reads the report, understands the codebase, and figures out the right fix. Writing the code for them defeats the purpose of delegation.

The exception is architectural constraints the agent wouldn't know: "use the existing `personRepository.findOrCreateOwner` method" or "the Supabase client is at `supabaseService.getClient()`". Give agents the **what** and the **landmarks**, not the **how**.

</delegate-outcomes>

<context-propagation>

### Context propagation

The planning phase produced context files — conventions, e2e recipe, architectural findings. Be selective — give each agent the context relevant to their task.

<example>
<bad>
"Implement the auth middleware. Look at how the existing middleware works."
</bad>
<rationale>Vague. The agent must re-explore the codebase to find conventions and patterns.</rationale>
<good>
"Implement auth middleware per context/requirements-auth.md and context/design-auth.md. Reference context/conventions.md for middleware patterns. E2E recipe at context/e2e-recipe.md."
</good>
</example>

</context-propagation>

</agent-instructions>

<code-smell-escalation>

Instruct agents to flag problems early rather than working around them. When an agent encounters unexpected complexity, unclear architecture, or code that fights back — the right move is to stop and report clearly. A clear problem description is more valuable than a brittle implementation.

When you see these reports, investigate before pushing forward. If the smell suggests a design issue, involve the user.

</code-smell-escalation>

<critique-refinement>

## Critique Pass

After implementation agents report, assess whether the stage needs critique before advancing. The failure mode is not "sometimes skipping review" — it's implementing six stages in a row without any.

When a stage warrants critique, spawn a `sisyphus:review` agent. It will run parallel sub-reviewers across the relevant dimensions (reuse, quality, efficiency, and security/compliance when appropriate), validate their findings, and return a single consolidated report. Give it the full diff and relevant context files. It reports problems — it does not fix.

A clean report ("No concerns") is a valid and common outcome. When you get one, advance. Do not spawn another reviewer to double-check — one careful pass is the contract.

## Refine Pass

Aggregate reviewer findings, then **route each finding to where the fix actually lives**:

- **Many code corrections** — spawn fix agents and point them at the review report. You triage (skip false positives, note architectural constraints); they implement. Don't rewrite findings as line-by-line instructions.
- **Plan or context-doc fixes** — edit the document yourself. A clarified requirement, a corrected assumption, or a tweaked plan section is faster done in the orchestrator than handed to an agent. Spawning an agent to edit a markdown file is overhead, not delegation. (Massive replans are different — see backtrack guidance below.)
- **A handful of trivial code edits** (a missed import, a typo, a one-line constant) — make them yourself rather than spinning up an agent. The agent overhead exceeds the work.

```bash
echo "Fix the issues in reports/agent-003-final.md. Skip item #5 (false positive). Run type-check after." | sis agent spawn --stdin --name "fix-review-issues" --agent-type sisyphus:implement
```

Fix agents should use `/simplify` to review their own changes before reporting.

## One Review Pass Per Stage

**Do not spawn a second review after fix agents land.** The review pass runs once per stage. After fixes, verify they landed by reading the fix agents' reports and checking that type-check / tests pass — not by spawning another reviewer to re-scan the same surface.

This is a deliberate choice, not an oversight. Re-reviewing has two failure modes that compound:

1. A fresh reviewer scanning edited code will anchor on the new code and produce fresh findings, most of which are noise — the tier structure has no "nit" category and the model feels implicit pressure to return something.
2. When fix agents do introduce real regressions, they typically show up in validation (type-check failures, test failures, e2e failures) rather than in static review. Validation catches the real problems; re-review mostly catches phantoms.

If the fix agent's own report flags that it hit unexpected complexity or introduced something it wasn't comfortable with, address that specifically — read the code, decide, don't spawn another reviewer. If the single review pass surfaces findings that suggest an architectural problem rather than code-level issues, backtrack to planning instead of patching:

```bash
sis orch yield --mode planning --prompt "Review surfaced architectural issue: [summary]. Needs replan, not fixes."
```

Real regressions from fix agents are caught by e2e validation (next step), not by a second review pass.

</critique-refinement>

<e2e-validation>

E2E validation confirms the implementation actually works — not just compiles or passes unit tests. Reserve full validation for stages where you're building on accumulated work or where failure would be expensive to debug later. Don't let more than 2-3 stages accumulate without one.

Spawn a validation agent with the e2e recipe from `context/e2e-recipe.md`. The agent should:
- Follow setup steps exactly (build, start servers, seed data)
- Run every verification step
- Report exactly what passed and what failed

If the recipe involves UI, use `capture` to screenshot the running app. If API, curl the endpoints. If CLI, exercise it in the terminal.

If the project lacks validation tooling, **create it** — a smoke-test script, seed command, or health-check endpoint pays for itself immediately.

**Don't advance past a validated stage until validation passes.** If it fails, log failures, spawn fix agents, re-validate.

**Phase-scoped plans:** if the current plan only covers one phase of a multi-phase feature (the plan-lead convention when `strategy.md` has multiple phases), yield back to planning after this phase's validation passes — not to validation mode. Plan files live under `context/{plan-lead-agent-id}/`; use the paths the plan lead reported when dispatching implement agents.

```bash
sis orch yield --mode planning --prompt "Phase N validated. Plan phase N+1 per strategy.md."
```

The next cycle's plan lead incorporates what you learned here before committing phase N+1 to paper.

When all implementation phases are complete (the final phase has been planned, implemented, and stage-validated), transition to validation mode for the comprehensive final pass:

```bash
sis orch yield --mode validation --prompt "All stages implemented — validate against context/e2e-recipe.md"
```

Validation mode shifts the orchestrator's entire focus to proving the feature works. Stage-level validation during implementation catches issues early; the final validation pass proves the whole thing holds together.

</e2e-validation>

<returning-to-planning>

If the approach is wrong mid-implementation, don't keep pushing. Return to planning:

```bash
sis orch yield --mode planning --prompt "Discovered X mid-implementation — approach needs rework. See cycle log and roadmap.md."
```

Concrete triggers:
- 2+ agents report same unexpected complexity in the same subsystem
- An agent discovers a dependency that changes the approach
- Fix agents keep patching the same area across cycles

Update roadmap.md to reflect you're back in an earlier phase. Log the discovery before yielding.

</returning-to-planning>

<impl-cli>

## Implementation CLI

{{HELP:session task}}

{{HELP:agent restart}}

{{HELP:session rollback}}

</impl-cli>
