const nodeVersion = parseInt(process.versions.node.split('.')[0]!, 10);
if (nodeVersion < 22) {
  console.error(`[sisyphus] Node.js v22+ required (current: v${process.versions.node})`);
  process.exit(1);
}

import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { globalDir, daemonPidPath, statePath } from '../shared/paths.js';

import { Command } from 'commander';
import { loadConfig } from '../shared/config.js';
import { startServer, stopServer, registerSessionCwd, registerSessionTmux, loadSessionRegistry, setCompositor } from './server.js';
import { sweepOrphans } from './orphan-sweep.js';
import { startHeartbeatScanner, stopHeartbeatScanner } from './heartbeat-asks.js';
import { startMonitor, stopMonitor, setRespawnCallback, setDotsCallback, trackSession, updateTrackedWindow, flushTimers, initTimers, getTrackedSessionIds, getTrackedSessionEntries } from './pane-monitor.js';
import { onAllAgentsDone } from './session-manager.js';
import { recomputeDots, setTrackedEntriesProvider } from './status-dots.js';
import {
  Compositor,
  DEFAULT_STATUS_BAR_CONFIG,
  createSessionsSegment,
  createSisyphusSessionsSegment,
  createCompanionSegment,
  createWindowsSegment,
  createSessionNameSegment,
} from './segments/index.js';
import { writeManifest, writeEmptyManifest } from './sessions-manifest.js';
import { resetAgentCounterFromState } from './agent.js';
import { clearStaleAskClaims } from './ask-store.js';
import { orphanOrchestrator } from './orphan-asks.js';
import { isProcessAlive } from './lib/process.js';
import { setWindowId, setOrchestratorPaneId, getOrchestratorPaneId } from './orchestrator.js';
import { listPanes, initSessionMeta, getFirstWindowId, listAllSessions, listAllPanesByWindow } from './tmux.js';
import type { PaneInfo } from './tmux.js';
import { registerPane } from './pane-registry.js';
import * as stateModule from './state.js';
import type { Session } from '../shared/types.js';
import { checkAndApply, startPeriodicUpdateCheck, stopPeriodicUpdateCheck } from './updater.js';
import { installPlugin } from './plugin-install.js';
import { startLogRotator, stopLogRotator } from './log-rotate.js';
import { backfillUploads } from './upload-backfill.js';

function ensureDirs(): void {
  mkdirSync(globalDir(), { recursive: true });
}

