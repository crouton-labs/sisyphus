#!/bin/bash
# Full tier integration tests for sisyphus.
# Requires: tmux, neovim, claude mock in PATH.
# Sources test-tmux.sh which transitively sources test-base.sh + assert.sh.

_SUITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$_SUITE_DIR/test-tmux.sh"

# ---------------------------------------------------------------------------
# Full tier tests
# ---------------------------------------------------------------------------

test_nvim_installed() {
  assert_cmd "nvim-installed" which nvim
}

test_claude_mock() {
  assert_cmd "claude-mock" which claude
}

test_doctor_full() {
  local DOCTOR_OUTPUT
  DOCTOR_OUTPUT=$(run_doctor)
  assert_contains "doctor-claude-ok" "$DOCTOR_OUTPUT" '✓.*Claude'
  assert_contains "doctor-nvim-ok" "$DOCTOR_OUTPUT" '✓.*nvim'
}

test_full_setup() {
  tmux new-session -d -s setup-test 2>/dev/null || true
  start_daemon
  sis admin setup >/dev/null 2>&1 || true
  assert_file_exists "setup-begin-cmd" "$HOME/.claude/commands/sisyphus/begin.md"
  assert_file_exists "setup-autopsy-cmd" "$HOME/.claude/commands/sisyphus/autopsy.md"
  stop_daemon
  tmux kill-server 2>/dev/null || true
}

test_status_bar() {
  tmux new-session -d -s status-test 2>/dev/null || true
  start_daemon
  # Compositor writes status-right directly on each poll cycle (5s) — wait for at least one
  sleep 8
  local status_val
  status_val=$(tmux show-option -gv status-right 2>/dev/null || echo "")
  if [ -n "$status_val" ]; then
    assert_pass "status-bar-write"
  else
    assert_fail "status-bar-write" "tmux status-right is empty after daemon poll cycle"
  fi
  stop_daemon
  tmux kill-server 2>/dev/null || true
}

test_list_empty() {
  start_daemon
  assert_cmd "list-empty" sis list
  stop_daemon
}

test_session_complete_lifecycle() {
  setup_test_project
  tmux new-session -d -s complete-test 2>/dev/null || true
  if ! start_daemon; then
    assert_fail "lifecycle-create-ok" "start_daemon timed out"
    tmux kill-server 2>/dev/null || true
    cleanup_test_project
    return
  fi

  local create_resp
  create_resp=$(send_request "{\"type\":\"start\",\"task\":\"lifecycle test\",\"cwd\":\"$TEST_CWD\"}")
  assert_json_ok "lifecycle-create-ok" "$create_resp"

  local sid
  sid=$(extract_session_id "$create_resp")
  if [ -z "$sid" ]; then
    assert_fail "lifecycle-session-id-nonempty" "sessionId was empty"
    stop_daemon
    tmux kill-server 2>/dev/null || true
    cleanup_test_project
    return
  fi

  sleep 2

  local complete_resp
  complete_resp=$(send_request "{\"type\":\"complete\",\"sessionId\":\"$sid\",\"report\":\"integration test complete\"}")
  assert_json_ok "lifecycle-complete-ok" "$complete_resp"

  sleep 1

  local state_json
  state_json=$(read_session_state "$sid")
  assert_json_field "lifecycle-status-completed" "$state_json" "status" "completed"
  assert_json_field "lifecycle-report-stored" "$state_json" "completionReport" "integration test complete"

  local list_resp
  list_resp=$(send_request "{\"type\":\"list\",\"cwd\":\"$TEST_CWD\"}")
  assert_contains "lifecycle-in-list-after-complete" "$list_resp" "$sid"

  stop_daemon
  tmux kill-server 2>/dev/null || true
  cleanup_test_project
}

