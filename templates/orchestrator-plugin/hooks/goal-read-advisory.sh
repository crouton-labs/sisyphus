#!/bin/bash
# PostToolUse(Read) hook for the orchestrator: when the orchestrator reads
# goal.md, surface the scope-file convention. goal.md is inlined into every
# wakeup, so the orchestrator only Reads it when it intends to edit — that's
# the moment to remind it to push concrete detail into context/scope-*.md
# rather than into the goal. Neutral guidance (additionalContext), not a block.

if [ -z "$SISYPHUS_SESSION_ID" ] || [ -z "$SISYPHUS_SESSION_DIR" ]; then exit 0; fi

STDIN_JSON=$(cat)

FP=$(printf '%s' "$STDIN_JSON" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print((d.get('tool_input') or {}).get('file_path') or '')
except Exception:
    pass
" 2>/dev/null)

[ -z "$FP" ] && exit 0

GOAL_FILE="$SISYPHUS_SESSION_DIR/goal.md"

# Only fire for the session's own goal.md (compare resolved paths).
SAME=$(python3 -c "
import os, sys
try:
    print('1' if os.path.realpath(sys.argv[1]) == os.path.realpath(sys.argv[2]) else '0')
except Exception:
    print('0')
" "$FP" "$GOAL_FILE" 2>/dev/null)

[ "$SAME" = "1" ] || exit 0

ADVISORY=$(cat <<'TXT'
Editing goal.md? Keep it to the north-star paragraph plus a `## Scope` list of references — nothing more. Put any concrete detail about one slice of the goal (a subsystem, a workstream, a newly-authorized expansion) in `context/scope-<topic>.md`, and link it from goal.md with a one-liner:
  - context/scope-backend.md — DB + API-layer refactors for X
  - context/scope-frontend.md — render-path cleanup for X

Why: goal.md is inlined into every orchestrator wakeup and capped at 100 lines, so per-slice detail here taxes every future cycle — even ones working far from that slice. Routing detail into scope files lets scope grow without rewriting the goal: a mid-session "let's also do the microservices" becomes a new scope file linked from goal.md, never a condensed or deleted goal. Maintain scope files like other context docs (current understanding, not history); they are read on demand, and strategy.md/roadmap.md point at whichever scope a stage is focused on.
TXT
)

printf '%s' "$ADVISORY" | python3 -c "
import json, sys
print(json.dumps({
  'hookSpecificOutput': {
    'hookEventName': 'PostToolUse',
    'additionalContext': sys.stdin.read(),
  }
}))
"
exit 0