function readPid(): number | null {
  const pidFile = daemonPidPath();
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    return pid && isProcessAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function acquirePidLock(): void {
  const pid = readPid();
  if (pid) {
    console.error(`[sisyphus] Daemon already running (pid ${pid}). Use 'sisyphusd restart' or 'sisyphusd stop' first.`);
    process.exit(0);
  }
  writeFileSync(daemonPidPath(), String(process.pid), 'utf-8');
}

function isLaunchdManaged(): boolean {
  try {
    execSync('launchctl list com.sisyphus.daemon', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function releasePidLock(): void {
  try {
    unlinkSync(daemonPidPath());
  } catch {
    // Already gone
  }
}

function stopDaemon(): boolean {
  const pid = readPid();
  if (!pid) {
    console.log('[sisyphus] Daemon is not running');
    // Clean up stale pid file if it exists
    releasePidLock();
    return false;
  }

  console.log(`[sisyphus] Stopping daemon (pid ${pid})...`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    console.error(`[sisyphus] Failed to send SIGTERM to pid ${pid}`);
    return false;
  }

  // Wait for process to exit (up to 5s)
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      console.log('[sisyphus] Daemon stopped');
      releasePidLock();
      return true;
    }
    // Busy-wait in small increments (synchronous — fine for a CLI command)
    const wait = Date.now() + 100;
    while (Date.now() < wait) { /* spin */ }
  }

  console.error(`[sisyphus] Daemon (pid ${pid}) did not exit within 5s, sending SIGKILL`);
  try {
    process.kill(pid, 'SIGKILL');
  } catch { /* already dead */ }
  releasePidLock();
  return true;
}

async function recoverOneSession(
  sessionId: string,
  cwd: string,
  tmuxIdSet: Set<string>,
  tmuxNameToId: Map<string, string>,
  panesByWindow: Map<string, PaneInfo[]>,
): Promise<boolean> {
  const stateFile = statePath(cwd, sessionId);
  if (!existsSync(stateFile)) return false;

  let session: Session;
  try {
    session = JSON.parse(readFileSync(stateFile, 'utf-8')) as Session;
  } catch {
    console.error(`[sisyphus] Failed to read session state for ${sessionId}, skipping`);
    return false;
  }

  if (session.status !== 'active' && session.status !== 'paused') return false;

  registerSessionCwd(sessionId, cwd);
  resetAgentCounterFromState(sessionId, session.agents ?? []);

  // The restart invalidated any in-flight ask claims: clear stale progress.json
  // so partially-answered asks re-surface in the dashboard immediately rather
  // than staying hidden behind scanInbox's 300s isClaimed window.
  const clearedClaims = await clearStaleAskClaims(cwd, sessionId);
  if (clearedClaims > 0) {
    console.log(`[sisyphus] Cleared ${clearedClaims} stale ask claim(s) for session ${sessionId} on recovery`);
  }

  if (!session.tmuxSessionName) return true;

  // Existence check via batched tmux list (single call shared across all sessions).
  let sessionAlive = false;
  let currentTmuxId = session.tmuxSessionId;

  if (currentTmuxId && tmuxIdSet.has(currentTmuxId)) {
    sessionAlive = true;
  } else {
    // $N is stale (tmux server restarted?) — try name fallback
    currentTmuxId = undefined;
  }

  if (!sessionAlive) {
    const resolved = tmuxNameToId.get(session.tmuxSessionName);
    if (resolved) {
      currentTmuxId = resolved;
      sessionAlive = true;
      // Persist the refreshed $N
      await stateModule.updateSessionTmux(cwd, sessionId, session.tmuxSessionName, session.tmuxWindowId ?? '', currentTmuxId);
    }
  }

  if (!sessionAlive) {
    if (session.status === 'active') {
      await stateModule.updateSessionStatus(cwd, sessionId, 'paused');
      // Clear stale tmux IDs
      await stateModule.updateSession(cwd, sessionId, { tmuxSessionId: undefined });
      console.log(`[sisyphus] Session ${sessionId} paused: tmux session no longer exists`);
    }
    return true;
  }

  // Discover window ID if missing from state
  let windowId = session.tmuxWindowId;
  if (!windowId) {
    windowId = getFirstWindowId(currentTmuxId!) ?? getFirstWindowId(session.tmuxSessionName!) ?? undefined;
    if (windowId) {
      await stateModule.updateSessionTmux(cwd, sessionId, session.tmuxSessionName, windowId, currentTmuxId);
      console.log(`[sisyphus] Discovered missing windowId ${windowId} for session ${sessionId}`);
    }
  }

  // Reuse the recovery-wide pane snapshot when possible; fall back to a per-window
  // tmux call only if the window id wasn't in the batched result. With 14+ sessions
  // this collapses N sync `tmux list-panes` spawns into a single one for the whole
  // recovery, keeping the event loop responsive for incoming IPC.
  const livePanes = windowId ? (panesByWindow.get(windowId) ?? listPanes(windowId)) : [];
  if (livePanes.length === 0) {
    // Window gone — pause the session so user can `sis session lifecycle resume`
    if (session.status === 'active') {
      await stateModule.updateSessionStatus(cwd, sessionId, 'paused');
      console.log(`[sisyphus] Session ${sessionId} paused: tmux window no longer exists`);
    }
    return true;
  }

  // Re-set session meta in case tmux options were lost (server restart, etc.)
  initSessionMeta(currentTmuxId!, cwd, sessionId);
  registerSessionTmux(sessionId, session.tmuxSessionName, windowId!, currentTmuxId);
  setWindowId(sessionId, windowId!);
  trackSession(sessionId, cwd, currentTmuxId, session.tmuxSessionName!);
  updateTrackedWindow(sessionId, windowId!);
  initTimers(sessionId, session);

  const livePaneIds = new Set(livePanes.map(p => p.paneId));

  // Recover orchestrator pane from last incomplete cycle
  const lastIncompleteCycle = [...session.orchestratorCycles].reverse().find(c => !c.completedAt && c.paneId);
  if (lastIncompleteCycle?.paneId) {
    setOrchestratorPaneId(sessionId, lastIncompleteCycle.paneId);
    if (livePaneIds.has(lastIncompleteCycle.paneId)) {
      registerPane(lastIncompleteCycle.paneId, sessionId, 'orchestrator');
    }
  }

  // Register live agent panes
  for (const agent of session.agents) {
    if (agent.status === 'running' && agent.paneId && livePaneIds.has(agent.paneId)) {
      registerPane(agent.paneId, sessionId, 'agent', agent.id);
    }
  }

  console.log(`[sisyphus] Reconnected session ${sessionId} to tmux window ${session.tmuxWindowId}`);

  // Detect sessions stuck in "all agents done, no orchestrator" state
  if (session.status === 'active' && session.agents.length > 0) {
    const hasRunningAgents = session.agents.some(a => a.status === 'running');
    if (!hasRunningAgents) {
      const orchestratorPaneId = getOrchestratorPaneId(sessionId);
      const orchestratorAlive = orchestratorPaneId && livePaneIds.has(orchestratorPaneId);
      if (!orchestratorAlive) {
        await orphanOrchestrator(cwd, sessionId, 'orchestrator lost while daemon was down', 'daemon-startup-stuck');
        await stateModule.completeOrchestratorCycle(cwd, sessionId);
        console.log(`[sisyphus] Detected stuck session ${sessionId} on recovery: triggering orchestrator respawn`);
        await onAllAgentsDone(sessionId, cwd, session.tmuxWindowId!);
      }
    }
  }

  return true;
}

async function recoverSessions(): Promise<void> {
  const registry = loadSessionRegistry();
  const entries = Object.entries(registry);

  if (entries.length === 0) {
    console.log('[sisyphus] No sessions to recover');
    return;
  }

  // One tmux list-sessions call shared across all recoveries, instead of per-session has-session/list-sessions.
  const allTmuxSessions = listAllSessions();
  const tmuxIdSet = new Set(allTmuxSessions.map(s => s.sessionId));
  const tmuxNameToId = new Map(allTmuxSessions.map(s => [s.name, s.sessionId]));
  // One batched snapshot of every pane keyed by window id, replacing N per-session
  // `tmux list-panes` calls inside recoverOneSession.
  const panesByWindow = listAllPanesByWindow();

  const results = await Promise.all(
    entries.map(([sessionId, cwd]) => recoverOneSession(sessionId, cwd, tmuxIdSet, tmuxNameToId, panesByWindow)),
  );

  const recovered = results.filter(Boolean).length;
  console.log(`[sisyphus] Recovered ${recovered} session(s) from registry`);
}

async function startDaemon(): Promise<void> {
  console.log('[sisyphus] Starting daemon...');
  ensureDirs();
  // Cap daemon.log at 100MB. Runs before anything else so a daemon restart on
  // top of a bloated log gets a fresh slate immediately.
  startLogRotator();
  installPlugin();

  const config = loadConfig(process.cwd());

  acquirePidLock();

  // Build status bar config with deep merge from user config
  const statusBarConfig = { ...DEFAULT_STATUS_BAR_CONFIG };
  statusBarConfig.colors = { ...DEFAULT_STATUS_BAR_CONFIG.colors, ...config.statusBar?.colors };
  statusBarConfig.segments = { ...DEFAULT_STATUS_BAR_CONFIG.segments, ...config.statusBar?.segments };
  if (config.statusBar?.left) statusBarConfig.left = config.statusBar.left;
  if (config.statusBar?.right) statusBarConfig.right = config.statusBar.right;
  if (config.statusBar?.enabled !== undefined) statusBarConfig.enabled = config.statusBar.enabled;

  const statusBarEnabled = statusBarConfig.enabled;

  if (statusBarEnabled) {
    const compositor = new Compositor(statusBarConfig);

    // Register built-in segments
    const sessionsBg = statusBarConfig.segments.sessions?.bg ?? DEFAULT_STATUS_BAR_CONFIG.segments.sessions!.bg!;
    compositor.register(createSessionsSegment(sessionsBg));
    compositor.register(createSisyphusSessionsSegment());
    compositor.register(createCompanionSegment());
    compositor.register(createWindowsSegment());
    compositor.register(createSessionNameSegment());

    // Expose compositor for external segment handlers in server.ts
    setCompositor(compositor);

    // Throttle the heavy work (compositor.render writes 2 tmux options per
    // session per render; recomputeDots writes 1 per dashboard window). At 12
    // sessions every 5s, the raw cadence saturated the event loop with
    // synchronous subprocess spawns. writeManifest is local fs — keep frequent.
    let tickCounter = 0;
    const renderEvery = Math.max(1, config.statusBarRenderTicks ?? 4);
    setDotsCallback((panesByWindow) => {
      try { writeManifest(); } catch { /* best-effort */ }
      tickCounter += 1;
      if (tickCounter % renderEvery !== 0) return;
      recomputeDots(panesByWindow);
      try { compositor.render(panesByWindow); } catch { /* best-effort */ }
    });
  } else {
    let tickCounter = 0;
    const renderEvery = Math.max(1, config.statusBarRenderTicks ?? 4);
    setDotsCallback((panesByWindow) => {
      try { writeManifest(); } catch { /* best-effort */ }
      tickCounter += 1;
      if (tickCounter % renderEvery !== 0) return;
      recomputeDots(panesByWindow);
    });
  }

  setRespawnCallback(onAllAgentsDone);
  setTrackedEntriesProvider(getTrackedSessionEntries);

  await startServer();
  startMonitor(config.pollIntervalMs);

  // Auto-update runs off the startup critical path so the IPC socket is reachable
  // immediately. Found-update path still calls process.exit(0) and launchd respawns
  // the daemon, same behavior as the periodic 6h check.
  if (config.autoUpdate !== false) {
    void checkAndApply();
    startPeriodicUpdateCheck();
  }

  await recoverSessions();
  await sweepOrphans();

  // Heartbeat scanner runs on its own slow clock (every 15min) — orphan startup-scan
  // already completed above, so heartbeats won't fire for asks that should be orphaned instead.
  startHeartbeatScanner();

  // Off the critical path: catch up any completed-but-not-uploaded sessions.
  // Fire-and-forget — uploads run sequentially in the background and must never
  // stall daemon startup or session processing. No-op unless upload is configured.
  void backfillUploads();

  const shutdown = async () => {
    console.log('[sisyphus] Shutting down...');
    stopLogRotator();
    stopPeriodicUpdateCheck();
    stopHeartbeatScanner();
    stopMonitor();
    // Persist all in-memory active time accumulators before exiting
    for (const sessionId of getTrackedSessionIds()) {
      try { await flushTimers(sessionId); } catch { /* best-effort */ }
    }
    try { writeEmptyManifest(); } catch { /* best-effort */ }
    await stopServer();
    releasePidLock();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

process.title = 'sisyphusd';

// Help requests are intercepted by Commander before any action runs;
// timestamp-prefix console output only for operational (non-help) paths.
const isHelpInvocation = process.argv.includes('--help') || process.argv[2] === 'help';
if (!isHelpInvocation) {
  const ts = () => new Date().toISOString();
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  console.log = (...args: unknown[]) => origLog(`[${ts()}]`, ...args);
  console.error = (...args: unknown[]) => origError(`[${ts()}]`, ...args);
}

const rootHelpText = `sisyphusd: long-lived orchestration daemon for sis sessions.

Subtrees
  start    boot the daemon and recover sessions     | use when no daemon is running for this user
  stop     terminate the running daemon             | use to free the IPC socket or before an upgrade
  restart  stop, then start                          | use after a binary upgrade or config change

Globals
  --help   print this message

I/O contract: subprocess control (no JSON; this is a process-lifecycle tool, not an agent surface).
Exit 0 on success, non-zero on failure. Diagnostic output streams to stderr; structured payloads are absent — for session/agent state, use \`sis session inspect status\` and friends.
`;

const program = new Command()
  .name('sisyphusd')
  .description('Long-lived orchestration daemon for sis sessions.')
  .helpOption('--help', 'print this message')
  .allowExcessArguments(false)
  .showSuggestionAfterError(false)
  .exitOverride((err) => {
    // Spec: unknown command + unknown option exit with code 2 (not Commander's default 1).
    if (err.code === 'commander.unknownCommand' || err.code === 'commander.unknownOption' || err.code === 'commander.excessArguments') {
      // Commander's own message for excessArguments does not include the offending token —
      // surface it explicitly so the spec contract (stderr names the unknown command) holds.
      const offender = process.argv[2];
      if (offender) {
        process.stderr.write(`error: unknown command '${offender}'\n`);
      }
      process.exit(2);
    }
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.help') {
      process.exit(0);
    }
    process.exit(err.exitCode ?? 1);
  })
  .action(async () => { await startDaemon(); });

// Preserve the exact existing root help text.
(program as unknown as { helpInformation(): string }).helpInformation = () => rootHelpText;

// `help` subcommand mirrors `--help` at the root: print rootHelpText and exit 0.
program
  .command('help')
  .description('Print sisyphusd help')
  .helpOption('--help', 'print this message')
  .action(() => {
    process.stdout.write(rootHelpText);
    process.exit(0);
  });

program
  .command('start')
  .description('Boot the daemon and recover sessions')
  .helpOption('--help', 'display help for command')
  .addHelpText('after', `
start: launch the sisyphus daemon process.

Input
  None.

Output (subprocess control; diagnostic text to stderr; no JSON — daemon-control carve-out)
  Progress messages stream to stderr. Blocks until the daemon event loop is running and sessions are recovered.

Effects
  Acquires the IPC socket. Writes pid file. Recovers active sessions from registry. Starts pane monitor and heartbeat scanner.

Exit codes: 0 ok | non-zero on failure (diagnostic on stderr).
`)
  .action(async () => { await startDaemon(); });

program
  .command('stop')
  .description('Terminate the running daemon')
  .helpOption('--help', 'display help for command')
  .addHelpText('after', `
stop: terminate the running daemon process.

Input
  None.

Output (subprocess control; diagnostic text to stderr; no JSON — daemon-control carve-out)
  Reports daemon pid and stop status to stderr. Waits up to 5s for graceful SIGTERM; falls back to SIGKILL.

Effects
  Sends SIGTERM (then SIGKILL if needed). Removes pid file. Releases IPC socket.

Exit codes: 0 ok | non-zero on failure (diagnostic on stderr).
`)
  .action(() => { stopDaemon(); });

program
  .command('restart')
  .description('Stop, then start the daemon')
  .helpOption('--help', 'display help for command')
  .addHelpText('after', `
restart: stop the running daemon, then start a fresh one.

Input
  None.

Output (subprocess control; diagnostic text to stderr; no JSON — daemon-control carve-out)
  Reports stop and start progress to stderr. When launchd manages the daemon, exits after confirming respawn.

Effects
  Stops the running daemon (SIGTERM/SIGKILL). If launchd-managed, exits and lets launchd respawn via KeepAlive. Otherwise starts the daemon in-process.

Exit codes: 0 ok | non-zero on failure (diagnostic on stderr).
`)
  .action(async () => {
    stopDaemon();
    if (isLaunchdManaged()) {
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        const respawnedPid = readPid();
        if (respawnedPid) {
          console.log(`[sisyphus] Daemon restarted (pid ${respawnedPid}) by process manager`);
          process.exit(0);
        }
      }
      console.log('[sisyphus] Daemon will be restarted by process manager');
      process.exit(0);
    }
    await startDaemon();
  });

program.parseAsync(process.argv).catch((err) => {
  console.error('[sisyphus] Fatal error:', err);
  process.exit(1);
});
