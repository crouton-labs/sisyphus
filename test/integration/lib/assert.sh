#!/bin/bash
# Integration test assertion library for sisyphus.
# Source this file — do not execute it directly.

[ -n "${_ASSERT_LOADED:-}" ] && return 0
_ASSERT_LOADED=1

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
RESULTS=()
TIER=""

# Paths derived from sisyphus conventions
_DAEMON_SOCK="${HOME}/.sisyphus/daemon.sock"
_DAEMON_PID="${HOME}/.sisyphus/daemon.pid"

# ---------------------------------------------------------------------------
# Tier
# ---------------------------------------------------------------------------

set_tier() {
  local tier="${1:?set_tier requires a tier name}"
  TIER="$tier"
}

# ---------------------------------------------------------------------------
# Core assertion primitives
# ---------------------------------------------------------------------------

assert_pass() {
  local name="${1:?assert_pass requires a test name}"
  PASS_COUNT=$(( PASS_COUNT + 1 ))
  RESULTS+=("PASS|${name}")
}

assert_fail() {
  local name="${1:?assert_fail requires a test name}"
  local reason="${2:-}"
  FAIL_COUNT=$(( FAIL_COUNT + 1 ))
  if [ -n "$reason" ]; then
    RESULTS+=("FAIL|${name}|${reason}")
  else
    RESULTS+=("FAIL|${name}")
  fi
}

assert_skip() {
  local name="${1:?assert_skip requires a test name}"
  local reason="${2:-}"
  SKIP_COUNT=$(( SKIP_COUNT + 1 ))
  if [ -n "$reason" ]; then
    RESULTS+=("SKIP|${name}|${reason}")
  else
    RESULTS+=("SKIP|${name}")
  fi
}

# ---------------------------------------------------------------------------
# Higher-level assertions
# ---------------------------------------------------------------------------

# assert_cmd <name> <command...>
# Runs command, suppresses stdout/stderr. Passes if exit code is 0.
assert_cmd() {
  local name="${1:?assert_cmd requires a test name}"
  shift
  if "$@" >/dev/null 2>&1; then
    assert_pass "$name"
  else
    assert_fail "$name" "command exited non-zero: $*"
  fi
}

# assert_file_exists <name> <path>
assert_file_exists() {
  local name="${1:?assert_file_exists requires a test name}"
  local path="${2:?assert_file_exists requires a path}"
  if [ -f "$path" ]; then
    assert_pass "$name"
  else
    assert_fail "$name" "file not found: $path"
  fi
}

# assert_socket_exists <name> <path>
assert_socket_exists() {
  local name="${1:?assert_socket_exists requires a test name}"
  local path="${2:?assert_socket_exists requires a path}"
  if [ -S "$path" ]; then
    assert_pass "$name"
  else
    assert_fail "$name" "socket not found: $path"
  fi
}

# assert_contains <name> <haystack> <pattern>
# Uses grep regex matching (not literal substring)
assert_contains() {
  local name="${1:?assert_contains requires a test name}"
  local haystack="${2:?assert_contains requires a haystack}"
  local pattern="${3:?assert_contains requires a pattern}"
  if echo "$haystack" | grep -q "$pattern"; then
    assert_pass "$name"
  else
    assert_fail "$name" "expected to match: $pattern"
  fi
}

# ---------------------------------------------------------------------------
# JSON / socket helpers
# ---------------------------------------------------------------------------

# send_request <json> — write JSON to daemon socket via node, return response line
send_request() {
  local json="${1:?send_request requires a JSON string}"
  printf '%s' "$json" | node -e "
const net = require('net');
const t = setTimeout(() => { process.stdout.write('TIMEOUT'); process.exit(1); }, 5000);
let buf = '';
process.stdin.resume();
process.stdin.on('data', d => { buf += d; });
process.stdin.on('end', () => {
  const s = net.connect(process.env.HOME + '/.sisyphus/daemon.sock');
  s.on('connect', () => s.write(buf.trim() + '\n'));
  s.on('data', d => {
    clearTimeout(t);
    process.stdout.write(d.toString().trim());
    process.exit(0);
  });
  s.on('error', e => { clearTimeout(t); process.stdout.write(JSON.stringify({ok:false,error:e.message})); process.exit(0); });
});
"
}

# json_field <json> <dot.path> — extract a nested field value from a JSON string
# Returns empty string if path doesn't exist (instead of crashing)
json_field() {
  local json="${1:?json_field requires a JSON string}"
  local dotpath="${2:?json_field requires a dot-path}"
  printf '%s' "$json" | node -e "
process.stdin.resume();
let buf = '';
process.stdin.on('data', d => { buf += d; });
process.stdin.on('end', () => {
  try {
    const obj = JSON.parse(buf.trim());
    const parts = process.argv[1].split('.');
    let val = obj;
    for (const p of parts) {
      if (val == null) { process.stdout.write(''); process.exit(0); }
      val = val[p];
    }
    if (val === undefined || val === null) process.stdout.write('');
    else if (typeof val === 'object') process.stdout.write(JSON.stringify(val));
    else process.stdout.write(String(val));
  } catch (e) { process.stdout.write(''); }
});
" "$dotpath"
}

# assert_json_ok <name> <response>
assert_json_ok() {
  local name="${1:?assert_json_ok requires a test name}"
  local response="${2:?assert_json_ok requires a response}"
  local ok
  ok=$(json_field "$response" "ok")
  if [ "$ok" = "true" ]; then
    assert_pass "$name"
  else
    assert_fail "$name" "expected ok:true, got: $response"
  fi
}