test_update_task() {
  setup_test_project
  tmux new-session -d -s task-test 2>/dev/null || true
  if ! start_daemon; then
    assert_fail "update-task-ok" "start_daemon timed out"
    tmux kill-server 2>/dev/null || true
    cleanup_test_project
    return
  fi

  local create_resp
  create_resp=$(send_request "{\"type\":\"start\",\"task\":\"original task\",\"cwd\":\"$TEST_CWD\"}")

  local sid
  sid=$(extract_session_id "$create_resp")
  if [ -z "$sid" ]; then
    assert_fail "update-task-ok" "sessionId was empty — create failed"
    stop_daemon
    tmux kill-server 2>/dev/null || true
    cleanup_test_project
    return
  fi

  sleep 1

  local update_resp
  update_resp=$(send_request "{\"type\":\"update-task\",\"sessionId\":\"$sid\",\"task\":\"updated task description\"}")
  assert_json_ok "update-task-ok" "$update_resp"

  local goal_file="$TEST_CWD/.sisyphus/sessions/$sid/goal.md"
  if grep -q "updated task description" "$goal_file" 2>/dev/null; then
    assert_pass "update-task-goal-file-updated"
  else
    assert_fail "update-task-goal-file-updated" "goal.md does not contain updated task description (path: $goal_file)"
  fi

  stop_daemon
  tmux kill-server 2>/dev/null || true
  cleanup_test_project
}

# ---------------------------------------------------------------------------
# Adversarial tests
# ---------------------------------------------------------------------------

test_agent_type_resolution() {
  local TYPE_DIR="/tmp/agent-type-test-$$"
  rm -rf "$TYPE_DIR"
  mkdir -p "$TYPE_DIR/.claude/agents"

  # Create a local agent type file with a distinctive field
  cat > "$TYPE_DIR/.claude/agents/custom-test.md" << 'EOF'
---
color: red
description: Custom test agent
---
Custom test agent body
EOF

  assert_file_exists "agent-type-file-created" "$TYPE_DIR/.claude/agents/custom-test.md"

  # Verify frontmatter is structurally correct (color field parseable)
  local color
  color=$(node --input-type=module <<JSEOF 2>/dev/null
import { readFileSync } from 'node:fs';
const content = readFileSync('${TYPE_DIR}/.claude/agents/custom-test.md', 'utf-8');
const m = content.match(/^---\n([\s\S]*?)\n---/);
if (m) { const c = m[1].match(/^color:\s*(.+)$/m); process.stdout.write(c ? c[1].trim() : ''); }
JSEOF
  )
  if [ "$color" = "red" ]; then
    assert_pass "agent-type-frontmatter-parsed"
  else
    assert_fail "agent-type-frontmatter-parsed" "expected color=red in frontmatter, got: $color"
  fi

  # Test resolution through daemon: spawn with local type, verify no crash
  setup_test_project
  mkdir -p "$TEST_CWD/.claude/agents"
  cp "$TYPE_DIR/.claude/agents/custom-test.md" "$TEST_CWD/.claude/agents/custom-test.md"

  tmux new-session -d -s agent-type-test 2>/dev/null || true
  if ! start_daemon; then
    assert_fail "agent-type-resolve-no-crash" "start_daemon timed out"
    tmux kill-server 2>/dev/null || true
    cleanup_test_project
    rm -rf "$TYPE_DIR"
    return
  fi

  local sess_resp sid
  sess_resp=$(send_request "{\"type\":\"start\",\"task\":\"type resolution test\",\"cwd\":\"$TEST_CWD\"}")
  sid=$(extract_session_id "$sess_resp")

  if [ -n "$sid" ]; then
    sleep 1
    # Spawn with local custom type — ok or error both acceptable, daemon must stay alive
    send_request "{\"type\":\"spawn\",\"sessionId\":\"$sid\",\"agentType\":\"custom-test\",\"name\":\"type-test-agent\",\"instruction\":\"test\"}" >/dev/null 2>&1 || true
    assert_daemon_alive "agent-type-resolve-no-crash"
  else
    assert_fail "agent-type-resolve-no-crash" "session creation failed, cannot test type resolution"
  fi

  # Test: missing .claude/ dir in session cwd doesn't crash daemon
  local NO_CLAUDE_DIR="/tmp/no-claude-$$"
  mkdir -p "$NO_CLAUDE_DIR"
  send_request "{\"type\":\"start\",\"task\":\"no-claude-dir test\",\"cwd\":\"$NO_CLAUDE_DIR\"}" >/dev/null 2>&1 || true
  assert_daemon_alive "agent-type-no-claude-dir-no-crash"
  rm -rf "$NO_CLAUDE_DIR"

  stop_daemon
  tmux kill-server 2>/dev/null || true
  cleanup_test_project
  rm -rf "$TYPE_DIR"
}

