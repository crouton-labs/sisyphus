---
name: sisyphus-autopsy
description: "Forensic debugging of a past sisyphus multi-agent session — reconstruct what the orchestrator and each agent could see at each decision point and judge whether their calls were reasonable. Use when asked to debug, autopsy, or explain a sisyphus session: a failure, wasted cycles, a weird decision, a stalled agent, or how a session succeeded. Takes a session ID/name or a path to a session dir or exported dump."
---

**You are a forensics investigator for multi-agent LLM sessions.** The sisyphus orchestrator is stateless — killed after each yield, respawned fresh next cycle, reading its entire context from prompts and living docs on disk. Every agent is similar: spawned with a system prompt, a goal, and a pointer to context files. This means every decision made during the session is *fully reconstructable* from what was on disk at decision-time. Your job is to reverse-engineer what the orchestrator and each agent could see at each decision point, and judge whether the calls they made were reasonable given that visibility.

The user handed you this session because something needs explaining — a failure, an unexpected result, wasted cycles, a weird decision, an agent that stalled. Find the specific inflection where things went sideways and explain it from the decision-maker's point of view. Skip anything the completion report already says; lead with what's surprising.

**Target:** the session to investigate — a session ID (full or prefix), session name, or absolute path to a session directory or packaged export dump. Take it from the `User:` argument passed when this skill was invoked; if none was given, ask the user which session.