# assert_json_error <name> <response>
assert_json_error() {
  local name="${1:?assert_json_error requires a test name}"
  local response="${2:?assert_json_error requires a response}"
  local ok
  ok=$(json_field "$response" "ok")
  if [ "$ok" = "false" ]; then
    assert_pass "$name"
  else
    assert_fail "$name" "expected ok:false, got: $response"
  fi
}

# assert_json_field <name> <response> <dot.path> <expected>
assert_json_field() {
  local name="${1:?assert_json_field requires a test name}"
  local response="${2:?assert_json_field requires a response}"
  local dotpath="${3:?assert_json_field requires a dot-path}"
  local expected="${4:?assert_json_field requires an expected value}"
  local actual
  actual=$(json_field "$response" "$dotpath")
  if [ "$actual" = "$expected" ]; then
    assert_pass "$name"
  else
    assert_fail "$name" "expected $dotpath=$expected, got: $actual"
  fi
}

# assert_valid_json <name> <string>
assert_valid_json() {
  local name="${1:?assert_valid_json requires a test name}"
  local json="${2:?assert_valid_json requires a string}"
  if printf '%s' "$json" | node -e "
process.stdin.resume();
let buf = '';
process.stdin.on('data', d => { buf += d; });
process.stdin.on('end', () => {
  try { JSON.parse(buf.trim()); process.exit(0); } catch (e) { process.exit(1); }
});" 2>/dev/null; then
    assert_pass "$name"
  else
    assert_fail "$name" "not valid JSON: $json"
  fi
}

# ---------------------------------------------------------------------------
# Test project helpers
# ---------------------------------------------------------------------------

TEST_CWD="/tmp/sisyphus-integ-test"

# setup_test_project — create a minimal working dir for session tests
setup_test_project() {
  rm -rf "$TEST_CWD"
  mkdir -p "$TEST_CWD"
}

# cleanup_test_project — remove the test working dir
cleanup_test_project() {
  rm -rf "$TEST_CWD"
}

# extract_session_id <start-response> — extract sessionId field
extract_session_id() {
  local response="${1:?extract_session_id requires a response}"
  json_field "$response" "data.sessionId"
}

# read_session_state <sessionId> — cat state.json for a session (project-relative)
read_session_state() {
  local session_id="${1:?read_session_state requires a sessionId}"
  cat "$TEST_CWD/.sisyphus/sessions/$session_id/state.json" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Daemon lifecycle helpers
# ---------------------------------------------------------------------------

# start_daemon — start sisyphusd in background, poll for socket up to 10s
# Uses nohup + disown to avoid the daemon showing up as a shell child
# (bare `wait` would otherwise hang waiting for the daemon)
start_daemon() {
  stop_daemon  # ensure clean state
  nohup sisyphusd start >/dev/null 2>&1 &
  disown
  local deadline=$(( $(date +%s) + 10 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    [ -S "$_DAEMON_SOCK" ] && return 0
    sleep 0.2
  done
  return 1
}

# stop_daemon — kill daemon and clean up socket + pid files
stop_daemon() {
  if [ -f "$_DAEMON_PID" ]; then
    local pid
    pid=$(cat "$_DAEMON_PID" 2>/dev/null)
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
      # Wait briefly for process to exit
      local i=0
      while [ $i -lt 10 ] && kill -0 "$pid" 2>/dev/null; do
        sleep 0.1
        i=$(( i + 1 ))
      done
    fi
  fi
  rm -f "$_DAEMON_SOCK" "$_DAEMON_PID"
}

# run_doctor — run sis admin doctor, capture output
run_doctor() {
  sis admin doctor 2>&1
}

# assert_not_contains <name> <haystack> <pattern>
# Uses grep regex matching (not literal substring)
assert_not_contains() {
  local name="${1:?assert_not_contains requires a test name}"
  local haystack="${2:?assert_not_contains requires a haystack}"
  local pattern="${3:?assert_not_contains requires a pattern}"
  if echo "$haystack" | grep -q "$pattern"; then
    assert_fail "$name" "expected NOT to match: $pattern"
  else
    assert_pass "$name"
  fi
}

# assert_daemon_alive <name> — verify daemon is still responsive after an operation
assert_daemon_alive() {
  local name="${1:?assert_daemon_alive requires a test name}"
  local resp
  resp=$(send_request '{"type":"status"}')
  local ok
  ok=$(json_field "$resp" "ok")
  if [ "$ok" = "true" ]; then
    assert_pass "$name"
  else
    assert_fail "$name" "daemon not responsive"
  fi
}

# wait_for_session_status <sessionId> <expected> [timeout]
# Poll until session reaches expected status. Returns 0 on success, 1 on timeout.
wait_for_session_status() {
  local sid="$1" expected="$2" timeout="${3:-10}"
  local deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local state_json
    state_json=$(read_session_state "$sid")
    local status
    status=$(json_field "$state_json" "status")
    [ "$status" = "$expected" ] && return 0
    sleep 0.5
  done
  return 1
}

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

# print_results — emit STATUS|name lines, summary, exit non-zero on any FAIL
print_results() {
  for entry in "${RESULTS[@]}"; do
    echo "${entry}"
  done

  echo "---"
  local total=$(( PASS_COUNT + FAIL_COUNT + SKIP_COUNT ))
  echo "TOTAL: ${total} | PASS: ${PASS_COUNT} | FAIL: ${FAIL_COUNT} | SKIP: ${SKIP_COUNT}"

  [ "$FAIL_COUNT" -gt 0 ] && return 1
  return 0
}
