---
name: planning
description: Deep exploration, spec alignment and detailed roadmap creation. Use after discovery is complete and before implementation begins.
---

# Planning Phase

<planning-workflow>

The natural sequence: **context → spec → roadmap refinement → detailed planning.** Context documents come first because they feed everything downstream — spec leads, planners, and implementers all benefit from not having to re-explore the codebase. After the spec is aligned, revisit the roadmap — that's when you actually understand scope well enough to flesh out phases honestly.

</planning-workflow>

<exploration>

Use explore agents to build understanding before making decisions. Each agent saves a focused context document to `$SISYPHUS_SESSION_DIR/context/`.

- **Each agent produces a focused artifact** — not one sprawling document. Focused documents can be selectively passed to downstream agents.
- **Conventions and patterns are high-value** to capture. Implementation agents that receive convention context write consistent code.
- **Exploration serves different purposes at different stages.** Early exploration is architectural. Later exploration before a specific stage is tactical — files, patterns, utilities to reuse.
- **Delegate understanding of unfamiliar territory.** If the task touches an unfamiliar library or subsystem, spawn an agent to investigate and report.

</exploration>

<spec-alignment>

<!--EFFORT:LOW-->
**Skip spec.** Treat the user's request as the requirements. If something's ambiguous, ask the user in-band — don't spawn `sisyphus:spec` or `sisyphus:problem`. Move directly into plan delegation below.
<!--/EFFORT-->

<!--EFFORT:MEDIUM-->
Spec is the combined product discovery + technical design stage. Spawning a spec agent hands off both to a specialist that collaborates with the user directly: exploring the codebase, asking informed questions, drafting a design, writing EARS requirements with TUI review, and deepening the design with what was learned.

**Spawn `sisyphus:spec` only when the goal has multiple valid framings or the design space is genuinely open.** Single-feature work within a known subsystem rarely needs a spec session — the implementation plan and TUI review cover the design questions. If you're unsure, ask the user in-band before spawning.

**Spec refinement is iterative.** When a spec is spawned, the process doesn't end when documents are saved:
- Have agents review requirements for feasibility (can this actually work given the codebase?)
- **Fold new knowledge into authoritative documents.** When reviews, exploration, or user feedback resolve questions or change the understanding, update requirements and design documents directly — they are the single source of truth. Delete resolved questions from their listing sections, then update the topical sections where those answers belong so the document reads as settled fact. Don't create correction files, addendum files, or decision logs alongside them.
<!--/EFFORT-->

<!--EFFORT:HIGH,XHIGH-->
Spec is the combined product discovery + technical design stage. Spawning a spec agent hands off both to a specialist that collaborates with the user directly: exploring the codebase, asking informed questions, drafting a design, writing EARS requirements with TUI review, and deepening the design with what was learned.

**When to spawn a spec agent:**
- Any feature that adds or changes user-visible behavior
- Any task where you're making assumptions about what "done" looks like
- When exploration revealed ambiguity, trade-offs, or multiple valid interpretations

**When you can skip spec:**
- Pure bug fixes with clear reproduction steps
- Mechanical refactors with no behavioral change (rename, extract, move)
- Tasks where the user has already provided explicit, detailed acceptance criteria in their starting prompt

If you're unsure, spawn the spec agent. The cost of a short spec conversation is low. The cost of building the wrong thing is an entire wasted implementation cycle.

**Spec refinement is iterative.** The spec agent works with the user, but the process doesn't end when documents are saved:
- Have agents review requirements for feasibility (can this actually work given the codebase?)
- **Fold new knowledge into authoritative documents.** When reviews, exploration, or user feedback resolve questions or change the understanding, update requirements and design documents directly — they are the single source of truth. Delete resolved questions from their listing sections, then update the topical sections where those answers belong so the document reads as settled fact. Don't create correction files, addendum files, or decision logs alongside them.
<!--/EFFORT-->

</spec-alignment>

<plan-delegation>

Once you have context docs and aligned spec outputs (requirements + design), revisit the roadmap — this is the first point where you understand real scope. Roadmap refinement means updating the three canonical sections: current stage, exit criteria, and active context references. Decisions from exploration and spec work fold into context documents — not the roadmap.

Spawn **one plan lead** per feature (or per phase — see phase-scoped planning below). Point it at inputs (requirements, design, context docs) — not a pre-made structure. The plan lead handles its own decomposition: it assesses scope, delegates sub-plans if needed, runs adversarial reviews, and delivers a synthesized master plan. **Delegate outcomes, not implementations** — tell the plan lead what needs planning and why, not how to structure the plan.

**Don't split planning yourself.** If the orchestrator pre-splits into "backend plan agent" and "frontend plan agent," the plan lead's synthesis step — resolving cross-domain conflicts, finding gaps, stress-testing edge cases — never happens.

**When to spawn multiple plan leads:** Only for genuinely independent features with no shared files or integration points.

</plan-delegation>

<plan-review-and-test-spec>

<!--EFFORT:LOW-->
**Skip plan review and test-spec.** The plan agent's output is taken at face value — implementation flows directly from plan to implement. If the plan turns out to be wrong, the implement-cycle's review catches it.
<!--/EFFORT-->

<!--EFFORT:MEDIUM-->
After the plan lead delivers:

