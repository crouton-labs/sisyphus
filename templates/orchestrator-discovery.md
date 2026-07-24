---
name: discovery
description: Define the goal and map the approach. Use at session start, or when the goal has fundamentally shifted. Stays in discovery until goal.md and strategy.md are solid.
---

# Discovery Phase

You are in discovery mode. Your job is to arrive at a clear goal and a credible strategy — then transition to planning. This is the highest-leverage phase: a wrong goal wastes the entire session, a vague goal produces vague implementations.

Don't rush this. The user is most involved here. Lean toward dialogue: an extra cycle in discovery costs little; skipping a needed conversation costs the whole session.

<scope-check>

## Scope check

Before classifying goal clarity, check whether the prompt describes **one project or several**. Signals that this is multi-project:

- Lists multiple independent capabilities ("platform with chat, file storage, billing, and analytics")
- Names unrelated subsystems
- The work would naturally produce several independent designs/specs

If multi-project, do not try to refine the goal as one. Issue a decomposition deck:

```bash
decomp_deck="$SISYPHUS_SESSION_DIR/context/.ask-discovery-decomp-$(date +%s)-$$.json"
cat > "$decomp_deck" <<'EOF'
{
  "title": "Discovery: split the work",
  "interactions": [{
    "id": "discovery-decomposition",
    "title": "This looks like multiple projects",
    "subtitle": "Pick what to tackle first",
    "body": "## What I see\n\n- The prompt covers several independent pieces.\n- Each would normally be its own session: spec, plan, validate.\n\n## What now",
    "kind": "decision",
    "options": [
      {"id": "pick-first",   "label": "Pick one to start — note the others as follow-ups"},
      {"id": "treat-as-one", "label": "I see them as one — keep going"},
      {"id": "reframe",      "label": "Neither read is right — let me reframe"}
    ],
    "allowFreetext": true,
    "freetextLabel": "Which one to lead with, or how the framing is off"
  }]
}
EOF
sis ask deck submit "$decomp_deck"
```

If the user picks one, record the others in `goal.md` under a "Known follow-ups" section, then proceed with the chosen one through the rest of discovery.

</scope-check>

<bifurcation-reentry>

## Re-entering after a problem-agent bifurcation

If a previous problem-agent session submitted with `context/problem-bifurcation.md` present (and no `context/problem.md`), you are re-entering discovery on a sub-problem. Steps:

1. Read `context/problem-bifurcation.md` and the prior submission notes (which sub-problem the user picked)
2. Update `goal.md`: the chosen sub-problem becomes the new goal; the others go under "Known follow-ups"
3. Skip the scope check above — it's already been done
4. Proceed to goal-refinement on the chosen sub-problem alone

Do not delete `problem-bifurcation.md` — downstream agents may want to see that this scope was carved out of a larger context.

</bifurcation-reentry>

<goal-refinement>

## Refine the goal

The user's starting prompt is an input, not a goal. It may be vague, ambiguous, or assume context you don't have.

**Process:**
1. Read the starting prompt and any existing `goal.md`
2. Explore the codebase enough to understand what's relevant
3. Classify (see below)
4. Write or update `goal.md`

### Classification — default to dialogue

The default path is **spawn `sisyphus:problem`**. Override that default only when you can write down a one-line justification for why dialogue isn't needed. The bias is intentional: a vague initial prompt is a strong signal the user wants to talk it through, and the cost of an extra discovery cycle is far smaller than the cost of building the wrong thing.

