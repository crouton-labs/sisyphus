#!/bin/bash
# PostToolUse(Write|Edit|MultiEdit) hook for the orchestrator: enforce the
# 100-line cap on goal.md. The edit has already landed (PostToolUse runs after
# success); if goal.md is now over the cap, emit a decision:block so the
# orchestrator must trim it and move the detail into context/scope-*.md before
# proceeding. Under the cap → silent passthrough.

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

SAME=$(python3 -c "
import os, sys
try:
    print('1' if os.path.realpath(sys.argv[1]) == os.path.realpath(sys.argv[2]) else '0')
except Exception:
    print('0')
" "$FP" "$GOAL_FILE" 2>/dev/null)

[ "$SAME" = "1" ] || exit 0
[ -f "$GOAL_FILE" ] || exit 0

LINES=$(python3 -c "
import sys
try:
    with open(sys.argv[1], encoding='utf-8') as f:
        print(sum(1 for _ in f))
except Exception:
    print(0)
" "$GOAL_FILE" 2>/dev/null)

[ -z "$LINES" ] && exit 0
if [ "$LINES" -le 100 ]; then exit 0; fi

REASON=$(cat <<TXT
goal.md is now ${LINES} lines — over the 100-line cap. Trim it back to the north-star paragraph plus a "## Scope" reference list before continuing.

Move the detail you just added into context/scope-<topic>.md (the maintained home for one slice of the goal) and leave only a one-line pointer in goal.md:
  - context/scope-<topic>.md — one-line description

Why the cap: goal.md is inlined into every orchestrator wakeup, so length here taxes every future cycle, even ones working far from this detail. Scope files are read on demand and can be referenced from strategy.md / roadmap.md. Restructure the over-cap detail into scope files rather than deleting still-relevant scope to fit.
TXT
)

ESCAPED=$(printf '%s' "$REASON" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))")
echo "{\"decision\":\"block\",\"reason\":$ESCAPED,\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\"}}"
exit 0
