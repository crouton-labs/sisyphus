#!/bin/bash
# PreToolUse hook for the plan agent: enforce master-plan length limit
# at `sis agent submit` time. Masters are identified by a `## Sub-Plans`
# heading. If no master exists (no plan file declares sub-plans), every
# plan file is treated as a standalone master and must obey the limit.

if [ -z "$SISYPHUS_SESSION_ID" ] || [ -z "$SISYPHUS_SESSION_DIR" ]; then
  exit 0
fi

if [ -z "$SISYPHUS_AGENT_ID" ]; then
  exit 0
fi

STDIN_JSON=$(cat)

COMMAND=$(echo "$STDIN_JSON" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get('tool_input', {}).get('command', ''))
except Exception:
    pass
" 2>/dev/null)

# Only gate on `sis agent submit`. Anything else passes through.
if [[ ! "$COMMAND" =~ sis[[:space:]]+agent[[:space:]]+submit ]]; then
  exit 0
fi

CONTEXT_DIR="$SISYPHUS_SESSION_DIR/context"
if [ ! -d "$CONTEXT_DIR" ]; then
  exit 0
fi

AGENT_CONTEXT_DIR="$CONTEXT_DIR/$SISYPHUS_AGENT_ID"
if [ ! -d "$AGENT_CONTEXT_DIR" ]; then
  exit 0
fi

# Collect plan files. shopt -s nullglob so missing matches don't leak the glob.
shopt -s nullglob
plan_files=("$AGENT_CONTEXT_DIR"/plan-*.md)
shopt -u nullglob

if [ ${#plan_files[@]} -eq 0 ]; then
  exit 0
fi

# A "master" plan has a `## Sub-Plans` heading.
declare -a masters
declare -a standalones
for f in "${plan_files[@]}"; do
  if grep -qE "^##[[:space:]]+Sub-Plans[[:space:]]*$" "$f" 2>/dev/null; then
    masters+=("$f")
  else
    standalones+=("$f")
  fi
done

# If no declared master, every plan file is a candidate master.
if [ ${#masters[@]} -eq 0 ]; then
  masters=("${standalones[@]}")
  standalones=()
fi

# Check each master against the 200-line limit.
violations=()
for f in "${masters[@]}"; do
  lines=$(wc -l < "$f" | tr -d ' ')
  if [ "$lines" -gt 200 ]; then
    violations+=("$(basename "$f"):$lines")
  fi
done

if [ ${#violations[@]} -eq 0 ]; then
  exit 0
fi

REASON=$'Plan submission blocked: master plan exceeds 200-line limit.\n\n'
for v in "${violations[@]}"; do
  name="${v%:*}"
  lines="${v##*:}"
  REASON+="  • $name — $lines lines"$'\n'
done
REASON+=$'\n'
REASON+=$'A master plan is a navigable index (phases, task table, dependency graph, architectural decisions). Over 200 lines means one of two things:\n\n'
REASON+=$'  1. Per-file detail or code snippets that belong in sub-plans. Split it:\n'
REASON+=$'     - Keep phases + task table + decisions in the master.\n'
REASON+=$'     - Move per-domain detail into context/plan-{topic}-{domain}.md files.\n'
REASON+=$'     - Link them under a "## Sub-Plans" section in the master (that heading is how this hook identifies masters vs sub-plans).\n\n'
REASON+=$'  2. Narrative fat — repeated rationale, redundant tables, prose expanding bullet points. Trim to the structural skeleton.\n\n'
REASON+=$'Files linked from a "## Sub-Plans" heading are treated as sub-plans and are NOT subject to this limit. Do not work around the hook by renaming or deleting content — fix the underlying structure.'

ESCAPED=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$REASON")
echo "{\"decision\":\"block\",\"reason\":$ESCAPED}"
exit 0