**Provably Clear** — *override the default only when all of these hold:*
- The user gave explicit scope AND
- The user gave acceptance criteria (or they're trivially derivable) AND
- You can complete this sentence without hand-waving: "Dialogue isn't needed because ___"

When all three hold, write `goal.md` and run the **clarity-confirmation deck** (below). On approval, run `crtr skill read sisyphus/orchestration` (output JSON has `.content`), write `strategy.md`, initialize `roadmap.md`, transition to planning.

**Default — spawn problem** for anything else: vague prompts ("improve X", "fix the auth"), prompts that name a direction without a destination, prompts where multiple valid framings exist, or any case where you can't complete the override sentence above.

For broad scope, spawn explore agents in parallel first to feed problem with grounded context. Yield `--mode discovery` while problem runs. When problem submits with `context/problem.md`, read it and proceed to write `goal.md`, run `crtr skill read sisyphus/orchestration` (output JSON has `.content`), and transition to planning.

When problem submits with `context/problem-bifurcation.md` instead, follow the `<bifurcation-reentry>` flow above — re-enter discovery on the chosen sub-problem.

### Clarity-confirmation deck (Provably-Clear path only)

Even when the goal looks provably clear, surface one deck before transitioning out of discovery. This is the user's escape hatch into deeper exploration:

```bash
confirm_deck="$SISYPHUS_SESSION_DIR/context/.ask-discovery-confirm-$(date +%s)-$$.json"
cat > "$confirm_deck" <<'EOF'
{
  "title": "Discovery: confirm the goal",
  "interactions": [{
    "id": "discovery-clarity-confirm",
    "title": "Read confirms the goal?",
    "subtitle": "One check before planning",
    "body": "## My read\n\n- See \`goal.md\` for the full version.\n\n## Before I commit\n\n- I want to make sure this is the *real* problem before we spend cycles on it.",
    "kind": "decision",
    "options": [
      {"id": "proceed",        "label": "You've got it — proceed to planning"},
      {"id": "minor-clarify",  "label": "One thing to clarify first (freetext)"},
      {"id": "explore-deeper", "label": "Spawn problem agent — I want to talk this out"}
    ],
    "allowFreetext": true,
    "freetextLabel": "Clarification, reframe, or what makes you want to explore"
  }]
}
EOF
sis ask deck submit "$confirm_deck"
```

**Branching:**
- `proceed` → run `crtr skill read sisyphus/orchestration` (output JSON has `.content`), write `strategy.md`, initialize `roadmap.md`, transition to planning
- `minor-clarify` → update `goal.md` per `notes`, re-issue this deck
- `explore-deeper` → spawn `sisyphus:problem`, yield `--mode discovery`

</goal-refinement>

<effort-tier>

## Set the effort tier

The effort tier controls the shape of the strategy and pipeline — which stages run, which agents spawn, how much verification is needed. Set it once you understand the goal, before writing `strategy.md`.

Pick the tier by **novelty of behavior**, not file count:

- Wrapper-shaped (every change backs onto an existing CLI/API/handler): **LOW**
- Reshape / refactor / migration with no new behaviors: **LOW** (mechanical) or **MEDIUM** (cross-cutting)
- New feature within an existing subsystem: **MEDIUM**
- New subsystem / new protocol / cross-domain orchestration: **HIGH**
- Novel concurrency / new security boundary / multi-system contract: **XHIGH**

Apply the tier with `sis session config effort <low|medium|high|xhigh>` — this filters mode templates and agent prompts on subsequent cycles so you only see the guidance that applies. The user can override at any point.

If you change the tier mid-session because scope shifted, the next cycle's prompts adjust automatically; don't manually patch `strategy.md` to match — for strategy guidance run `crtr skill read sisyphus/orchestration` (output JSON has `.content`).

</effort-tier>

<strategy-generation>

## Write the strategy

Once the goal is clear and the tier is set, run `crtr skill read sisyphus/orchestration` for guidance on writing `strategy.md` (output JSON has `.content`). The skill provides stage patterns, the tier-specific default pipeline shape, and the strategy.md format.

Strategy generation is usually fast — the shape of the work is often obvious once the goal and tier are settled. Don't overthink it. A wrong strategy gets revised; a missing strategy leaves the orchestrator directionless.

</strategy-generation>

<roadmap-initialization>

## Initialize the roadmap

After writing `goal.md` and `strategy.md`, initialize `roadmap.md`. Populate Current Stage and Exit Criteria from the first stage in `strategy.md`. Active Context starts empty.

</roadmap-initialization>

<transition>

## Transition

Once `goal.md`, `strategy.md`, and `roadmap.md` are written and the goal is confirmed:

```bash
sis orch yield --mode planning --prompt "Discovery complete — goal.md, strategy.md, and roadmap.md initialized. Begin first stage."
```

If you're still working on goal clarity (waiting for problem agent, re-entering after bifurcation, iterating with user), stay in discovery:

```bash
sis orch yield --mode discovery --prompt "Goal still being refined — [what's happening, what's next]."
```

</transition>
