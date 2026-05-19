#!/bin/bash
set -euo pipefail
if [ -z "${SISYPHUS_COMPANION_CWD:-}" ]; then exit 0; fi
SESSION_ID=$(jq -r '.session_id // empty')
[ -n "$SESSION_ID" ] || exit 0
exec sis companion context --cwd "$SISYPHUS_COMPANION_CWD" --session-id "$SESSION_ID"
