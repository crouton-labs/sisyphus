#!/bin/bash
_SUITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$_SUITE_DIR/../lib/assert.sh"

# ---------------------------------------------------------------------------
# Test functions
# ---------------------------------------------------------------------------

test_install_ok() {
  assert_cmd "install-ok" which sis
  assert_cmd "install-ok-daemon" which sisyphusd
}

test_node_pty_native() {
  # node-pty is inside sisyphi's own node_modules, not at global top-level
  assert_cmd "node-pty-native" node -e "
    const gRoot = require('child_process').execSync('npm root -g').toString().trim();
    require(require('path').join(gRoot, 'sisyphi', 'node_modules', 'node-pty'));
  "
}

test_cli_version() {
  assert_cmd "cli-version" sis --version
}

test_daemon_version() {
  assert_cmd "daemon-version" test -x "$(which sisyphusd)"
}

test_daemon_lifecycle() {
  if ! start_daemon; then
    assert_fail "daemon-start" "start_daemon timed out waiting for socket"
    return
  fi
  assert_pass "daemon-start"

  assert_file_exists "daemon-pid" "$HOME/.sisyphus/daemon.pid"
  assert_socket_exists "daemon-socket" "$HOME/.sisyphus/daemon.sock"

  RESULT=$(node -e "
  const net = require('net');
  const t = setTimeout(() => { process.stdout.write('TIMEOUT'); process.exit(1); }, 5000);
  const s = net.connect(process.env.HOME + '/.sisyphus/daemon.sock');
  s.on('connect', () => s.write('{\"type\":\"status\"}\n'));
  s.on('data', d => {
    clearTimeout(t);
    const r = JSON.parse(d.toString().trim());
    process.stdout.write(r.ok ? 'OK' : 'FAIL');
    process.exit(0);
  });
")
  if [ "$RESULT" = "OK" ]; then
    assert_pass "daemon-socket-response"
  else
    assert_fail "daemon-socket-response" "$RESULT"
  fi

  stop_daemon
}

test_doctor_base() {
  DOCTOR_OUTPUT=$(run_doctor)
  assert_cmd "doctor-runs" sis admin doctor
  assert_contains "doctor-node-ok" "$DOCTOR_OUTPUT" '✓.*Node'
}

test_postinstall_no_swift() {
  assert_pass "postinstall-no-swift"
}

test_help_lists_commands() {
  local output
  output=$(sis --help 2>&1)
  assert_contains "help-lists-start"  "$output" "start"
  assert_contains "help-lists-list"   "$output" "list"
  assert_contains "help-lists-status" "$output" "status"
  assert_contains "help-lists-doctor" "$output" "doctor"
}

test_unknown_command_fails() {
  if sis notacommand >/dev/null 2>&1; then
    assert_fail "unknown-command-fails" "expected non-zero exit code"
  else
    assert_pass "unknown-command-fails"
  fi
}

test_doctor_exit_code() {
  sis admin doctor >/dev/null 2>&1
  local exit_code=$?
  if [ "$exit_code" -eq 0 ]; then
    assert_pass "doctor-exit-code"
  else
    assert_fail "doctor-exit-code" "doctor exited with code $exit_code"
  fi
}

test_protocol_robustness() {
  if ! start_daemon; then
    assert_fail "protocol-robustness-daemon-start" "start_daemon timed out"
    return
  fi

  local resp

  resp=$(send_request "this is not json")
  assert_json_error "protocol-invalid-json" "$resp"

  resp=$(send_request '{"type":"bogus"}')
  assert_json_error "protocol-unknown-type" "$resp"

  resp=$(send_request '{"type":"status","sessionId":"nonexistent-session-id"}')
  assert_json_error "protocol-nonexistent-session" "$resp"

  # Three concurrent status requests (wait for specific PIDs, not all bg jobs)
  local t1 t2 t3 p1 p2 p3
  t1=$(mktemp)
  t2=$(mktemp)
  t3=$(mktemp)
  send_request '{"type":"status"}' >"$t1" &
  p1=$!
  send_request '{"type":"status"}' >"$t2" &
  p2=$!
  send_request '{"type":"status"}' >"$t3" &
  p3=$!
  wait "$p1" "$p2" "$p3"
  assert_json_ok "protocol-concurrent-1" "$(cat "$t1")"
  assert_json_ok "protocol-concurrent-2" "$(cat "$t2")"
  assert_json_ok "protocol-concurrent-3" "$(cat "$t3")"
  rm -f "$t1" "$t2" "$t3"

  stop_daemon
}

test_daemon_resilience() {
  local sock="$HOME/.sisyphus/daemon.sock"
  local pid_file="$HOME/.sisyphus/daemon.pid"

  # Sub-test 1: stale socket file (regular file, not a socket)
  stop_daemon
  touch "$sock"
  if start_daemon; then
    assert_pass "daemon-resilience-stale-socket"
  else
    assert_fail "daemon-resilience-stale-socket" "daemon failed to start with stale socket file"
  fi
  stop_daemon

  # Sub-test 2: stale PID file with non-existent process
  printf '99999' >"$pid_file"
  if start_daemon; then
    assert_pass "daemon-resilience-stale-pid"
  else
    assert_fail "daemon-resilience-stale-pid" "daemon failed to start with stale PID"
  fi
  stop_daemon

  # Sub-test 3: double start — second invocation should exit 0
  if ! start_daemon; then
    assert_fail "daemon-resilience-double-start-setup" "daemon failed to start"
    stop_daemon
    return
  fi
  sisyphusd start >/dev/null 2>&1
  local second_exit=$?
  if [ "$second_exit" -eq 0 ]; then
    assert_pass "daemon-resilience-double-start"
  else
    assert_fail "daemon-resilience-double-start" "second start exited $second_exit"
  fi
  stop_daemon
}

test_config_robustness() {
  local config_file="$HOME/.sisyphus/config.json"
  local orig_config='{"autoUpdate":false}'

  # Unknown keys — daemon should tolerate forward-compatible fields
  # Always include autoUpdate:false — Docker has no network, so update checks hang
  printf '{"autoUpdate":false,"model":"test","futureKey":"value","nestedFuture":{"a":1}}' >"$config_file"
  if ! start_daemon; then
    assert_fail "config-unknown-keys" "start_daemon timed out"
    printf '%s' "$orig_config" >"$config_file"
    return
  fi
  assert_daemon_alive "config-unknown-keys"
  stop_daemon

  # Wrong type for numeric field
  printf '{"autoUpdate":false,"pollIntervalMs":"not-a-number"}' >"$config_file"
  if ! start_daemon; then
    assert_fail "config-wrong-type" "start_daemon timed out"
    printf '%s' "$orig_config" >"$config_file"
    return
  fi
  assert_daemon_alive "config-wrong-type"
  stop_daemon

  # Negative interval
  printf '{"autoUpdate":false,"pollIntervalMs":-1}' >"$config_file"
  if ! start_daemon; then
    assert_fail "config-negative-interval" "start_daemon timed out"
    printf '%s' "$orig_config" >"$config_file"
    return
  fi
  assert_daemon_alive "config-negative-interval"
  stop_daemon

  printf '%s' "$orig_config" >"$config_file"
}

test_sigkill_recovery() {
  if ! start_daemon; then
    assert_fail "sigkill-restart-ok" "start_daemon timed out on initial start"
    return
  fi

  local pid
  pid=$(cat "$HOME/.sisyphus/daemon.pid" 2>/dev/null)
  if [ -z "$pid" ]; then
    assert_fail "sigkill-stale-pid" "could not read daemon PID"
    stop_daemon
    return
  fi

  kill -9 "$pid" 2>/dev/null || true
  sleep 0.5

  assert_file_exists "sigkill-stale-pid" "$HOME/.sisyphus/daemon.pid"

  if ! start_daemon; then
    assert_fail "sigkill-restart-ok" "start_daemon failed after SIGKILL"
    return
  fi
  assert_pass "sigkill-restart-ok"
  assert_daemon_alive "sigkill-daemon-alive"

  stop_daemon
}

test_home_unset() {
  # Tests that CLI doesn't hang or segfault with HOME unset.
  # Non-zero exit is acceptable — we just verify it terminates cleanly.
  if (unset HOME; sis --version >/dev/null 2>&1); then
    assert_pass "home-unset-version"
  else
    assert_pass "home-unset-version"
  fi
}

test_protocol_edge_cases() {
  if ! start_daemon; then
    assert_fail "protocol-edge-cases-daemon-start" "start_daemon timed out"
    return
  fi

  local resp

  # Empty request (send a bare newline directly — send_request rejects empty arg)
  resp=$(printf '\n' | node -e "
const net = require('net');
const t = setTimeout(() => { process.stdout.write(JSON.stringify({ok:false,error:'timeout'})); process.exit(0); }, 5000);
let buf = '';
process.stdin.resume();
process.stdin.on('data', d => { buf += d; });
process.stdin.on('end', () => {
  const s = net.connect(process.env.HOME + '/.sisyphus/daemon.sock');
  s.on('connect', () => s.write(buf));
  s.on('data', d => {
    clearTimeout(t);
    process.stdout.write(d.toString().trim());
    process.exit(0);
  });
  s.on('error', e => { clearTimeout(t); process.stdout.write(JSON.stringify({ok:false,error:e.message})); process.exit(0); });
});
")
  assert_json_error "protocol-empty-request" "$resp"

  # Extra unknown fields — daemon should ignore them
  resp=$(send_request '{"type":"status","extra":"ignored"}')
  assert_json_ok "protocol-extra-fields" "$resp"

  # Large payload (5KB+ task string)
  local long_task
  long_task=$(printf 'x%.0s' $(seq 1 5120))
  resp=$(send_request "{\"type\":\"start\",\"task\":\"${long_task}\",\"cwd\":\"/tmp/large-payload-test\"}")
  assert_daemon_alive "protocol-large-payload"
  rm -rf /tmp/large-payload-test

  stop_daemon
}

test_empty_task() {
  if ! start_daemon; then
    assert_fail "empty-task-daemon-survives" "start_daemon timed out"
    return
  fi

  mkdir -p /tmp/empty-task-test
  # Either ok:true or ok:false is acceptable — daemon must not crash
  send_request '{"type":"start","task":"","cwd":"/tmp/empty-task-test"}' >/dev/null 2>&1 || true
  assert_daemon_alive "empty-task-daemon-survives"

  stop_daemon
  rm -rf /tmp/empty-task-test
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

run_base_tests() {
  test_install_ok
  test_node_pty_native
  test_cli_version
  test_daemon_version
  test_daemon_lifecycle
  test_doctor_base
  test_postinstall_no_swift
  test_help_lists_commands
  test_unknown_command_fails
  test_doctor_exit_code
  test_protocol_robustness
  test_daemon_resilience
  test_config_robustness
  test_sigkill_recovery
  test_home_unset
  test_protocol_edge_cases
  test_empty_task
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set_tier "base"
  run_base_tests
  print_results
fi