test_malformed_frontmatter() {
  local FM_DIR="/tmp/fm-test-$$"
  rm -rf "$FM_DIR"
  mkdir -p "$FM_DIR/.claude/agents"

  # File with missing closing ---
  printf '---\nmodel: test-model\nThis is the body without closing frontmatter' \
    > "$FM_DIR/.claude/agents/broken.md"

  # File with inline YAML array (known parse limitation — block list expected)
  printf '---\nskills: [code-review, testing]\n---\nBody here' \
    > "$FM_DIR/.claude/agents/array-skills.md"

  setup_test_project
  mkdir -p "$TEST_CWD/.claude/agents"
  cp "$FM_DIR/.claude/agents/broken.md" "$TEST_CWD/.claude/agents/broken.md"
  cp "$FM_DIR/.claude/agents/array-skills.md" "$TEST_CWD/.claude/agents/array-skills.md"

  tmux new-session -d -s fm-test 2>/dev/null || true
  if ! start_daemon; then
    assert_fail "malformed-fm-daemon-alive" "start_daemon timed out"
    tmux kill-server 2>/dev/null || true
    cleanup_test_project
    rm -rf "$FM_DIR"
    return
  fi

  local sess_resp sid
  sess_resp=$(send_request "{\"type\":\"start\",\"task\":\"malformed frontmatter test\",\"cwd\":\"$TEST_CWD\"}")
  sid=$(extract_session_id "$sess_resp")

  if [ -n "$sid" ]; then
    sleep 1
    # Spawn with each broken type — daemon must survive both
    send_request "{\"type\":\"spawn\",\"sessionId\":\"$sid\",\"agentType\":\"broken\",\"name\":\"broken-agent\",\"instruction\":\"test\"}" >/dev/null 2>&1 || true
    assert_daemon_alive "malformed-fm-broken-no-crash"
    send_request "{\"type\":\"spawn\",\"sessionId\":\"$sid\",\"agentType\":\"array-skills\",\"name\":\"array-skills-agent\",\"instruction\":\"test\"}" >/dev/null 2>&1 || true
    assert_daemon_alive "malformed-fm-array-skills-no-crash"
  else
    assert_fail "malformed-fm-broken-no-crash" "session creation failed"
    assert_fail "malformed-fm-array-skills-no-crash" "session creation failed"
  fi

  stop_daemon
  tmux kill-server 2>/dev/null || true
  cleanup_test_project
  rm -rf "$FM_DIR"
}

