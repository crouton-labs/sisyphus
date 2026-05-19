#!/bin/bash
# Stop hook: block agent from stopping if it hasn't submitted a final report.
# Passthrough (exit 0) if not in a sisyphus session.
# Also passthrough if background tasks are still pending — the agent isn't
# actually done yet, so don't nag about submitting.

if [ -z "$SISYPHUS_SESSION_ID" ] || [ -z "$SISYPHUS_AGENT_ID" ]; then
  exit 0
fi

# Read stdin once (contains hook input JSON with stop_hook_active, transcript_path, etc.)
STDIN_JSON=$(cat)

# Guard against infinite loops — if we already blocked once and Claude is
# retrying, stop_hook_active will be true in the input JSON.
STOP_ACTIVE=$(echo "$STDIN_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('stop_hook_active',False))" 2>/dev/null)
if [ "$STOP_ACTIVE" = "True" ]; then
  exit 0
fi

# Check if the agent already submitted its final report — skip transcript scan if so
REPORT_FILE="${SISYPHUS_SESSION_DIR}/reports/${SISYPHUS_AGENT_ID}-final.md"
if [ -f "$REPORT_FILE" ]; then
  exit 0
fi

# If background tasks are still running, allow stop — the agent isn't done yet
# and Claude's own task system will handle pending-task warnings.
#
# Launches are tracked via two structured sources (no prose scraping):
#   - Bash `run_in_background: true` -> transcript's "Command running in background with ID:" line
#   - Task `run_in_background: true` -> register-bg-task.sh (PostToolUse) appends agentId to
#     $SISYPHUS_SESSION_DIR/runtime/bg-tasks/$SISYPHUS_AGENT_ID.txt
# Completions come from `queue-operation enqueue` entries with `<task-id>` markers.
# Missing/unreadable state file => launched set is empty (block by default).
BG_STATE_FILE="$SISYPHUS_SESSION_DIR/runtime/bg-tasks/$SISYPHUS_AGENT_ID.txt"
PENDING=$(echo "$STDIN_JSON" | BG_STATE_FILE="$BG_STATE_FILE" python3 -c "
import json, os, re, sys

stdin_data = json.load(sys.stdin)
transcript_path = stdin_data.get('transcript_path', '')

launched = set()
completed = set()

state_file = os.environ.get('BG_STATE_FILE', '')
if state_file and os.path.exists(state_file):
    try:
        with open(state_file) as sf:
            for line in sf:
                aid = line.strip()
                if aid:
                    launched.add(aid)
    except Exception:
        pass

if transcript_path and os.path.exists(transcript_path):
    with open(transcript_path) as f:
        for line in f:
            try:
                entry = json.loads(line)
            except Exception:
                continue

            etype = entry.get('type', '')

            if etype == 'user':
                msg = entry.get('message', {})
                content = msg.get('content', [])
                if isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict) or block.get('type') != 'tool_result':
                            continue
                        c = block.get('content', '')
                        if isinstance(c, list):
                            c = ' '.join(b.get('text', '') for b in c if isinstance(b, dict))
                        if not isinstance(c, str):
                            continue
                        m = re.search(r'Command running in background with ID: ([a-z0-9]+)', c)
                        if m:
                            launched.add(m.group(1))

            elif etype == 'queue-operation' and entry.get('operation') == 'enqueue':
                c = entry.get('content', '')
                if isinstance(c, str):
                    m = re.search(r'<task-id>([^<]+)</task-id>', c)
                    if m:
                        completed.add(m.group(1))

pending = launched - completed
print(len(pending))
" 2>/dev/null)

if [ -n "$PENDING" ] && [ "$PENDING" != "0" ]; then
  exit 0
fi

cat <<'EOF'
{"decision":"block","reason":"You have not submitted your final report. You MUST submit before stopping:\n\necho \"your full report here\" | sis agent submit\n\nInclude: what you did, what you found, exact file paths and line numbers, and verification results if applicable."}
EOF