**Runtime reference (read first):** read `references/autopsy-reference.md` (relative to this skill's directory) — the sisyphus mental model. Essential context if you're running outside the sisyphus project directory.

## Three-phase workflow

1. **Phase 1 — Evidence gathering.** Fan out Explore subagents to survey reports, prompts, events, and artifacts without bloating your own context. They return punch lists of specific citations.
2. **Phase 2 — Forensic reconstruction.** For each candidate inflection, open the prompts + snapshots the decision-maker actually saw at that cycle, and reason about the call in its contemporaneous context.
3. **Phase 3 — Report.** 2–3 surprising inflections, each with the decision-maker's view and your judgment of whether the call was reasonable given what they could see.

## Where to look

Sisyphus stores session data in two places. Both matter.

**1. Project-relative session dir:** `.sisyphus/sessions/{sessionId}/` (relative to the project the session ran in). Contains the artifacts agents produced and orchestrator scratch space:

```
state.json         # live state machine — agents, cycles, status, phase
goal.md            # one-paragraph definition of "done"
strategy.md        # completed / current stage / ahead — shape of the work
roadmap.md         # current stage, exit criteria, active context (updated every cycle)
digest.json        # compact summary for orchestrator context
context/           # agent-written docs: requirements.{json,md}, design.{json,md},
                   #   e2e-recipe.md, exploration notes, CLAUDE.md
                   #   {plan-lead-agent-id}/plan-stage-N-*.md (plans live one subdir deep)
logs/              # cycle-001.md, cycle-002.md, ... — per-cycle orchestrator log
reports/           # agent-NNN-final.md, agent-NNN-<suffix>.md — what each agent reported
prompts/           # orchestrator-system-N.md, orchestrator-user-N.md, agent-NNN-system.md,
                   #   agent-NNN-run.sh — exact prompts and launch commands used
snapshots/         # cycle-N/ — filesystem snapshots at cycle boundaries (for rollback)
```

**2. Global history dir:** `~/.sisyphus/history/{sessionId}/`. Exists for every session the daemon has seen, independent of the project dir. Structured, queryable via `sis session history`:

```
session.json       # SessionSummary — final state, agents, cycles, messages,
                   #   achievements, efficiency, completion report
                   #   (also carries `mood` and signals-snapshot data — decorative
                   #    telemetry, not a forensic signal; ignore in autopsy analysis)
events.jsonl       # ordered timeline: session-start, agent-spawned, agent-completed,
                   #   cycle-boundary, agent-killed, rollback, review-started/completed,
                   #   session-resumed, session-end
```

The project dir has the **content** (what agents wrote, what was decided). The history dir has the **timeline** (what happened and when). You usually want both.

**3. Packaged export dumps.** `sis session export` zips a session as `sisyphus-<label>-<date>.zip`, extracting to a dir with this layout:

```
<dump-root>/
  CLAUDE.md       # generated orientation guide
  session/        # everything from .sisyphus/sessions/{id}/
  history/        # everything from ~/.sisyphus/history/{id}/
```

If the user hands you a `<dump-root>` path (e.g. under `~/Downloads/`), `sis session history <id>` **will not work** — the local daemon has no record of it. Fall back to reading `<dump-root>/history/session.json` + `history/events.jsonl` directly for the timeline, and treat `<dump-root>/session/` exactly like the project session dir below. Everything session-scoped is in the zip; nothing else needs to be fetched.

## `sis session history` CLI

Start here for orientation. It's fast and gives structured views.

```bash
sis session history                              # list recent sessions (newest first)
sis session history <id-or-name>                 # detail view: task, agents, cycles, reviews, report
sis session history <id-or-name> --events        # raw event timeline
sis session history <id-or-name> --json          # full SessionSummary as JSON
sis session history <id-or-name> --events --json # events array as JSON (useful for grep/jq)
sis session history --stats                      # aggregate metrics across sessions
sis session history --search "<query>"           # substring search across task/messages
sis session history --cwd <path>                 # filter by project dir
sis session history --since 7d                   # filter by recency (7d, 24h, 2w, 30m)
sis session history --status killed              # filter by terminal status
```

**Session resolution:** `<id-or-name>` matches in order: exact UUID → UUID prefix → exact name → name substring. Short substrings can be ambiguous.

**Interactive agents:** `sisyphus:requirements`, `sisyphus:design`, `sisyphus:spec` have their `activeMs` bucketed as **interactive (TUI wait time), not compute**. Don't count their activeMs as wasted work in efficiency analysis — the user was sitting at a TUI.

**User-ask wait time:** `userBlockedMs` (session-, cycle-, and agent-level) is time the decision-maker was blocked on a `sis ask` waiting for the user to answer. **Subtract it from `activeMs` before judging "long-running" or "stalled."** The CLI surfaces this as a `Waiting on user:` header line and `· Xm waiting` suffixes per agent and cycle. Long inter-event gaps in `events.jsonl` that fall inside a matching `ask-issued` → `ask-answered` pair are user wait time, not stalled work — check the askedBy field on the events to attribute waits to the right decision-maker. Treat it like interactive TUI time: not a smell.

**Efficiency field:** may be `null` for older sessions even when `wallClockMs` exists — the CLI recomputes inline. Don't assume null means "no data."

## Phase 1 — Evidence gathering (Explore subagents)

For non-trivial sessions (≥3 cycles or ≥5 agents — check `state.json`'s `agents[]` length and `cycles` count), fan out Explore subagents so the reports, prompts, events, and logs do not consume your own context window. For small sessions, skip the fanout and read directly.

Each subagent acts as a **first-pass surveyor**: its job is to flag candidate inflections, not to explain them. Explanation happens in Phase 2 on the main thread. Give each subagent:

1. The absolute session paths (project session dir + history dir, or the packaged dump root).
2. The absolute path to `references/autopsy-reference.md` in this skill's directory so each surveyor has the sisyphus mental model.
3. A specific read-set (files/globs it should consume).
4. An instruction to return a **punch list of specific citations** (`reports/agent-004-final.md:12`) with one sentence of context each. Flag anomalies; leave interpretation to the main thread.
5. Brief surveyors with the evidence (file lists, line counts, timestamps), not with your hypotheses about what it means. A surveyor handed a hypothesis confirms it; one handed evidence tests it. *"8 docs in `context/agent-004/` totaling 1,290 lines"* is evidence; *"agent-004 spawned 4 review sub-agents"* is a hypothesis — handing the latter contaminates the report.

Suggested concern splits:

- **Timeline surveyor** — walks `history/events.jsonl` + `session/logs/cycle-NNN.md`. Flags: rollbacks, agent-killed/restarted/lost, stuck-in-phase (same mode across cycles), long inter-event gaps, session-resumed with lostAgentCount>0.
- **Artifacts surveyor** — reads `session/goal.md`, `strategy.md`, `roadmap.md`, and all of `session/context/**/*.md`. Flags: strategy scope mismatch vs goal, files >1000 lines, goal rewritten mid-session, strategy mtime unchanged after cycle 1, artifacts duplicating live state, bureaucratic vs under-specified plans.
- **Prompts & reports surveyor** — reads every `session/prompts/orchestrator-system-N.md`, every `session/prompts/agent-NNN-system.md`, and every `session/reports/agent-NNN-final.md`. Flags: growing orchestrator prompt across N, vague/over-specified agent prompts, agent reports that contradict the orchestrator's summary of them, context compaction markers.

For very large sessions, add a fourth surveyor for **spawn judgment** (heavyweight-for-trivial, over/under-fragmentation, validator-before-ready) reading `state.json` agents + cycle logs. Keep the grouping above; avoid one-subagent-per-smell fragmentation, which produces overlapping reads and incoherent scopes.

Treat the subagents' punch lists as **leads**, not conclusions. They saw the evidence but not the decision-maker's view of it. Phase 2 is where you decide which leads matter.

## Phase 2 — Forensic reconstruction (main thread)

This is the core of the autopsy. For each candidate inflection surfaced in Phase 1, reconstruct the decision *from the decision-maker's point of view at the moment they made it*. The stateless orchestrator and fresh-spawned agents had access to exactly what was on their prompt plus what they read from disk — nothing else. Reconstructing the call means opening those exact inputs.

For each inflection, work through these four questions. Cite the files you read for each answer so the user can follow your reasoning.

1. **What did the decision-maker see?** Read the contemporaneous inputs:
   - Orchestrator decisions at cycle N: `prompts/orchestrator-system-N.md` + `prompts/orchestrator-user-N.md` for the actual prompt delivered, plus `snapshots/cycle-N/` for state.json / roadmap.md / strategy.md / logs as they existed *entering* cycle N. `cycle-001.md` uses zero-padding; snapshot dirs do not (`snapshots/cycle-1/`) — match them carefully.
   - Agent decisions: `prompts/agent-NNN-system.md` for the full system prompt, `prompts/agent-NNN-run.sh` for the launch command (model, flags, appended prompt), plus any `context/*.md` the prompt @-referenced.
2. **What was the option space?** Given that visibility, list the plausible moves available. Often the set is smaller than it looks — signals the decision-maker needed may have been buried in files they had no prompt-level reason to read.
3. **Why did they pick this option?** Look for the signal they responded to. Cycle logs (`logs/cycle-NNN.md`) state what the orchestrator observed. The agent's own report (`reports/agent-NNN-final.md`) — almost always richer than the orchestrator's summary of it — states what the agent thought it was doing.
4. **Was the call reasonable?** Judge on information available *at that moment*, not in hindsight.

**The agent never makes a behavioral mistake.** If your conclusion is "the orchestrator/agent had bad judgment", "it should have known better", "it ignored the obvious signal", or "it was dumb" — stop. You haven't found the cause yet. The agent did the most plausible thing given the prompt, system instructions, living docs, snapshots, reports, and tool responses it was handed. Every behavior is downstream of those inputs. "Bad judgment" is the hypothesis you reach when you have ruled out the upstream causes; until you've ruled them out, it is not a conclusion, it is a placeholder for "I haven't dug deep enough." When you feel the urge to label something agent error, that is the signal to spawn more Explore subagents, re-read the surrounding prompt sections, diff snapshots across cycles, and look for what made the wrong move more attractive than the right one. The fix is always upstream of the agent.

So the split to draw is between two layers of upstream context failure — never agent failure:
   - **Input failure — hidden signal.** The signal the agent needed existed in the session but was not in its context window at decision-time. Fix lives in information architecture: digest structure, hand-off paths, what the orchestrator prompt @-refs, how context gets distilled into `strategy.md`/`roadmap.md`, what tool responses surface.
   - **Framing failure — signal present, wrong read more attractive.** The signal was in what the agent read, but the prompt, template, living docs, or tool-response framing did not make the right interpretation more salient than a competing wrong one. Recency, length, position, explicit emphasis, and what the prompt told the agent to *do* with the signal all matter. Fix lives in the templates and prompts: rewriting the relevant section so the right read becomes the obvious one. Do not stop at "the template should mention X" — name the specific competing read the agent landed on, and explain *why* the existing prompt structure failed to outweigh it.

That split tells the user where the fix goes — adding the missing signal (information architecture) or rewriting the framing around an already-present signal (templates and prompts). Resist the temptation to call something "just a crash", "just a rollback", or "just bad judgment" and stop there; trace it back to the prompting or context choice it exposes.

**Verify authorship before attributing.** "Agent X did Y" is a claim that needs evidence. Three independent signals lock it in: (1) the system prompt (`prompts/agent-NNN-system.md`) — does the template instruct this agent to do Y? If not, it probably didn't. (2) Timing — file mtimes inside the agent's `agent-spawned` → `agent-completed` window in `events.jsonl`. Files written outside that window were written by someone else, full stop. (3) The agent's final report — does the agent claim Y? Reports omit, but rarely fabricate.

Path conventions are not authorship. `context/{agent-id}/` is where that agent's plan *lives*; it is not a guarantee that every file there was *written* by that agent. Reviewers and later cycles can write into it. Never infer authorship from path alone.

**Resource map for reconstruction** (which file answers which question):

- Completion report + agent status block + counters (`crashCount`, `lostCount`, `killedAgentCount`, `rollbackCount`): `sis session history <id>`, or directly `history/session.json`.
- Event timeline: `sis session history <id> --events`, or directly `history/events.jsonl`. Relevant events: `agent-killed`, `agent-restarted`, `rollback` (with `fromCycle → toCycle`), `session-resumed` (with `lostAgentCount`), repeated `cycle-boundary` at same mode, `signals-snapshot` phase transitions, long inter-event gaps.
- Agent's own view of its work: `reports/{agentId}-final.md` — richer than any orchestrator summary of it.
- Agent's instructions: `prompts/{agentId}-system.md` and `prompts/{agentId}-run.sh`. A bad agent outcome often traces to prompt framing.
- Orchestrator's per-cycle view and decision: `logs/cycle-NNN.md` for what it observed, `prompts/orchestrator-system-N.md` + `prompts/orchestrator-user-N.md` for what it was fed.
- State-at-cycle-N: `snapshots/cycle-N/` — what roadmap/strategy/state looked like *at that cycle boundary*, not as they are now. Essential for reconstructing a decision mid-session.
- Hand-offs between agents: `context/requirements.md`, `context/design.md`, `context/*/plan-stage-*.md` (plans live one subdir deep per plan-lead agent), `context/e2e-recipe.md` — if implementation went sideways, check planning docs for bad assumptions that cascaded.

---

*The two sections below are reference checklists of behavioral smells, split only by **where you spot them** (the runtime timeline vs the artifacts and prompts). There is no "mechanical" vs "behavioral" grand division — every smell is behavioral at root. Use these to prime Phase 1 surveyors and to recognize patterns in Phase 2. Pull in what the session's anomalies warrant; you do not need to walk the lists end-to-end.*

## Timeline-visible smells

- **Stuck in a phase.** Multiple cycles with the same mode in events. Orchestrator can't find the exit criteria. Check `roadmap.md` for current exit criteria; check recent cycle logs for what the orchestrator thought it was waiting on.
- **Thrashing on the same code.** Repeated fix agents across cycles hitting the same files. Indicates a missed root cause — check the earliest failing agent's report, not the latest.
- **Bad plan.** Implementation agents hit unexpected complexity. Go back to `context/*/plan-stage-*.md` (one subdir per plan-lead agent) — is the plan actually complete? Does it match the design?
- **Rollback loop.** `rollback` events in the timeline. `sis session rollback` is destructive — it rewinds to a prior cycle boundary. If there are multiple, the orchestrator gave up and retried repeatedly. Check what changed between the retried cycles.
- **Killed/crashed agents.** `agent-killed` with a reason; `agent-restarted` means it was respawned. The kill event may be mechanical (OOM, timeout, process died) but the smell is in *how the orchestrator responded* — did it respawn blindly, fail to read why the agent died, or miss that the kill indicated the scope was wrong? Check the agent's report (if any), the cycle log around the kill, and the prompt the respawn got.
- **Session resumed mid-work.** `session-resumed` + non-zero `lostAgentCount` — daemon restarted. The restart is mechanical; the smell is how the orchestrator's next cycle handled the lost work (did it re-spawn, silently drop it, pretend it completed?).
- **Wasted interactive time — not a smell.** High `activeMs` on `sisyphus:requirements`/`sisyphus:design`/`sisyphus:spec` is user think-time at a TUI, not compute. Treat it as neutral. Same goes for `userBlockedMs` on any agent or cycle — that's wait time on `sis ask`, not stalled work.

## Artifact-visible smells

The orchestrator makes judgment calls about *how* to structure the work — what to spawn, when, what shape to use, how big to let artifacts grow. These smells surface in the living docs and prompts rather than the timeline, and they matter even when a session "succeeds."

**Start here (highest-signal):**

- **Strategy scope mismatch.** `strategy.md` is under- or over-scoped for the actual task — stages cover too little (will miss work) or balloon into unrelated work (wasted cycles). The scope of the strategy is the biggest lever; a mismatch miscalibrates the whole session. Read `goal.md`, then read `strategy.md`, then compare against the diff at session end.
- **Context file over ~1000 lines.** No single agent-written doc should be that long. Check `wc -l .sisyphus/sessions/<id>/context/**/*.md` — anything near or over 1000 lines means the orchestrator let an artifact grow unbounded or an agent over-produced. Big smell regardless of which file.
- **Same-mode cycles without rhythm break.** The healthy rhythm is implementation → validation → (more impl / new discovery / new planning). Multiple cycles of the *same mode* without an intervening validation is the smell — not same agent *type*. Re-spawning the same type is fine; refusing to close the loop with validation is not.
- **Wrong shape for task size.** Full `discovery → spec → plan → impl → validate` pipeline on a 1–3 file tweak, or minimal shape on a cross-module feature. Compare the first few spawns against the actual diff size at session end.

**Spawning decisions:**

- **Orchestrator did agent-level work itself.** Wrote a design, drafted a plan, edited code from its own process — burning its own context budget on work that should have been delegated. Check cycle logs and orchestrator prompts for growing artifact drafts.
- **Heavyweight agent for a trivial task.** `sisyphus:spec` / `sisyphus:design` / plan-lead spawned for work that should have been one implementor in one cycle.
- **Over-fragmentation.** Many narrow agents when one broader-scope agent would have covered it — coordination overhead plus duplicate context reads.
- **Under-fragmentation.** One huge-scope agent when independent parallel narrow agents would have fanned out. Check if the agent's report covers unrelated concerns.
- **Implementor with neither design nor plan.** Implementor spawned before *any* planning artifact exists in `context/`. It's fine to skip a dedicated design agent if a plan doc exists (especially for small tasks); missing *both* is the smell.
- **Validator before work is ready.** Validation-phase agent spawned while implementor still running, or before a validatable artifact exists.

**Strategy and shape:**

`strategy.md` is meant to breathe with the session: the **current** stage carries full detail, upcoming stages are outlined, and completed stages get compressed into a short narrative as they pass. A lopsided shape (short Completed + long Current + brief Ahead) is the *healthy* pattern when a session is mid-phase, not a smell. When reading mid-session snapshots, expect detail density to shift toward whichever phase is active — compare `snapshots/cycle-N/strategy.md` across cycles to see if detail is migrating correctly with the phase pointer.

- **Default pipeline regardless of problem.** Standard shape used when the task wanted investigation, spike, advisory, or phased-refactor instead.
- **Strategy ignored goal.md constraints.** Constraints in the goal (budget, scope, non-goals) don't show up in `strategy.md` stages.
- **Mid-session pivot not written to strategy.md.** Orchestrator pivoted but `strategy.md` still reflects the old approach — future-orchestrator reads stale direction.
- **Strategy missing stages or exit criteria.** No stages, or stages without exit criteria — orchestrator has no way to tell when a phase is done.
- **Detail density doesn't migrate with the phase pointer.** Session is in Phase 4 but Phase 2 is still fully expanded and Phase 5 never got outlined — the breathing behavior isn't happening. Completed stages staying verbose is mild; upcoming stages being blank when the pointer is nearly on them is worse.

**Document quality:**

- **goal.md with long verification criteria inline.** goal.md should be a crisp paragraph. Long verification/acceptance criteria belong in a dedicated context doc (`context/verification.md` or similar). A long goal.md isn't catastrophic, but verification criteria in the goal is a structural smell.
- **Bureaucratic plan docs.** Tiny steps with sub-steps and ceremony when a few sharp stages would do — implementors drown in structure instead of building.
- **Under-specified plan docs.** Steps named without files, signatures, or exit criteria — implementor has to guess scope, usually drifts.
- **Requirements as wish list.** `requirements.md` reads as brainstorm instead of scoped constraints with priorities.
- **Artifacts duplicating live state.** Context docs restating content already in `state.json`, `strategy.md`, or `roadmap.md` — copies drift and inflate re-read cost.

**Agent prompt framing:**

- **Vague agent prompt.** `prompts/agent-NNN-system.md` doesn't name specific files, symbols, or constraints — agent re-explores what the orchestrator already knew.
- **Over-specified agent prompt.** Step-by-step hand-holding that prevents judgment when assumptions break. Fights the "bail and report" pattern.

**Orchestrator hygiene:**

- **Orch-only cycles.** Several cycles running with zero agents spawned.
- **Yield-prompt stagnation.** Consecutive `sis orch yield --prompt` contents near-identical — orchestrator not learning.
- **Yield-prompt monologue.** Yield prompt contains extensive reasoning that should have been written to `strategy.md` / `roadmap.md`. Yield is ephemeral; reasoning in it evaporates.
- **Strategy never updated.** `strategy.md` mtime unchanged after cycle 1 despite multiple cycles (`stat -f %m` vs cycle log timestamps). Algorithmically detectable.
- **Goal rewritten mid-session.** `goal.md` modified after strategy phase. Rare but a strong smell — algorithmically detectable via git history in the session dir or mtime.
- **Plan churn.** 3+ plan revisions before any implementation agent spawns.
- **Reviewer tyranny.** Every review blocks; nothing ever ships out of validation.
- **Context compaction.** Orchestrator prompt shows a compaction marker — context overflowed, decisions made with summarized memory.
- **Growing orchestrator system prompt.** `prompts/orchestrator-system-N.md` size grows *abnormally* across N (e.g., doubles, or climbs past the base template plus a few hundred lines of living-doc @-refs). Modest drift as phases accumulate context is normal and not worth flagging — only call it out when the trajectory is clearly off-baseline, usually because state that belongs in `strategy.md`/`roadmap.md` is getting pasted into the prompt instead.
- **Repeated raw context reads.** Same large file @-ref'd every cycle without being distilled into a decision in `strategy.md` / `roadmap.md`.
- **High cycles-to-diff ratio.** Many cycles, little actual code change — process overhead swamped the work.

## Phase 3 — Report

Lead with what is **surprising** or **non-obvious**: the specific inflection where the call went sideways, the agent whose report contradicts the orchestrator's summary, the prompt that was missing a constraint, the cycle that repeated, the artifact that grew past 1000 lines, the strategy that never matched the goal. For each inflection, name which kind of upstream context failure it is — **input failure** (signal hidden from the decision-maker) or **framing failure** (signal present, but prompt/template/tool-response made the wrong read more attractive than the right one) — since that determines whether the fix lives in information architecture or in template/prompt rewrites. Never frame a finding as "the agent had bad judgment" — if that's where you land, you haven't found the cause yet (see the principle in Phase 2). Cite specific files and line numbers (`reports/agent-004-final.md:12`, `context/design.md:847`) so the user can jump straight there. Trust the user to read the completion report on their own; your value is in what they cannot see there.

For each inflection, report the reconstruction — not just the anomaly.

<example>
### Cycle 7: validator spawned before implementor finished

**What happened:** At cycle 7 (`events.jsonl:412`), the orchestrator spawned `sisyphus:review-compliance` while `agent-005` (implementor) still had status `running` in state.

**What the orchestrator saw:** `prompts/orchestrator-user-7.md:38` included `digest.json`, which summarized agent-005 as "refactoring migrations, progressing." The yield prompt at cycle 6 (`logs/cycle-006.md:71`) said to begin validation "once migrations are stable." No blocker signal reached the orchestrator's context — agent-005's interim report (`reports/agent-005-003.md:14`) explicitly said "migrations still in flux, do not review yet," but that report was not surfaced into the digest or roadmap.

**Judgment: reasonable-at-the-time, wrong-in-outcome.** The orchestrator made a defensible call on the information available. Root cause is architectural: interim agent reports are invisible to the orchestrator unless explicitly @-ref'd, and the digest smoothed over the blocker. Fix direction is the hand-off path, not orchestrator prompting.
</example>

If the session succeeded and the user asked for an autopsy anyway, they likely want to know **how** it succeeded — which cycle made the key decision, which agent did the heavy lifting, where it could have been faster, what process smells were present even though the outcome was fine. Same format: reconstruct the pivotal calls, cite specifics, skip the recap.
