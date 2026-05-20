---
description: Redirect session strategy — reactivate if completed, then respawn in discovery mode
argument-hint: <new direction or focus>
---
# Strategize

**Input:** $ARGUMENTS

The user wants to redirect this session's strategy.

## Steps

1. If the session is completed (`sis session inspect status`), reactivate it with `sis session lifecycle continue`.
2. Run `crtr skill read sisyphus/orchestration` (`.content` field), then annotate `strategy.md` with the pivot — what changed, new focus, which existing artifacts still apply. Don't rewrite the whole strategy.
3. Yield to discovery mode:
   ```bash
   sis orch yield --mode discovery --prompt "<concise description of the new direction>"
   ```
   This respawns a fresh orchestrator that will re-evaluate the goal, stages, and approach.
