#!/bin/bash
# Block SendMessage — agents should use sisyphus CLI for reporting.
# Passthrough (exit 0) if not in a sisyphus session.

if [ -z "$SISYPHUS_SESSION_ID" ]; then
  exit 0
fi

cat <<'EOF'
{"decision":"block","reason":"Do not use SendMessage. Use the sis CLI instead:\n- Progress report: echo \"message\" | sis agent report\n- Urgent/blocking issue: sis orch message \"description\"\n- Final submission: echo \"report\" | sis agent submit"}
EOF
