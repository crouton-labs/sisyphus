#!/bin/bash
# PreToolUse Bash gate: agents must invoke `sis ask <deck>` (the submit
# form) with run_in_background: true. The CLI blocks until the user resolves
# the deck (potentially 10+ min); foregrounding ties up the agent's bash slot
# and pane for the duration. Allowlist `sis ask poll|peek|-h|--help` and
# bare `sis ask` (commander prints help).

if [ -z "$SISYPHUS_SESSION_ID" ] || [ -z "$SISYPHUS_AGENT_ID" ]; then
  exit 0
fi

STDIN_JSON=$(cat)

PARSED=$(echo "$STDIN_JSON" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    ti = d.get('tool_input', {}) or {}
    cmd = ti.get('command', '') or ''
    rib = ti.get('run_in_background', False)
    print(1 if rib else 0)
    print(cmd)
except Exception:
    pass
" 2>/dev/null)

RIB=$(echo "$PARSED" | head -1)
COMMAND=$(echo "$PARSED" | tail -n +2)

# Not a sis ask invocation — pass through.
if [[ ! "$COMMAND" =~ sis[[:space:]]+ask ]]; then
  exit 0
fi

# `sis ask poll|peek` — non-blocking subcommands; foreground is fine.
if [[ "$COMMAND" =~ sis[[:space:]]+ask[[:space:]]+(poll|peek)([[:space:]]|$) ]]; then
  exit 0
fi

# `sis ask -h` / `--help` / bare `sis ask` (prints help) — pass through.
if [[ "$COMMAND" =~ sis[[:space:]]+ask[[:space:]]+(-h|--help)([[:space:]]|$) ]]; then
  exit 0
fi
if [[ "$COMMAND" =~ sis[[:space:]]+ask[[:space:]]*$ ]]; then
  exit 0
fi

# Already backgrounded — pass through.
if [ "$RIB" = "1" ]; then
  exit 0
fi

REASON=$'`sis ask <deck>` blocks until the user resolves the deck (potentially 10+ minutes). Re-issue this Bash tool call with `run_in_background: true` and end your turn — the bash completion notification will wake you with stdout ready to parse. Run `echo \'{"name":"sisyphus/humanloop"}\' | crtr skill read show` (`.content`) for the full pattern.'

ESCAPED=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$REASON")
echo "{\"decision\":\"block\",\"reason\":$ESCAPED}"
exit 0