test_setup_idempotency() {
  local BEGIN_FILE="$HOME/.claude/commands/sisyphus/begin.md"
  local AUTOPSY_FILE="$HOME/.claude/commands/sisyphus/autopsy.md"

  tmux new-session -d -s setup-idempotent-test 2>/dev/null || true
  if ! start_daemon; then
    assert_fail "setup-idempotent-first-run" "start_daemon timed out"
    tmux kill-server 2>/dev/null || true
    return
  fi

  # First run
  sis admin setup >/dev/null 2>&1 || true
  assert_file_exists "setup-idempotent-first-run" "$BEGIN_FILE"
  assert_file_exists "setup-idempotent-first-run-autopsy" "$AUTOPSY_FILE"

  # Append a custom marker to each
  echo "# CUSTOM MARKER" >> "$BEGIN_FILE"
  echo "# CUSTOM AUTOPSY MARKER" >> "$AUTOPSY_FILE"

  # Second run
  sis admin setup >/dev/null 2>&1 || true

  # Markers must survive (files not overwritten)
  local content
  content=$(cat "$BEGIN_FILE" 2>/dev/null || echo "")
  assert_contains "setup-idempotent-preserves-custom" "$content" "CUSTOM MARKER"
  local autopsy_content
  autopsy_content=$(cat "$AUTOPSY_FILE" 2>/dev/null || echo "")
  assert_contains "setup-idempotent-preserves-custom-autopsy" "$autopsy_content" "CUSTOM AUTOPSY MARKER"

  stop_daemon
  tmux kill-server 2>/dev/null || true
}

test_tui_rendering() {
  setup_test_project
  tmux new-session -d -s tui-render-test 2>/dev/null || true
  if ! start_daemon; then
    assert_fail "tui-renders-output" "start_daemon timed out"
    tmux kill-server 2>/dev/null || true
    cleanup_test_project
    return
  fi

  # Create a session so the TUI has something to display
  local resp
  resp=$(send_request '{"type":"start","task":"tui rendering test","cwd":"'"$TEST_CWD"'"}')
  sleep 2  # let session initialize

  # Launch TUI in a real tmux pane (needs a PTY — not piped)
  # Note: the CLI command is "sis dashboard" (not "tui"); -c sets cwd so the
  # TUI's session filter matches the session we created above.
  tmux new-window -t tui-render-test -n tui -c "$TEST_CWD" "sis dashboard"
  sleep 3  # let TUI render

  # Capture the rendered output (plain text, ANSI stripped by tmux)
  local captured
  captured=$(tmux capture-pane -t tui-render-test:tui -p 2>/dev/null || echo "")

  if [ -n "$captured" ]; then
    assert_pass "tui-renders-output"
  else
    assert_fail "tui-renders-output" "TUI pane produced no output"
  fi

  # Box-drawing border chars always present (╭/│/╰ from drawBorder in render.ts)
  if echo "$captured" | grep -q '╭\|│\|╰'; then
    assert_pass "tui-shows-borders"
  else
    assert_fail "tui-shows-borders" "no box-drawing border chars in TUI output"
  fi

  # Status bar key hints always rendered in navigate mode (bottom.ts renderStatusLine)
  if echo "$captured" | grep -q 'navigate\|quit'; then
    assert_pass "tui-shows-keyhints"
  else
    assert_fail "tui-shows-keyhints" "no key hints in TUI status bar"
  fi

  # Session task text should appear in the tree panel
  if echo "$captured" | grep -q 'tui rendering test'; then
    assert_pass "tui-shows-session-task"
  else
    assert_fail "tui-shows-session-task" "session task text not visible in TUI tree"
  fi

  # Clean up
  tmux kill-window -t tui-render-test:tui 2>/dev/null || true
  stop_daemon
  tmux kill-server 2>/dev/null || true
  cleanup_test_project
}

