---
name: completion
description: Present accomplishments and get explicit user confirmation before finalizing. Use only after validation passes and all checks are satisfied.
---

# Completion Phase

You are in completion mode. Your job is to **present what was accomplished and get explicit user confirmation before finalizing the session.** This is the handoff — the user sees the results, asks questions, requests fixes, and confirms when they're satisfied.

## Build Your Understanding

Before presenting anything, read thoroughly:

1. **strategy.md** — the stages, the approach, how it evolved
2. **roadmap.md** — final state of the work
3. **Cycle history and agent reports** — what actually happened, not what was planned
4. **goal.md** — the original goal and any refinements

Synthesize this into a clear picture of what was done and how it maps to what was asked for.

## Present the Summary

Write a polished markdown summary to `$SISYPHUS_SESSION_DIR/context/completion-summary.md`:

```bash
cat > "$SISYPHUS_SESSION_DIR/context/completion-summary.md" << 'EOF'
# Session Summary
... your markdown summary ...
EOF
```

The user already knows what they asked for — don't recap the goal. Focus on what's interesting:

- **What was built** — the key deliverables, not an exhaustive file list. Highlight anything non-obvious or that diverged from the original ask.
- **Inflection points** — where the approach changed, surprising findings, tradeoffs that were made, things that were harder or easier than expected.
- **Gaps** — anything deferred, any known limitations. Be honest.
- **Validation** — brief summary of what was tested. Reference reports if the user wants detail.

Use tables, diagrams, and structured markdown freely — the deck below renders the file via `bodyPath`, so directive-flavored markdown (`:::panel`, `:::columns`, etc.) is styled in the user's resolution view. Keep it tight but visually clear. If the session was straightforward, the summary should be short. Save the detail for when the user asks.

## Ask for Sign-off via `sis ask`

Submit a structured deck pointing at `completion-summary.md` via `bodyPath`. **NEVER call `sis session lifecycle complete` until the user picks `approve`.**

Run `sis ask deck submit -h` for submission flow. The completion deck is the canonical four-branch sign-off — `approve` / `minor` / `moderate` / `major` — each routes to a different recovery (see "Handle Feedback" below). Use `bodyPath: "../completion-summary.md"` so the user reviews the rendered summary inside the deck.

```bash
result=$(sis ask deck submit "$deck")
choice=$(echo "$result" | jq -r '.responses[0].selectedOptionId')
notes=$(echo "$result"  | jq -r '.responses[0].freetext // ""')
```

## Handle Feedback

Branch on `$choice`:

### `approve` — finalize
Call `sis session lifecycle complete` (see Finalizing below). `$notes` may still contain a small follow-up — fold into the report if relevant.

### `minor` — typo, rename, small fix, cosmetic tweak
Fix it yourself directly using `$notes` as the spec. Then update `completion-summary.md` to reflect the fix and **submit a fresh deck** (new tempfile path, same shape) to re-ask. Multiple rounds of minor fixes are fine — stay in the loop.

If the iterative fix loop runs long (many rounds, context filling up), yield back to completion mode with a progress summary so you get fresh context (see Context Management below) rather than continuing to ask in the same cycle.

### `moderate` — bug, edge case, missing error handling, incomplete feature
These need agents. Use `$notes` to capture the items raised, then:

1. Update roadmap.md with the items to address
2. Update strategy.md if the approach needs adjustment
3. Yield back to implementation (or planning if the fix requires design):

```bash
sis orch yield --mode implementation --prompt "User review surfaced issues to fix: $notes. See roadmap.md for details."
```

If a single deck round surfaces multiple moderate items, capture them all in `$notes` (the freetext field) — don't ask again in the same cycle to collect more.

### `major` — new feature request, fundamental approach change, scope expansion
These change the goal itself:

1. Update goal.md with the revised scope (record the pivot, per goal.md conventions)
2. Run `crtr skill read sisyphus/orchestration` (output JSON has `.content`) and revise strategy.md with the new direction
3. Yield to discovery mode:

```bash
sis orch yield --mode discovery --prompt "User requested significant scope change: $notes. Goal and strategy updated — re-evaluate approach."
```

## Context Management

If the conversation runs long (many rounds of minor fixes, extended discussion), yield back to completion mode with a progress summary so you get fresh context:

```bash
sis orch yield --mode completion --prompt "User review in progress. Fixed: [list]. Still discussing: [list]. Awaiting final confirmation."
```

## Finalizing

Only after `$choice == "approve"` — call:

```bash
sis session lifecycle complete --report "summary of what was accomplished"
```

The report should be a concise summary suitable for session history. Reference the full completion report you presented if needed.

## Completion CLI

```bash
sis session lifecycle complete --report "summary of what was accomplished"  # finalize session (only after user confirms)
sis session lifecycle continue "new instructions"                           # reactivate a completed session
```