- Spawn `sisyphus:review-plan` only when the plan covers multi-domain integration. For single-domain plans, the implementation cycle's review catches issues without a dedicated review pass.
- Spawn `sisyphus:test-spec` **only when the user's initial prompt or goal.md explicitly requested tests** (e.g. "with tests", "TDD", "include unit tests", "test coverage"). Silence is a "no" — do not proactively ask, do not infer from feature risk. Reviews and validation cover correctness without a test-spec.

If neither applies, transition straight to implementation.
<!--/EFFORT-->

<!--EFFORT:HIGH,XHIGH-->
After the plan lead delivers, `sisyphus:review-plan` runs alongside the planning cycle as an adversarial review of the plan against the requirements and design. Spawn it after the plan is drafted; feed findings back to the plan lead. Address review findings before transitioning to implementation.

Spawn `sisyphus:test-spec` **only when the user's initial prompt or goal.md explicitly requested tests** (e.g. "with tests", "TDD", "include unit tests", "test coverage"). Silence is a "no" — do not proactively ask, do not infer from feature risk. When test-spec is justified, spawn it **in parallel with the high-level plan**, not after implementation — post-implementation test-spec silently describes what the code does rather than what it should do. Its output then feeds the implementation phase as a verification target.
<!--/EFFORT-->

</plan-review-and-test-spec>

<phase-scoped-planning>

## Plan One Phase at a Time for Multi-Phase Features

Count the implementation phases in `strategy.md`.

- **One phase:** spawn the plan lead with the full feature scope.
- **More than one phase:** spawn the plan lead for the next phase only. What you learn implementing Phase N informs Phase N+1 before it's committed to paper.

The cycle shape:

```
plan phase 1 → implement phase 1 → validate phase 1 → plan phase 2 → implement phase 2 → validate phase 2 → ...
```

**Not every phase needs its own plan cycle.** Before yielding back, look at phase N+1 in `strategy.md`. If it's wrapper-shaped (every change backs onto an existing CLI/API/handler), mechanical (rename, move, reformat), or scoped to a single agent-cycle of work, yield directly to implementation and let the implement agent work from `strategy.md` plus what phase N taught you. Reserve the plan cycle for phases where the *how* is genuinely open.

After a phase's implementation passes e2e validation, yield for the next phase — pick the mode that matches its shape:

```bash
# Phase N+1 needs planning (default):
sis orch yield --mode planning --prompt "Phase N validated. Plan phase N+1 per strategy.md."

# Phase N+1 is wrapper-shaped or single-cycle:
sis orch yield --mode implementation --prompt "Phase N validated. Implement phase N+1 per strategy.md."
```

When spawning the phase-scoped plan lead, name in the prompt:
- Which phase from `strategy.md` is in scope
- Which design document or phase-section applies
- That later phases are out of scope

Plans save under the plan lead's own subdirectory: `context/{plan-lead-agent-id}/plan-{topic}.md` (or `plan-phase-N-{topic}.md` when the phase identifier helps discoverability). Sub-plans share the same subdir. The plan lead reports the exact paths in its submission — use those verbatim; don't reconstruct them.

</phase-scoped-planning>

<progressive-development>

Not all tasks need the same process depth.

- **Small task** (1-3 files, single domain): Skip phases — roadmap is a short checklist (diagnose, fix, validate). Single plan agent, single implement agent.
- **Large task** (3+ stages, multiple domains): Full phased development. The roadmap tracks phases; each phase is planned, implemented, and validated before the next is planned (see phase-scoped planning above).

Signs you need phased development: multiple unfamiliar subsystems, the task spans different concerns (backend, frontend, IPC), or the spec has more than 3 distinct work areas.

</progressive-development>

<verification-planning>

Before implementation begins, determine how to concretely verify the change works end-to-end. This is the single most common failure mode: agents report success but nothing actually works.

If you cannot determine a concrete verification method, **ask the user via `sis ask`**. Propose 2-4 candidate verification approaches as options (not an open-ended question). Do not proceed to implementation without a verification plan.

Before authoring the deck, **run `sis ask deck submit -h`** for option-design guidance and submission flow. Ground options in this feature's actual surface (manual UI? integration test? log inspection? metric delta?) — not generic placeholders.

Write the recipe to `context/e2e-recipe.md` with setup steps, exact commands or interactions to verify, and what success looks like. Make it executable, not aspirational. Implementation agents and validation agents both reference this file.

</verification-planning>

<planning-cli>

## Planning CLI

```bash
sis session inspect requirements --export --session-id <id>  # render requirements.json → requirements.md (no LLM tokens)
```

The requirements export renders a `requirements.json` to markdown without consuming LLM tokens.

</planning-cli>

<transition>

When you have enough understanding, a reviewed plan, and a verification recipe — transition explicitly:

```bash
sis orch yield --mode implementation --prompt "Begin implementation — see roadmap.md and the plan file path the plan lead reported (under context/{plan-lead-agent-id}/)."
```

The `--mode implementation` flag loads implementation-phase guidance for the next cycle.

After implementation is complete, transition to validation mode to prove the feature works:

```bash
sis orch yield --mode validation --prompt "Implementation complete — validate against context/e2e-recipe.md"
```

</transition>