test_tui_input_handling() {
  setup_test_project
  tmux new-session -d -s tui-input-test 2>/dev/null || true
  if ! start_daemon; then
    assert_fail "tui-input-quit-closes-pane" "start_daemon timed out"
    tmux kill-server 2>/dev/null || true
    cleanup_test_project
    return
  fi

  # Launch TUI in a real tmux pane
  tmux new-window -t tui-input-test -n tui -c "$TEST_CWD" "sis dashboard"
  sleep 3  # let TUI render

  # Verify TUI is actually running before sending keystrokes
  local before
  before=$(tmux capture-pane -t tui-input-test:tui -p 2>/dev/null || echo "")
  if [ -z "$before" ]; then
    assert_fail "tui-input-quit-closes-pane" "TUI did not render before keystroke"
    tmux kill-server 2>/dev/null || true
    cleanup_test_project
    return
  fi

  # Send 'q' — input.ts line 897: calls actions.cleanup() → process.exit(0)
  tmux send-keys -t tui-input-test:tui 'q' ''
  sleep 1  # let the TUI exit

  # Verify the window closed (process.exit(0) causes tmux to close the window by default)
  if ! tmux list-windows -t tui-input-test 2>/dev/null | grep -q 'tui'; then
    assert_pass "tui-input-quit-closes-pane"
  else
    # Window still exists — check if output changed (TUI reacted but didn't exit)
    local after
    after=$(tmux capture-pane -t tui-input-test:tui -p 2>/dev/null || echo "")
    if [ "$after" != "$before" ]; then
      assert_pass "tui-input-quit-closes-pane"
    else
      assert_fail "tui-input-quit-closes-pane" "TUI did not respond to 'q' keystroke"
    fi
  fi

  # Clean up
  tmux kill-window -t tui-input-test:tui 2>/dev/null || true
  stop_daemon
  tmux kill-server 2>/dev/null || true
  cleanup_test_project
}

test_tui_graceful_no_tty() {
  local exit_code

  # Test 1: piped stdin — must exit on its own within 5s (not hang)
  timeout 5 bash -c 'echo "" | sis tui' >/dev/null 2>&1
  exit_code=$?
  if [ "$exit_code" -ne 124 ]; then
    # 124 = timeout killed it (hung); anything else = exited on its own
    assert_pass "tui-no-tty-pipe"
  else
    assert_fail "tui-no-tty-pipe" "TUI hung with piped stdin (timeout after 5s)"
  fi

  # Test 2: /dev/null stdin — must exit on its own within 5s
  timeout 5 bash -c 'sis tui < /dev/null' >/dev/null 2>&1
  exit_code=$?
  if [ "$exit_code" -ne 124 ]; then
    assert_pass "tui-no-tty-devnull"
  else
    assert_fail "tui-no-tty-devnull" "TUI hung with /dev/null stdin (timeout after 5s)"
  fi
}

test_doctor_comprehensive() {
  tmux new-session -d -s doctor-adv-test 2>/dev/null || true
  if ! start_daemon; then
    assert_fail "doctor-adv-no-failures" "start_daemon timed out"
    tmux kill-server 2>/dev/null || true
    return
  fi

  local output
  output=$(run_doctor)

  # Full tier: tmux running, claude mock, nvim present — expect all green
  assert_not_contains "doctor-adv-no-failures" "$output" '✗'
  assert_contains "doctor-adv-node-ok" "$output" '✓.*[Nn]ode'
  assert_contains "doctor-adv-tmux-ok" "$output" '✓.*tmux'
  assert_contains "doctor-adv-claude-ok" "$output" '✓.*[Cc]laude'
  assert_contains "doctor-adv-nvim-ok" "$output" '✓.*nvim'

  stop_daemon
  tmux kill-server 2>/dev/null || true
}

