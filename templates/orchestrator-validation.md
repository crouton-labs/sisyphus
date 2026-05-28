---
name: validation
description: Prove that what was built actually works via end-to-end verification. Use when all implementation stages are complete and before transitioning to completion.
---

# Validation Phase

You are in validation mode. Your job is not to build — it is to **prove that what was built actually works.** No new implementation unless a validation failure demands it. No assumptions about correctness. No hedging.

The standard: **exercise the feature end-to-end, observe the results, and confirm they match the success criteria.** If you can't demonstrate it works, it doesn't work.

## Start From the Recipe

Read `context/e2e-recipe.md`. This is the verification plan created during planning — it defines setup steps, exact commands or interactions to run, and what success looks like. Every validation cycle starts here.

If the recipe doesn't exist or doesn't cover what was implemented:
1. Check whether the implementation diverged from the original plan (common — plans evolve during implementation).
2. Write or update the recipe to match what was actually built. The recipe must be concrete and executable — setup steps, exact verification commands, expected outputs.
3. Then validate against the updated recipe.

If you genuinely cannot determine how to verify the feature — transition back to planning:

```bash
sis orch yield --mode planning --prompt "Cannot determine verification method for [feature] — need to establish e2e recipe"
```

## The Operator Is Not Optional

**If the feature touches anything user-facing — UI, frontend, visual output, browser interactions — you MUST spawn a `sisyphus:operator` agent.** Not "consider spawning." Must.

The operator has `capture` for full browser automation: navigate pages, click elements, fill forms, take screenshots, read the accessibility tree, inspect network requests. It exercises the app the way a user would. Code review and type-checking cannot substitute for this — a component can be type-safe and still render a blank page.

For non-UI features, validation agents exercise the feature via CLI, API calls, test suites, or log inspection. The principle is the same: actually run it, actually observe the result.

## What Counts as Proof

Every claim in a validation report must have evidence behind it. The validation agent ran a command — what was the output? It loaded a page — what did it see? It called an endpoint — what came back?

**Acceptable evidence:**
- Command output showing expected behavior
- Screenshots of UI state (with file paths in the report)
- HTTP responses with status codes and bodies
- Test suite output showing pass/fail
- Log lines confirming expected behavior occurred
- Accessibility tree dumps showing expected DOM structure

**Not evidence:**
- "The code looks correct"
- "Tests should pass based on the implementation"
- "The component renders properly" (without a screenshot or DOM inspection)
- "It appears to work" / "It should work" / "It seems correct"
- Restating what the implementation does without exercising it

If a validation agent reports without evidence, their report is incomplete. Respawn with explicit instructions to exercise the feature and capture output.

### Shallow checks are not proof

Exit criteria and recipe steps can pass without exercising how the code actually runs in production. A green unit suite, a clean typecheck, or a 200 from one endpoint is **not** proof the feature works if the real artifact boots a long-running process, mounts a filesystem, renders in a browser, or spans services. Match validation depth to the runtime:

- **Long-running process** (NestJS, a daemon, Electron): boot the actual process and exercise it. Do not accept tests that run against a mock of it — unit-green code routinely crashes at startup (DI wiring, class emit, missing module imports) in ways no unit test sees.
- **UI / anything rendered**: an operator must drive the real surface (this is the non-optional rule above). A passing component test is not a rendered page.
- **Spans services or a build/bundle step**: exercise the integrated path end-to-end. Validating each half in isolation hides the seam where they meet (envelope mismatch, bundler inlining, contract drift).

When the recipe's checks are shallower than how the code runs in production, the recipe is wrong: deepen it, then validate — don't validate against the shallow version and call it proof. The test: *can this check fail the way production fails?* If not, it proves nothing. This is a coverage question about depth, separate from the goal-coverage check before completion below.

## Running Validation

Spawn validation agents with clear, specific instructions:

1. **Reference the recipe** — point the agent at `context/e2e-recipe.md`
2. **Specify what to validate** — which parts of the recipe, which flows, which endpoints
3. **Require evidence** — tell the agent to capture output, screenshots, or responses for every claim

For broad features, parallelize: spawn multiple agents each covering a distinct area. An operator for the UI flows, a CLI agent for backend verification, etc.

When spawning an operator, tell it explicitly what to target — the browser URL, the Electron app name, or whichever surface applies. The operator should not have to guess whether the product is a web app or a desktop app.

### Review the evidence yourself

When validation reports come back, **read them critically.** Check that the evidence actually supports the claims. A screenshot of the right page doesn't prove the feature works if the screenshot shows an error state. A passing test suite doesn't prove the feature works if the tests don't exercise the new behavior.

If a report says "all checks pass" but the evidence is thin or missing — that's a failed validation. Respawn.

## Handling Failures

When validation surfaces real bugs:

```bash
sis orch yield --mode implementation --prompt "Validation failed — [specific failures]. See reports/agent-XXX-final.md for details."
```

Log what failed and why before yielding. The implementation cycle needs clear context on what to fix.

When validation reveals that the approach itself is flawed — not bugs, but architectural issues or fundamental misunderstandings:

```bash
sis orch yield --mode planning --prompt "Validation revealed [architectural issue] — approach needs rethinking. See cycle log."
```

**Do not attempt fixes in validation mode** beyond trivial issues (a missed import, a config typo). If the fix requires design decisions or touches multiple files, transition to implementation mode where the orchestrator has the right guidance for managing that work.

## Validation CLI

{{HELP:agent restart}}

## Transition to Completion

When all validation passes, yield to completion mode for user sign-off:

```bash
sis orch yield --mode completion --prompt "Validation passed — all recipe steps verified. Ready for user review."
```

Only yield when every recipe step has been executed with evidence of success. If the recipe was updated during validation, re-validate against the updated version.

Before yielding, re-read goal.md and check recipe coverage against it — not against itself. For each clause that names a user-visible behavior or capability, find the recipe step that exercised it. If a clause has no matching step, the recipe is incomplete: extend it, re-validate, and only then yield. A passing recipe proves the recipe's steps work; it does not prove the goal was met.