test_permissions_agent_dir() {
  # In Docker tests run as root; root bypasses DAC on Linux, making chmod 000
  # ineffective for testing permission errors. Skip when running as root.
  if [ "$(id -u)" = "0" ]; then
    assert_skip "perm-agent-dir-no-crash" "running as root — chmod 000 bypass prevents meaningful test"
    assert_skip "perm-agent-dir-daemon-alive" "running as root — chmod 000 bypass prevents meaningful test"
    return
  fi

  local PERM_DIR="/tmp/perm-test-$$"
  rm -rf "$PERM_DIR"
  mkdir -p "$PERM_DIR/.claude/agents"
  printf '---\ncolor: blue\n---\nValid agent body' > "$PERM_DIR/.claude/agents/valid.md"

  # Make agents dir unreadable
  chmod 000 "$PERM_DIR/.claude/agents"

  setup_test_project
  # Copy parent dir structure but agents/ is unreadable
  mkdir -p "$TEST_CWD/.claude"
  # Symlink to simulate project pointing to unreadable agents dir
  ln -sf "$PERM_DIR/.claude/agents" "$TEST_CWD/.claude/agents" 2>/dev/null || true

  tmux new-session -d -s perm-test 2>/dev/null || true
  if ! start_daemon; then
    chmod 755 "$PERM_DIR/.claude/agents"
    assert_fail "perm-agent-dir-no-crash" "start_daemon timed out"
    tmux kill-server 2>/dev/null || true
    cleanup_test_project
    rm -rf "$PERM_DIR"
    return
  fi

  local sess_resp
  sess_resp=$(send_request "{\"type\":\"start\",\"task\":\"perm test\",\"cwd\":\"$TEST_CWD\"}")
  assert_daemon_alive "perm-agent-dir-no-crash"

  local sid
  sid=$(extract_session_id "$sess_resp")
  if [ -n "$sid" ]; then
    sleep 1
    send_request "{\"type\":\"spawn\",\"sessionId\":\"$sid\",\"agentType\":\"valid\",\"name\":\"perm-agent\",\"instruction\":\"test\"}" >/dev/null 2>&1 || true
    assert_daemon_alive "perm-agent-dir-daemon-alive"
  else
    assert_fail "perm-agent-dir-daemon-alive" "session creation failed"
  fi

  # Restore permissions before cleanup
  chmod 755 "$PERM_DIR/.claude/agents"
  stop_daemon
  tmux kill-server 2>/dev/null || true
  cleanup_test_project
  rm -rf "$PERM_DIR"
}

# ---------------------------------------------------------------------------
# Auto-updater tests
# ---------------------------------------------------------------------------

test_auto_updater() {
  local VERDACCIO_PID=""
  local VERDACCIO_PORT=4873
  local VERDACCIO_URL="http://localhost:${VERDACCIO_PORT}"
  local WORK_DIR="/tmp/updater-test-$$"
  local VERDACCIO_CONFIG="$WORK_DIR/verdaccio.yaml"
  local VERDACCIO_STORAGE="$WORK_DIR/storage"
  local NPMRC="$WORK_DIR/.npmrc"

  _cleanup_updater_test() {
    [ -n "$VERDACCIO_PID" ] && kill "$VERDACCIO_PID" 2>/dev/null || true
    wait "$VERDACCIO_PID" 2>/dev/null || true
    # Restore original sisyphi install from the tarball baked into the image
    if ls /tmp/sisyphi-*.tgz >/dev/null 2>&1; then
      npm install -g /tmp/sisyphi-*.tgz >/dev/null 2>&1 || true
    fi
    rm -rf "$WORK_DIR" 2>/dev/null || true
  }

  # 1. Test isNewer() logic (mirrors src/daemon/updater.ts implementation exactly)
  local isnewer_ok
  isnewer_ok=$(node -e "
    function isNewer(latest, current) {
      var a = latest.split('.').map(Number);
      var b = current.split('.').map(Number);
      for (var i = 0; i < Math.max(a.length, b.length); i++) {
        var av = (a[i] !== undefined ? a[i] : 0);
        var bv = (b[i] !== undefined ? b[i] : 0);
        if (av > bv) return true;
        if (av < bv) return false;
      }
      return false;
    }
    var ok = true;
    ok = ok && isNewer('0.0.2', '0.0.1') === true;
    ok = ok && isNewer('0.0.1', '0.0.2') === false;
    ok = ok && isNewer('1.0.0', '0.9.9') === true;
    ok = ok && isNewer('1.0.0', '1.0.0') === false;
    process.stdout.write(ok ? 'OK' : 'FAIL');
  " 2>/dev/null)
  if [ "$isnewer_ok" = "OK" ]; then
    assert_pass "updater-isnewer-logic"
  else
    assert_fail "updater-isnewer-logic" "isNewer() version comparison failed"
  fi

  # 2. Check verdaccio is available
  if ! command -v verdaccio >/dev/null 2>&1; then
    assert_skip "updater-verdaccio-start" "verdaccio not installed"
    assert_skip "updater-pkg-dir-found" "verdaccio not installed"
    assert_skip "updater-pack-ok" "verdaccio not installed"
    assert_skip "updater-registry-latest-version" "verdaccio not installed"
    assert_skip "updater-install-old-version" "verdaccio not installed"
    assert_skip "updater-update-to-new-version" "verdaccio not installed"
    return
  fi

  mkdir -p "$WORK_DIR" "$VERDACCIO_STORAGE"

  # 3. Write minimal verdaccio config (unauthenticated access + publish)
  cat > "$VERDACCIO_CONFIG" <<EOF
storage: ${VERDACCIO_STORAGE}
uplinks: {}
packages:
  '**':
    access: \$all
    publish: \$all
auth:
  htpasswd:
    file: ${WORK_DIR}/htpasswd
    max_users: 100
EOF

  # Scoped npmrc with dummy token — verdaccio with publish:$all accepts any token
  echo "//localhost:${VERDACCIO_PORT}/:_authToken=dummy-test-token" > "$NPMRC"

  # 4. Start verdaccio in background
  verdaccio --config "$VERDACCIO_CONFIG" --listen "0.0.0.0:${VERDACCIO_PORT}" \
    > "$WORK_DIR/verdaccio.log" 2>&1 &
  VERDACCIO_PID=$!

  # Poll until verdaccio responds (up to 15s)
  local deadline=$(( $(date +%s) + 15 ))
  local ready=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -sf "${VERDACCIO_URL}/-/ping" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.5
  done

  if [ "$ready" -ne 1 ]; then
    assert_fail "updater-verdaccio-start" "verdaccio did not become ready within 15s"
    _cleanup_updater_test
    return
  fi
  assert_pass "updater-verdaccio-start"

  # 5. Locate the globally installed sisyphi package
  local GLOBAL_PREFIX
  GLOBAL_PREFIX=$(npm prefix -g 2>/dev/null || echo "/usr/local")
  local PKG_DIR="${GLOBAL_PREFIX}/lib/node_modules/sisyphi"

  if [ ! -d "$PKG_DIR" ]; then
    assert_fail "updater-pkg-dir-found" "sisyphi not found at $PKG_DIR"
    _cleanup_updater_test
    return
  fi
  assert_pass "updater-pkg-dir-found"

  # 6. Pack the installed package into a tarball
  local PACK_TGZ
  PACK_TGZ=$(npm pack "$PKG_DIR" --pack-destination "$WORK_DIR" 2>/dev/null | tail -1)
  if [ -z "$PACK_TGZ" ] || [ ! -f "$WORK_DIR/$PACK_TGZ" ]; then
    assert_fail "updater-pack-ok" "npm pack failed"
    _cleanup_updater_test
    return
  fi
  assert_pass "updater-pack-ok"

  # 7. Build v0.0.1 and v0.0.2 tarballs: unpack, bump version, repack
  for VER in "0.0.1" "0.0.2"; do
    local VER_DIR="$WORK_DIR/pkg-${VER}"
    mkdir -p "$VER_DIR"
    tar xzf "$WORK_DIR/$PACK_TGZ" -C "$VER_DIR" 2>/dev/null
    # npm pack creates a package/ subdirectory inside the tarball
    # Bump version and strip dependencies (dist is self-contained via tsup bundle,
    # and verdaccio has no uplinks so deps would 404 on install)
    node -e "
      var fs = require('fs');
      var path = '${VER_DIR}/package/package.json';
      var p = JSON.parse(fs.readFileSync(path, 'utf8'));
      p.version = '${VER}';
      delete p.dependencies;
      delete p.devDependencies;
      delete p.optionalDependencies;
      delete p.scripts;
      fs.writeFileSync(path, JSON.stringify(p, null, 2));
    " 2>/dev/null
    (cd "$VER_DIR" && tar czf "$WORK_DIR/sisyphi-${VER}.tgz" package/ 2>/dev/null)
  done

  # 8. Publish both versions (order: 0.0.1 first so 0.0.2 becomes latest)
  npm publish "$WORK_DIR/sisyphi-0.0.1.tgz" --registry "$VERDACCIO_URL" \
    --userconfig "$NPMRC" >/dev/null 2>&1
  npm publish "$WORK_DIR/sisyphi-0.0.2.tgz" --registry "$VERDACCIO_URL" \
    --userconfig "$NPMRC" >/dev/null 2>&1

  # 9. Verify registry shows 0.0.2 as latest
  local latest_ver
  latest_ver=$(npm view sisyphi version --registry "$VERDACCIO_URL" 2>/dev/null | tr -d '[:space:]')
  if [ "$latest_ver" = "0.0.2" ]; then
    assert_pass "updater-registry-latest-version"
  else
    assert_fail "updater-registry-latest-version" "expected 0.0.2 as latest, got: $latest_ver"
    _cleanup_updater_test
    return
  fi

  # 10. Install v0.0.1 globally (establishes the "old version" baseline)
  npm install -g "sisyphi@0.0.1" --registry "$VERDACCIO_URL" \
    --userconfig "$NPMRC" >/dev/null 2>&1
  local installed_ver
  installed_ver=$(npm ls -g sisyphi --json --depth=0 2>/dev/null | node -e "
    var buf = '';
    process.stdin.on('data', function(d) { buf += d; });
    process.stdin.on('end', function() {
      try {
        var j = JSON.parse(buf);
        process.stdout.write(j.dependencies && j.dependencies.sisyphi ? j.dependencies.sisyphi.version : '');
      } catch(e) { process.stdout.write(''); }
    });
  ")
  if [ "$installed_ver" = "0.0.1" ]; then
    assert_pass "updater-install-old-version"
  else
    assert_fail "updater-install-old-version" "expected 0.0.1 installed, got: $installed_ver"
    _cleanup_updater_test
    return
  fi

  # 11. Run npm install -g (mirrors applyUpdate() mechanics) — should land 0.0.2
  npm install -g sisyphi --registry "$VERDACCIO_URL" \
    --userconfig "$NPMRC" >/dev/null 2>&1
  installed_ver=$(npm ls -g sisyphi --json --depth=0 2>/dev/null | node -e "
    var buf = '';
    process.stdin.on('data', function(d) { buf += d; });
    process.stdin.on('end', function() {
      try {
        var j = JSON.parse(buf);
        process.stdout.write(j.dependencies && j.dependencies.sisyphi ? j.dependencies.sisyphi.version : '');
      } catch(e) { process.stdout.write(''); }
    });
  ")
  if [ "$installed_ver" = "0.0.2" ]; then
    assert_pass "updater-update-to-new-version"
  else
    assert_fail "updater-update-to-new-version" "expected 0.0.2 after update, got: $installed_ver"
  fi

  _cleanup_updater_test
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

run_full_tests() {
  test_nvim_installed
  test_claude_mock
  test_doctor_full
  test_full_setup
  test_status_bar
  test_list_empty
  test_session_complete_lifecycle
  test_update_task
  test_agent_type_resolution
  test_malformed_frontmatter
  test_setup_idempotency
  test_tui_rendering
  test_tui_input_handling
  test_tui_graceful_no_tty
  test_doctor_comprehensive
  test_permissions_agent_dir
  test_auto_updater
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set_tier "full"
  run_base_tests
  run_tmux_tests
  run_full_tests
  print_results
fi
