import { v4 as uuidv4 } from 'uuid';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as state from './state.js';
import * as orchestrator from './orchestrator.js';
import * as tmux from './tmux.js';
import { spawnAgent, restartAgent, resetAgentCounterFromState, clearAgentCounter, handleAgentSubmit, handleAgentReport, handleAgentKilled, gcBgTasks } from './agent.js';
import { trackSession, untrackSession, updateTrackedWindow, flushTimers, flushCycleTimer, flushAgentTimer, registerAgentTimer, markEventCompletion, markEventCrash, markEventLevelUp } from './pane-monitor.js';
import { resetColors } from './colors.js';
import { loadConfig } from '../shared/config.js';
import { goalPath, sessionDir, sessionsDir, tmuxSessionName } from '../shared/paths.js';
import { unregisterSessionPanes, unregisterAgentPane, getSessionPanes } from './pane-registry.js';
import type { Session } from '../shared/types.js';
import { sendTerminalNotification } from './notify.js';
import { generateSessionName, generateSentiment } from './summarize.js';
import { registerSessionTmux, setSessionName } from './server.js';
import { respawningSessions } from './respawn-guard.js';
import { recomputeDots, markSessionCompleted } from './status-dots.js';
import { loadCompanion, saveCompanion, recordCommentary, recordFeedback, onSessionStart, onSessionComplete, onAgentSpawned, onAgentCrashed, getTitle, ACHIEVEMENTS, computeStrengthGain, computeWisdomGain, captureObservationContext, runPostSessionObservations } from './companion.js';
import { buildMemoryContext } from './companion-memory.js';
import { SPINNER_VERBS } from '../shared/companion-render.js';
import { generateCommentary, generateNickname } from './companion-commentary.js';
import { showCommentaryPopupQueue } from './companion-popup.js';
import type { PopupPage } from './companion-popup.js';
import { buildModeTransitionCommentary } from './mode-transition.js';
import type { CommentaryEvent, CompanionState } from '../shared/companion-types.js';
import { emitHistoryEvent, writeSessionSummary, pruneHistory } from './history.js';
import { runSessionUploadAndPersist } from './uploader.js';
import { isUploadConfigured } from '../shared/upload.js';
import { getSisyphusVersion } from '../shared/version.js';
import { markAgentAsksOrphan, orphanRunningAgentAsks, resolveOrchestratorOrphanAsks, resolveAgentOrphanAsks } from './orphan-asks.js';
import { listOpenAsksFor } from './ask-store.js';
import { ORCHESTRATOR_ASKED_BY } from '../shared/types.js';
import { formatDuration } from '../shared/format.js';

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '...';
}

function readGoal(cwd: string, sessionId: string, fallback: string): string {
  try {
    const p = goalPath(cwd, sessionId);
    if (existsSync(p)) return readFileSync(p, 'utf-8').trim();
  } catch { /* fall through */ }
  return fallback;
}

function fireHaikuNaming(
  sessionId: string,
  cwd: string,
  fallbackTmuxName: string,
  task: string,
): void {
  generateSessionName(task).then(async (generatedName) => {
    if (!generatedName) {
      console.log(`[sisyphus] Name generation returned null for session ${sessionId}`);
      return;
    }
    let finalName = generatedName;
    let candidate = tmuxSessionName(cwd, finalName);
    let attempt = 0;
    while (tmux.sessionNameTaken(candidate) && attempt < 5) {
      attempt++;
      finalName = `${generatedName}-${attempt}`;
      candidate = tmuxSessionName(cwd, finalName);
    }
    if (tmux.sessionNameTaken(candidate)) return;

    const currentSession = state.getSession(cwd, sessionId);
    const currentTmuxSessId = currentSession.tmuxSessionId;
    const renameTarget = currentTmuxSessId ?? fallbackTmuxName;

    try {
      tmux.renameSession(renameTarget, candidate);
    } catch { return; }

    await state.updateSessionName(cwd, sessionId, finalName);
    const windowId = currentSession.tmuxWindowId!;
    await state.updateSessionTmux(cwd, sessionId, candidate, windowId, currentTmuxSessId);
    trackSession(sessionId, cwd, currentTmuxSessId, candidate);
    registerSessionTmux(sessionId, candidate, windowId, currentTmuxSessId);
    setSessionName(sessionId, finalName);

    const session = state.getSession(cwd, sessionId);
    for (const pane of getSessionPanes(sessionId)) {
      tmux.updatePaneMeta(pane.paneId, { session: finalName });
      if (pane.role === 'orchestrator') {
        tmux.setPaneTitle(pane.paneId, `ssph:orch ${finalName} c${session.orchestratorCycles.length}`);
      } else if (pane.role === 'agent' && pane.agentId) {
        const agent = session.agents.find(a => a.id === pane.agentId);
        if (agent) {
          const shortType = agent.agentType && agent.agentType !== 'worker'
            ? agent.agentType.replace(/^sisyphus:/, '')
            : '';
          const paneLabel = shortType ? `${agent.name}-${shortType}` : agent.name;
          tmux.setPaneTitle(pane.paneId, `ssph:${finalName} ${paneLabel} c${session.orchestratorCycles.length}`);
        }
      }
    }
    emitHistoryEvent(sessionId, 'session-named', { name: finalName });
    console.log(`[sisyphus] Session ${sessionId} named: ${finalName}`);
  }).catch((err) => {
    console.error(`[sisyphus] Name generation failed for session ${sessionId}:`, err);
  });
}

function fireCommentary(event: CommentaryEvent, companion: CompanionState, context?: string, flash = false, repo?: string, sessionId?: string, popupTitle?: string): void {
  const memoryCtx = buildMemoryContext(repo);
  generateCommentary(event, companion, context, memoryCtx).then(text => {
    if (text) {
      try {
        const c = loadCompanion();
        recordCommentary(c, text, event);
        if (flash) {
          const feedback = showCommentaryPopupQueue([{ text, title: popupTitle }]);
          if (feedback) {
            recordFeedback(c, text, feedback.rating, event, feedback.comment);
            if (sessionId) {
              emitHistoryEvent(sessionId, 'popup-feedback', { commentaryText: text, rating: feedback.rating, comment: feedback.comment, event, mood: c.mood });
            }
          }
        }
        saveCompanion(c);
      } catch { /* non-fatal */ }
    }
  }).catch(() => {});
}

/**
 * Generate all completion commentaries in parallel, then show them as a queued popup
 * (Enter advances through pages). Each event also saves to lastCommentary.
 */
function fireCompletionCommentary(
  events: Array<{ event: CommentaryEvent; companion: CompanionState; context?: string; popupTitle?: string }>,
  memoryCtx?: string,
  sessionId?: string,
): void {
  if (events.length === 0) return;
  Promise.all(
    events.map(({ event, companion, context }) =>
      generateCommentary(event, companion, context, memoryCtx).catch(() => null)
    )
  ).then(results => {
    const pages: PopupPage[] = [];
    let primaryText: string | null = null;
    try {
      const c = loadCompanion();
      for (let i = 0; i < results.length; i++) {
        const text = results[i];
        if (!text) continue;
        recordCommentary(c, text, events[i].event);
        if (primaryText === null) primaryText = text;
        pages.push({ text, title: events[i].popupTitle });
      }
      saveCompanion(c);
    } catch { /* non-fatal */ }
    if (pages.length > 0) {
      const feedback = showCommentaryPopupQueue(pages);
      if (feedback && primaryText !== null) {
        try {
          const c = loadCompanion();
          recordFeedback(c, primaryText, feedback.rating, events[0].event, feedback.comment);
          saveCompanion(c);
          if (sessionId) {
            emitHistoryEvent(sessionId, 'popup-feedback', { commentaryText: primaryText, rating: feedback.rating, comment: feedback.comment, event: events[0].event, mood: c.mood });
          }
        } catch { /* non-fatal */ }
      }
    }
  }).catch(() => {});
}

function switchToHomeSession(session: Session): void {
  if (!session.tmuxSessionName && !session.tmuxSessionId) return;
  const home = tmux.findHomeSession(session.cwd);
  if (home) tmux.switchAttachedClients(session.tmuxSessionId ?? session.tmuxSessionName!, home);
}

export async function startSession(task: string, cwd: string, context?: string, name?: string, effort?: 'low' | 'medium' | 'high' | 'xhigh'): Promise<Session> {
  const sessionId = uuidv4();

  if (name && !NAME_PATTERN.test(name)) {
    throw new Error(`Invalid session name "${name}": only alphanumeric, hyphens, and underscores allowed`);
  }

  const tmuxName = tmuxSessionName(cwd, name != null ? name : sessionId.slice(0, 8));

  if (tmux.sessionNameTaken(tmuxName)) {
    throw new Error(`Tmux session "${tmuxName}" already exists. Choose a different name.`);
  }

  const session = state.createSession(sessionId, task, cwd, context, name, effort);

  const config = loadConfig(cwd);
  const model = config.model;
  await state.updateSession(cwd, sessionId, {
    model,
    launchConfig: {
      model,
      context,
      orchestratorPrompt: config.orchestratorPrompt,
    },
  });

  const { windowId, initialPaneId, sessionId: tmuxSessId } = tmux.createSession(tmuxName, cwd);
  tmux.initSessionMeta(tmuxSessId, cwd, sessionId);
  await state.updateSessionTmux(cwd, sessionId, tmuxName, windowId, tmuxSessId);

  trackSession(sessionId, cwd, tmuxSessId, tmuxName);
  await orchestrator.spawnOrchestrator(sessionId, cwd, windowId);
  updateTrackedWindow(sessionId, windowId);

  // Kill the initial pane created by tmux new-session (orchestrator has its own)
  tmux.killPane(initialPaneId);

  pruneOldSessions(cwd);
  pruneHistory();

  emitHistoryEvent(sessionId, 'session-start', { task, cwd, model: model ?? null, context: context?.slice(0, 2000) ?? null });

  // Fire-and-forget: auto-generate a descriptive session name via Haiku
  if (!name) {
    fireHaikuNaming(sessionId, cwd, tmuxName, task);
  }

  try { recomputeDots(); } catch { /* best-effort */ }

  // Companion hook — fire-and-forget, errors must not break session flow
  try {
    const companion = loadCompanion();
    onSessionStart(companion, cwd);
    saveCompanion(companion);
    fireCommentary('session-start', companion, task, false, cwd, sessionId);
  } catch { /* companion errors are non-fatal */ }

  return { ...state.getSession(cwd, sessionId), tmuxSessionName: tmuxName };
}

export async function cloneSession(
  sourceId: string,
  cwd: string,
  goal: string,
  context?: string,
  name?: string,
  strategy?: boolean,
): Promise<Session> {
  // 1. Validate source
  const sourceSession = state.getSession(cwd, sourceId);
  if (sourceSession.status === 'completed') {
    throw new Error('Cannot clone completed session. Use `sis session lifecycle continue` to resume it first.');
  }

  // 2. Generate clone identity
  const cloneId = uuidv4();

  if (name && !NAME_PATTERN.test(name)) {
    throw new Error(`Invalid session name "${name}": only alphanumeric, hyphens, and underscores allowed`);
  }

  const tmuxName = tmuxSessionName(cwd, name ?? cloneId.slice(0, 8));

  if (tmux.sessionNameTaken(tmuxName)) {
    throw new Error(`Tmux session "${tmuxName}" already exists. Choose a different name.`);
  }

  // 3. Filesystem: clone session directory and state
  state.cloneSessionDir(cwd, sourceId, cloneId, goal, context, strategy);
  const config = loadConfig(cwd);
  const cloneState = await state.createCloneState(cwd, sourceId, cloneId, goal, context, config.model, config.orchestratorPrompt);

  // 5. Tmux session
  const { windowId, initialPaneId, sessionId: tmuxSessId } = tmux.createSession(tmuxName, cwd);
  tmux.initSessionMeta(tmuxSessId, cwd, cloneId);
  await state.updateSessionTmux(cwd, cloneId, tmuxName, windowId, tmuxSessId);

  // 6. Track & spawn
  trackSession(cloneId, cwd, tmuxSessId, tmuxName);
  resetAgentCounterFromState(cloneId, cloneState.agents);

  const sourceGoal = readGoal(cwd, sourceId, sourceSession.task);
  let orientationMessage = `This is a **cloned session**, forked from an existing session.

Source session: ${sourceId}
Previous goal: ${sourceGoal}

You have full access to the previous session's context/, reports/,
and cycle history. Use them as background for your work.

Your new goal is: ${goal}`;

  if (context) {
    orientationMessage += `\n\n### Additional Context\n${context}`;
  }

  orientationMessage += `\n\n**Important**: The source session continues independently.
It is the other session's responsibility. You do not need to monitor it.

### Next Steps
1. Review inherited context/ and reports/
2. Write strategy.md for your approach
3. Update roadmap.md with your work plan
4. Begin delegating work to agents`;

  await orchestrator.spawnOrchestrator(cloneId, cwd, windowId, orientationMessage, 'discovery');
  updateTrackedWindow(cloneId, windowId);
  tmux.killPane(initialPaneId);

  // 7. History events
  emitHistoryEvent(sourceId, 'session-cloned', { cloneSessionId: cloneId, cloneGoal: goal });
  emitHistoryEvent(cloneId, 'cloned-from', { sourceSessionId: sourceId, sourceGoal: sourceSession.task });

  // 8. Haiku naming (fire-and-forget)
  if (!name) {
    fireHaikuNaming(cloneId, cwd, tmuxName, goal);
  }

  // 9. Housekeeping
  pruneOldSessions(cwd);
  pruneHistory();
  try { recomputeDots(); } catch { /* best-effort */ }

  try {
    const companion = loadCompanion();
    onSessionStart(companion, cwd);
    saveCompanion(companion);
    fireCommentary('session-start', companion, goal, false, cwd, cloneId);
  } catch { /* companion errors are non-fatal */ }

  // 10. Return
  return { ...state.getSession(cwd, cloneId), tmuxSessionName: tmuxName };
}

const PRUNE_KEEP_COUNT = 10;
const PRUNE_KEEP_DAYS = 7;

function pruneOldSessions(cwd: string): void {
  try {
    const dir = sessionsDir(cwd);
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });
    const candidates: Array<{ id: string; createdAt: number }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const session = state.getSession(cwd, entry.name);
        if (session.status === 'active' || session.status === 'paused') continue;
        candidates.push({ id: session.id, createdAt: new Date(session.createdAt).getTime() });
      } catch {
        // Unreadable session dir — skip, don't delete
      }
    }

    if (candidates.length <= PRUNE_KEEP_COUNT) return;

    candidates.sort((a, b) => b.createdAt - a.createdAt);

    const cutoff = Date.now() - PRUNE_KEEP_DAYS * 24 * 60 * 60 * 1000;
    const keep = new Set<string>();

    for (let i = 0; i < Math.min(PRUNE_KEEP_COUNT, candidates.length); i++) {
      keep.add(candidates[i]!.id);
    }
    for (const c of candidates) {
      if (c.createdAt >= cutoff) keep.add(c.id);
    }

    for (const c of candidates) {
      if (keep.has(c.id)) continue;
      rmSync(sessionDir(cwd, c.id), { recursive: true, force: true });
    }
  } catch (err) {
    console.error('[sisyphus] Session pruning failed:', err);
  }
}

export async function reopenWindow(sessionId: string, cwd: string): Promise<{ tmuxSessionName: string; tmuxWindowId: string }> {
  const session = state.getSession(cwd, sessionId);
  const tmuxName = session.tmuxSessionName ?? tmuxSessionName(cwd, session.name ?? sessionId.slice(0, 8));

  // If window still exists, just return the existing IDs
  if (tmux.isSessionAlive(session.tmuxSessionId, tmuxName) && session.tmuxWindowId) {
    return { tmuxSessionName: tmuxName, tmuxWindowId: session.tmuxWindowId };
  }

  // Create fresh tmux session
  const created = tmux.createSession(tmuxName, cwd);
  tmux.initSessionMeta(created.sessionId, cwd, sessionId);
  await state.updateSessionTmux(cwd, sessionId, tmuxName, created.windowId, created.sessionId);

  return { tmuxSessionName: tmuxName, tmuxWindowId: created.windowId };
}

export async function reconnectSession(sessionId: string, cwd: string): Promise<{ tmuxSessionName: string; tmuxWindowId: string; tmuxSessionId: string }> {
  const session = state.getSession(cwd, sessionId);
  const tmuxName = session.tmuxSessionName ?? tmuxSessionName(cwd, session.name ?? sessionId.slice(0, 8));

  // Find the tmux session by name (since $N ID may be stale/missing)
  if (!tmux.sessionNameTaken(tmuxName)) {
    throw new Error(`No tmux session named "${tmuxName}" exists. Use \`sis session lifecycle resume\` to create a new one.`);
  }

  const tmuxSessId = tmux.resolveSessionId(tmuxName);
  if (!tmuxSessId) {
    throw new Error(`Could not resolve tmux session ID for "${tmuxName}".`);
  }

  // Discover the window ID
  const windowId = tmux.getFirstWindowId(tmuxSessId) ?? tmux.getFirstWindowId(tmuxName);
  if (!windowId) {
    throw new Error(`tmux session "${tmuxName}" exists but has no windows.`);
  }

  // Update state with the live tmux IDs
  tmux.initSessionMeta(tmuxSessId, cwd, sessionId);
  await state.updateSessionTmux(cwd, sessionId, tmuxName, windowId, tmuxSessId);

  // Re-track in daemon
  registerSessionTmux(sessionId, tmuxName, windowId, tmuxSessId);
  trackSession(sessionId, cwd, tmuxSessId, tmuxName);
  updateTrackedWindow(sessionId, windowId);

  console.log(`[sisyphus] Reconnected session ${sessionId} to tmux session ${tmuxName} (${tmuxSessId}, window ${windowId})`);
  return { tmuxSessionName: tmuxName, tmuxWindowId: windowId, tmuxSessionId: tmuxSessId };
}

export async function resumeSession(sessionId: string, cwd: string, message?: string): Promise<Session> {
  const session = state.getSession(cwd, sessionId);

  const tmuxName = session.tmuxSessionName ?? tmuxSessionName(cwd, session.name ?? sessionId.slice(0, 8));

  let windowId: string;
  let tmuxSessId: string | undefined;
  let initialPaneId: string | undefined;
  if (tmux.isSessionAlive(session.tmuxSessionId, tmuxName) && session.tmuxWindowId) {
    // Reuse existing tmux session
    windowId = session.tmuxWindowId;
    tmuxSessId = session.tmuxSessionId;
  } else {
    // Create fresh tmux session with the same name
    const created = tmux.createSession(tmuxName, cwd);
    windowId = created.windowId;
    tmuxSessId = created.sessionId;
    initialPaneId = created.initialPaneId;
    await state.updateSessionTmux(cwd, sessionId, tmuxName, windowId, tmuxSessId);
  }
  // Re-stamp @sisyphus_cwd + @sisyphus_session_id on both reuse and create —
  // tmux options are in-memory and lost whenever the server restarts, so a
  // reused session post-restart can be missing its stamps.
  if (tmuxSessId) tmux.initSessionMeta(tmuxSessId, cwd, sessionId);

  const previousStatus = session.status;
  let lostAgentCount = 0;

  if (session.status !== 'active') {
    // Determine which agents still have live panes
    const livePaneIds = new Set<string>();
    if (session.tmuxWindowId) {
      const panes = tmux.listPanes(session.tmuxWindowId);
      for (const pane of panes) {
        livePaneIds.add(pane.paneId);
      }
    }

    // Mark running agents as "lost" only if their pane is gone (or no window ID to check)
    for (const agent of session.agents) {
      if (agent.status === 'running') {
        const isAlive = agent.paneId != null && livePaneIds.has(agent.paneId);
        if (!isAlive) {
          await state.updateAgent(cwd, sessionId, agent.id, {
            status: 'lost',
            completedAt: new Date().toISOString(),
            killedReason: 'session resumed — agent was still running',
          });
          emitHistoryEvent(sessionId, 'agent-exited', { agentId: agent.id, status: 'lost', activeMs: agent.activeMs, reason: 'pane gone on resume' });
          lostAgentCount++;
        }
      }
    }
  }

  await state.updateSessionStatus(cwd, sessionId, 'active');
  await state.updateSession(cwd, sessionId, { resumeCount: (session.resumeCount ?? 0) + 1 });
  emitHistoryEvent(sessionId, 'session-resumed', { previousStatus, lostAgentCount });
  await state.updateSessionTmux(cwd, sessionId, tmuxName, windowId, tmuxSessId);

  // Clear any prior orphan state — a successful resume answers the orchestrator orphan ask
  // and removes the sticky session.orphaned flag. Done before spawn so pane-monitor ticks
  // during the spawn window don't see a stale orphan flag.
  await Promise.all([
    state.clearSessionOrphan(cwd, sessionId),
    resolveOrchestratorOrphanAsks(cwd, sessionId, 'resume'),
  ]);

  // Reset counters based on existing agents
  resetAgentCounterFromState(sessionId, session.agents);
  resetColors(sessionId);
  orchestratorDone.delete(sessionId);

  trackSession(sessionId, cwd, tmuxSessId, tmuxName);
  // Guard against pane-monitor re-orphaning while the new orchestrator is being spawned —
  // the old orchPaneId points to a dead pane until spawnOrchestrator registers the new one.
  respawningSessions.add(sessionId);
  try {
    await orchestrator.spawnOrchestrator(sessionId, cwd, windowId, message);
  } finally {
    respawningSessions.delete(sessionId);
  }
  updateTrackedWindow(sessionId, windowId);

  // Kill the initial pane if we created a fresh tmux session
  if (initialPaneId) {
    tmux.killPane(initialPaneId);
  }

  try { recomputeDots(); } catch { /* best-effort */ }
  return state.getSession(cwd, sessionId);
}

export function getSessionStatus(cwd: string, sessionId: string): Session {
  return state.getSession(cwd, sessionId);
}

export interface SessionListEntry {
  id: string;
  name?: string;
  task: string;
  status: string;
  createdAt: string;
  activeMs: number;
  agentCount: number;
  runningAgentCount: number;
  tmuxSessionName?: string;
  tmuxWindowId?: string;
  orphaned?: boolean;
  handoff?: {
    queuedAt: string;
    sentAt?: string;
    reclaimedAt?: string;
    target?: { provider: string; repo: string };
    lastError?: string;
  };
}

/**
 * Cheap count of session directories without parsing any state. Used by the
 * `list` IPC handler to compute its other-cwd hint — loading state.json for
 * every session of every tracked cwd just to take `.length` was a multi-second
 * cold-cache blocker on the main thread.
 */
export function countSessions(cwd: string): number {
  const dir = sessionsDir(cwd);
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n++;
  }
  return n;
}

export function listSessions(cwd: string): SessionListEntry[] {
  const dir = sessionsDir(cwd);
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  const sessions: SessionListEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const session = state.getSession(cwd, entry.name);
      sessions.push({
        id: session.id,
        name: session.name,
        task: session.task,
        status: session.status,
        createdAt: session.createdAt,
        activeMs: session.activeMs,
        agentCount: session.agents.length,
        runningAgentCount: session.agents.filter(a => a.status === 'running').length,
        tmuxSessionName: session.tmuxSessionName,
        tmuxWindowId: session.tmuxWindowId,
        orphaned: session.orphaned ?? false,
        handoff: session.handoff
          ? {
              queuedAt: session.handoff.queuedAt,
              sentAt: session.handoff.sentAt,
              reclaimedAt: session.handoff.reclaimedAt,
              target: session.handoff.target,
              lastError: session.handoff.lastError,
            }
          : undefined,
      });
    } catch (err) {
      console.error(`[sisyphus] Failed to read session ${entry.name}:`, err);
    }
  }

  return sessions;
}

const pendingRespawns = new Set<string>();
// Track sessions where the orchestrator has exited (yielded, crashed, etc.)
// Prevents respawning a new orchestrator while the current one is still running
const orchestratorDone = new Set<string>();

export function onAllAgentsDone(sessionId: string, cwd: string, windowId: string): void {
  if (pendingRespawns.has(sessionId)) return;

  // Don't respawn while the orchestrator is still running — wait for yield.
  // Also check persisted state: if the last cycle has completedAt, the orchestrator
  // already yielded (e.g., before a daemon restart wiped in-memory state).
  if (!orchestratorDone.has(sessionId)) {
    const session = state.getSession(cwd, sessionId);
    const lastCycle = session.orchestratorCycles[session.orchestratorCycles.length - 1];
    if (lastCycle?.completedAt) {
      orchestratorDone.add(sessionId);
    } else {
      console.log(`[sisyphus] All agents done for session ${sessionId}, waiting for orchestrator to yield`);
      return;
    }
  }

  const session = state.getSession(cwd, sessionId);
  if (session.status !== 'active') {
    respawningSessions.delete(sessionId);
    return;
  }

  pendingRespawns.add(sessionId);
  orchestratorDone.delete(sessionId);

  // Snapshot state at cycle boundary before respawning orchestrator
  const cycleNumber = session.orchestratorCycles.length;
  if (cycleNumber > 0) {
    state.createSnapshot(cwd, sessionId, cycleNumber);
  }

  const lastCycle = session.orchestratorCycles[session.orchestratorCycles.length - 1];
  if (lastCycle) {
    emitHistoryEvent(sessionId, 'cycle-boundary', { cycle: lastCycle.cycle, mode: lastCycle.mode ?? null, agentsSpawned: lastCycle.agentsSpawned.length, activeMs: session.activeMs });
  }

  // Advance the companion's spinner verb at the cycle boundary. Per-cycle
  // commentary was removed — the companion now speaks only on mode transitions
  // (see handleYield) and at session end.
  try {
    const companion = loadCompanion();
    companion.spinnerVerbIndex = (companion.spinnerVerbIndex + 1) % SPINNER_VERBS.length;
    saveCompanion(companion);
  } catch { /* non-fatal */ }

  // Respawn on next tick — agents already finished, no delay needed
  setImmediate(async () => {
    pendingRespawns.delete(sessionId);
    try {
      // Re-activate if the pane monitor raced and paused us during a yield await
      const freshSession = state.getSession(cwd, sessionId);
      if (freshSession.status === 'paused' && respawningSessions.has(sessionId)) {
        await state.updateSessionStatus(cwd, sessionId, 'active');
      } else if (freshSession.status !== 'active') {
        respawningSessions.delete(sessionId);
        return;
      }

      // Cloud handoff intercept — if a handoff is queued and hasn't shipped
      // yet, ship to cloud (or pause-only) instead of respawning locally.
      // Skip when lastError is set: previous attempt failed and we should not
      // auto-retry on every quiesce — that'd block local progress indefinitely.
      // User must retry explicitly (`sis cloud handoff push --force` again) or cancel.
      // Imported lazily to avoid a require-cycle with cloud-handoff.ts.
      if (freshSession.handoff && !freshSession.handoff.sentAt && !freshSession.handoff.lastError) {
        respawningSessions.delete(sessionId);
        const { performHandoff } = await import('./cloud-handoff.js');
        await performHandoff(sessionId, cwd);
        return;
      }

      // Clear any stale orphan flag now that we're committing to an auto-respawn.
      // Mirrors the resume path (clearSessionOrphan ~@493). Without this the sticky
      // `session.orphaned` set by a daemon-restart sweep or a pane-monitor tick
      // during the normal "orchestrator spawned agent, cycle pane closed" gap
      // never clears, so a healthy auto-respawned session shows a permanent false
      // ⚠ orphan badge in the dashboard. Done before spawn so pane-monitor ticks
      // during the spawn window don't re-see and re-set it.
      // Resolve all pending agent orphan asks for non-running agents — they are
      // superseded by the new orchestrator cycle that is about to spawn fresh agents.
      const sessionForOrphanResolve = state.getSession(cwd, sessionId);
      const supersededAgentIds = sessionForOrphanResolve.agents
        .filter(a => a.status !== 'running')
        .map(a => a.id);
      await Promise.all([
        state.clearSessionOrphan(cwd, sessionId),
        resolveOrchestratorOrphanAsks(cwd, sessionId, 'respawn'),
        ...supersededAgentIds.map(agentId =>
          resolveAgentOrphanAsks(cwd, sessionId, agentId, 'superseded').catch(err => {
            console.warn(
              `[sisyphus] resolveAgentOrphanAsks (superseded) failed for ${agentId}:`,
              err instanceof Error ? err.message : err,
            );
          }),
        ),
      ]);

      // Ensure the tmux session and window still exist.
      // Killing the last pane (orchestrator yield with no agents) destroys the window/session.
      let activeWindowId = windowId;
      const tmuxName = freshSession.tmuxSessionName;
      const existingTmuxSessId = freshSession.tmuxSessionId;
      const sessionStillAlive = tmux.isSessionAlive(existingTmuxSessId, tmuxName ?? undefined);
      const needsRecreation = tmuxName && (
        !sessionStillAlive ||
        tmux.listPanes(activeWindowId).length === 0
      );
      let initialPaneId: string | undefined;
      if (needsRecreation) {
        // Kill stale session if it exists without our window
        if (sessionStillAlive) {
          tmux.killSession(existingTmuxSessId ?? tmuxName!);
        }
        const created = tmux.createSession(tmuxName!, cwd);
        tmux.initSessionMeta(created.sessionId, cwd, sessionId);
        activeWindowId = created.windowId;
        initialPaneId = created.initialPaneId;
        await state.updateSessionTmux(cwd, sessionId, tmuxName!, activeWindowId, created.sessionId);
        trackSession(sessionId, cwd, created.sessionId, tmuxName!);
        registerSessionTmux(sessionId, tmuxName!, activeWindowId, created.sessionId);
      }
      await orchestrator.spawnOrchestrator(sessionId, cwd, activeWindowId);
      updateTrackedWindow(sessionId, activeWindowId);
      if (initialPaneId) tmux.killPane(initialPaneId);

      // Clean up completed agent panes now that the orchestrator is alive
      for (const agent of freshSession.agents) {
        if (agent.status !== 'running' && agent.paneId) {
          tmux.killPane(agent.paneId);
        }
      }
      tmux.selectLayout(activeWindowId);
      try { recomputeDots(); } catch { /* best-effort */ }
    } catch (err) {
      console.error(`[sisyphus] Failed to respawn orchestrator for session ${sessionId}:`, err);
      // Pause the session so the dashboard reflects the failure instead of
      // sitting in a half-active state. Surface to the user via notification —
      // silently logging means they only discover the wedge when they look.
      try {
        const failedSession = state.getSession(cwd, sessionId);
        if (failedSession.status === 'active') {
          await state.updateSessionStatus(cwd, sessionId, 'paused');
        }
        const sessionLabel = failedSession.name ?? sessionId.slice(0, 8);
        const reason = err instanceof Error ? err.message : String(err);
        const config = loadConfig(cwd);
        if (config.notifications?.enabled !== false) {
          sendTerminalNotification(
            sessionLabel,
            `Orchestrator respawn failed — ${reason.slice(0, 80)}`,
            failedSession.tmuxSessionName,
          );
        }
        try { recomputeDots(); } catch { /* best-effort */ }
      } catch (surfaceErr) {
        console.error(`[sisyphus] Additionally failed to surface respawn error for ${sessionId}:`, surfaceErr);
      }
    } finally {
      respawningSessions.delete(sessionId);
    }
  });
}

export async function handleSpawn(
  sessionId: string,
  cwd: string,
  agentType: string,
  name: string,
  instruction: string,
  repo?: string,
): Promise<{ agentId: string }> {
  const windowId = orchestrator.getWindowId(sessionId);
  if (!windowId) throw new Error(`No tmux window found for session ${sessionId}`);

  // Re-activate completed sessions so the cycle can resume
  const session = state.getSession(cwd, sessionId);
  if (session.status === 'completed') {
    await state.updateSessionStatus(cwd, sessionId, 'active');
    trackSession(sessionId, cwd, session.tmuxSessionId, session.tmuxSessionName!);
  }

  const agent = await spawnAgent({
    sessionId,
    sessionName: session.name,
    cycleNum: session.orchestratorCycles.length,
    cwd,
    agentType,
    name,
    instruction,
    windowId,
    repo,
  });

  registerAgentTimer(sessionId, agent.id);
  await state.appendAgentToLastCycle(cwd, sessionId, agent.id);

  emitHistoryEvent(sessionId, 'agent-spawned', { agentId: agent.id, name, agentType, instruction: instruction.slice(0, 500), repo, claudeSessionId: agent.claudeSessionId });

  try { recomputeDots(); } catch { /* best-effort */ }

  // Companion hook — fire-and-forget, errors must not break session flow
  try {
    const companion = loadCompanion();
    onAgentSpawned(companion);
    saveCompanion(companion);
    generateNickname(companion).then(nickname => {
      if (nickname) {
        state.updateAgent(cwd, sessionId, agent.id, { nickname }).catch((err) => { console.warn('[sisyphus] Failed to save agent nickname:', err instanceof Error ? err.message : err); });
        emitHistoryEvent(sessionId, 'agent-nicknamed', { agentId: agent.id, nickname });
      }
    }).catch((err) => { console.warn('[sisyphus] Nickname generation failed:', err instanceof Error ? err.message : err); });
  } catch { /* companion errors are non-fatal */ }

  return { agentId: agent.id };
}

export async function handleSubmit(cwd: string, sessionId: string, agentId: string, report: string, windowId: string): Promise<void> {
  const open = listOpenAsksFor(cwd, sessionId, agentId);
  if (open.length > 0) {
    throw new Error(formatPendingAskError('submit', agentId, open));
  }
  const allDone = await handleAgentSubmit(cwd, sessionId, agentId, report);
  try { recomputeDots(); } catch { /* best-effort */ }
  if (allDone) {
    onAllAgentsDone(sessionId, cwd, windowId);
  }
}

/**
 * Yield/submit guard: an open deck (`pending`/`in-progress`) attributed to the caller
 * means the user is mid-answer or hasn't started. Letting the caller terminate now
 * orphans the answer — the pane closes, no one is left to read `response.json`.
 *
 * Backgrounded vs foreground doesn't change the calculus on the daemon side. The
 * orchestrator pattern is foreground (this guard fires only on bug paths). The
 * agent pattern is background-then-end-turn — `require-submit.sh` lets the agent
 * Stop normally; this guard fires only if the agent calls `sis agent submit`
 * (terminal) before the deck resolves, which would close the pane.
 */
function formatPendingAskError(verb: 'yield' | 'submit', askedBy: string, open: ReturnType<typeof listOpenAsksFor>): string {
  const lines = open.map(a => `  - ${a.askId} (${a.status})${a.title ? ': ' + a.title : ''}`);
  const who = askedBy === ORCHESTRATOR_ASKED_BY ? 'orchestrator' : `agent ${askedBy}`;
  const recovery = verb === 'yield'
    ? `Resolve before yielding: \`sis ask state poll <askId>\` blocks until the user answers, then process the response and yield with a continuation prompt that names the answered branch.`
    : `Resolve before submitting: \`sis ask state poll <askId>\` blocks until the user answers, parse the response, then call \`sis agent submit\` with your final report.`;
  return `Cannot ${verb}: ${who} owns ${open.length} open deck${open.length === 1 ? '' : 's'}:\n${lines.join('\n')}\n\n${recovery}`;
}

export async function handleReport(cwd: string, sessionId: string, agentId: string, content: string): Promise<void> {
  await handleAgentReport(cwd, sessionId, agentId, content);
}

export async function handleYield(sessionId: string, cwd: string, nextPrompt?: string, mode?: string): Promise<void> {
  const open = listOpenAsksFor(cwd, sessionId, ORCHESTRATOR_ASKED_BY);
  if (open.length > 0) {
    throw new Error(formatPendingAskError('yield', ORCHESTRATOR_ASKED_BY, open));
  }

  // Re-activate paused sessions so respawn can proceed
  const pre = state.getSession(cwd, sessionId);
  if (pre.status === 'paused') {
    await state.updateSessionStatus(cwd, sessionId, 'active');
  }

  // Guard against pane monitor pausing us during the yield→respawn transition.
  // Killing the orchestrator pane may destroy the tmux window (if it's the last pane),
  // and the pane monitor could see 0 live panes and pause the session before we respawn.
  respawningSessions.add(sessionId);

  const transition = await orchestrator.handleOrchestratorYield(sessionId, cwd, nextPrompt, mode);

  // Mark orchestrator as done for this cycle — unblocks respawn
  orchestratorDone.add(sessionId);

  // On a real mode switch, the companion comments with the new mode in the popup
  // border ("Starting Implementation"). Fire-and-forget — must not block respawn.
  if (transition) {
    try {
      const companion = loadCompanion();
      const goal = readGoal(cwd, sessionId, state.getSession(cwd, sessionId).task);
      const { context, popupTitle } = buildModeTransitionCommentary(
        cwd, transition.prevMode, transition.nextMode, transition.prevModeStats,
      );
      fireCommentary('mode-transition', companion, `Goal: ${truncate(goal, 100)}\n${context}`, true, cwd, sessionId, popupTitle);
    } catch { /* non-fatal */ }
  }
  try { recomputeDots(); } catch { /* best-effort */ }

  const session = state.getSession(cwd, sessionId);
  const hasRunningAgents = session.agents.some(a => a.status === 'running');
  if (!hasRunningAgents) {
    // Fall back to state's tmuxWindowId if in-memory map is missing (e.g., after daemon restart)
    const windowId = orchestrator.getWindowId(sessionId) ?? session.tmuxWindowId;
    if (windowId) {
      onAllAgentsDone(sessionId, cwd, windowId);
      // Guard cleared inside onAllAgentsDone's setImmediate callback
    } else {
      respawningSessions.delete(sessionId);
    }
  } else {
    // Agents still running — their panes keep the window alive, no race possible
    respawningSessions.delete(sessionId);
  }
}

export async function handleComplete(sessionId: string, cwd: string, report: string): Promise<void> {
  const t0 = Date.now();
  await flushTimers(sessionId);
  await orchestrator.handleOrchestratorComplete(sessionId, cwd, report);
  const session = state.getSession(cwd, sessionId);

  // Orphan pending/in-progress asks of any still-running agents at session completion
  await orphanRunningAgentAsks(cwd, sessionId, session);

  const wallClockMs = Date.now() - new Date(session.createdAt).getTime();
  await state.updateSession(cwd, sessionId, { wallClockMs });
  markSessionCompleted(sessionId, session.createdAt, cwd);

  // Clean up tracking and tmux resources (mirrors handleKill cleanup)
  untrackSession(sessionId);
  unregisterSessionPanes(sessionId);
  clearAgentCounter(sessionId);
  orchestratorDone.delete(sessionId);

  try { recomputeDots(); } catch { /* best-effort */ }

  const completedSession = state.getSession(cwd, sessionId);
  emitHistoryEvent(sessionId, 'session-end', { status: 'completed', activeMs: completedSession.activeMs, wallClockMs: completedSession.wallClockMs ?? null, agentCount: completedSession.agents.length, cycleCount: completedSession.orchestratorCycles.length, completionReport: completedSession.completionReport ?? null });
  writeSessionSummary(completedSession);

  // Fire-and-forget: enrich summary with sentiment once Haiku responds
  const userMessages = completedSession.messages
    .filter(m => typeof m.source === 'object' && m.source.type === 'user')
    .map(m => m.content);
  generateSentiment({
    task: completedSession.task,
    completionReport: completedSession.completionReport,
    agentCount: completedSession.agents.length,
    cycleCount: completedSession.orchestratorCycles.length,
    crashCount: completedSession.agents.filter(a => a.status === 'crashed').length,
    activeMs: completedSession.activeMs,
    messages: userMessages,
  }).then(sentiment => {
    if (sentiment) {
      writeSessionSummary(completedSession, { sentiment });
    }
  }).catch((err) => { console.warn('[sisyphus] Sentiment generation failed:', err instanceof Error ? err.message : err); });

  // Fire-and-forget: archive session zip via the Worker proxy (if configured).
  //   1. Config.upload absent → silent skip.
  //   2. Config.upload present but partial → warn + persist failed (diagnostic).
  //   3. Config.upload complete → fire upload.
  const config = loadConfig(cwd);
  // Capture the raw value before the guard: isUploadConfigured()'s type predicate
  // narrows config.upload to `undefined` on its false branch, but at runtime a
  // partial { url:'', token:'' } is still a present UploadConfig — read it via alias.
  const uploadCfg = config.upload;
  if (isUploadConfigured(config.upload)) {
    runSessionUploadAndPersist({
      sessionId, cwd, fullConfig: config, session: completedSession,
      status: 'completed', sisyphusVersion: getSisyphusVersion(),
    }).catch(() => {
      // arg-less .catch: the underlying error is already persisted to state.uploadError
      // (with a clean Worker-supplied message via parseWorkerError); avoid double-logging.
      console.warn('[sisyphus] upload pipeline crashed; check uploadError on session state');
    });
  } else if (uploadCfg) {
    const missing: string[] = [];
    if (!uploadCfg.url)   missing.push('upload.url');
    if (!uploadCfg.token) missing.push('upload.token');
    const error = `upload skipped: missing ${missing.join(', ')}`;
    console.warn(`[sisyphus] ${error}`);
    state.updateSession(cwd, sessionId, { uploadStatus: 'failed', uploadError: error })
      .catch(() => console.warn('[sisyphus] failed to persist upload skip status'));
  }

  // Companion hook — fire-and-forget, errors must not break session flow
  try {
    const companion = loadCompanion();
    const prevLevel = companion.level;
    // Snapshot pre-update state for the observation engine
    const prevContext = captureObservationContext(companion, completedSession.cwd);
    const newAchievementIds = onSessionComplete(companion, completedSession);
    saveCompanion(companion);
    // Record what was credited so continue→re-complete doesn't double-count
    await state.updateSession(cwd, sessionId, {
      companionCreditedCycles: completedSession.orchestratorCycles.length,
      companionCreditedActiveMs: completedSession.activeMs,
      companionCreditedStrength: computeStrengthGain(completedSession.agents.length),
      companionCreditedWisdom: computeWisdomGain(completedSession),
    });
    markEventCompletion();
    const leveledUp = companion.level > prevLevel;

    const goal = readGoal(cwd, sessionId, completedSession.task);
    const completeCtx = [
      `Goal: ${truncate(goal, 150)}`,
      `Result: ${truncate(report, 200)}`,
      `Stats: ${completedSession.agents.length} agents, ${completedSession.orchestratorCycles.length} cycles, ${formatDuration(completedSession.activeMs)} active`,
    ].join('\n');

    // Collect all completion events — shown as queued popup pages (Enter advances)
    const completionEvents: Array<{ event: CommentaryEvent; companion: CompanionState; context?: string; popupTitle?: string }> = [
      { event: 'session-complete', companion, context: completeCtx },
    ];

    if (leveledUp) {
      markEventLevelUp();
      const prevTitle = getTitle(prevLevel);
      completionEvents.push({
        event: 'level-up',
        companion,
        context: `Level ${prevLevel} (${prevTitle}) \u2192 ${companion.level} (${companion.title}). Task: ${truncate(completedSession.task, 100)}`,
        popupTitle: ` \u2B06 Level ${companion.level} (${companion.title}) `,
      });
    }

    if (newAchievementIds.length > 0) {
      const achievementNames = newAchievementIds
        .map(id => ACHIEVEMENTS.find(a => a.id === id)?.name ?? id);
      completionEvents.push({
        event: 'achievement',
        companion,
        context: achievementNames.join(', '),
        popupTitle: ` \u2605 ${achievementNames[0]} `,
      });
    }

    // Fire observation engine fire-and-forget — errors are logged inside the engine
    void runPostSessionObservations(companion, completedSession, prevContext)
      .catch(err => console.error('[companion-memory] observation engine failed:', err instanceof Error ? err.message : err));

    // Pre-build memory context once for all completion events (avoids redundant disk reads inside Promise.all).
    // Memory reflects the previous state of the repo — observations from this session are not yet persisted.
    const memoryCtx = buildMemoryContext(completedSession.cwd);

    fireCompletionCommentary(completionEvents, memoryCtx, sessionId);
  } catch { /* companion errors are non-fatal */ }

  switchToHomeSession(session);

  // Kill the tmux session after switching clients away
  const completeKillTarget = session.tmuxSessionId ?? session.tmuxSessionName;
  if (completeKillTarget) {
    tmux.killSession(completeKillTarget);
  }

  const sessionName = session.name ?? sessionId.slice(0, 8);
  console.log(`[sisyphus] Session ${sessionName} completed (${session.agents.length} agents, ${session.orchestratorCycles.length} cycles, ${Date.now() - t0}ms)`);
}

export async function handleContinue(sessionId: string, cwd: string): Promise<void> {
  const session = state.getSession(cwd, sessionId);
  await state.continueSession(cwd, sessionId);
  await state.updateSession(cwd, sessionId, { continueCount: (session.continueCount ?? 0) + 1 });
  emitHistoryEvent(sessionId, 'session-continued', { cycleCount: session.orchestratorCycles.length, activeMs: session.activeMs });
}

export async function handleKill(sessionId: string, cwd: string): Promise<number> {
  const t0 = Date.now();
  const sessionName = state.getSession(cwd, sessionId).name ?? sessionId.slice(0, 8);
  console.log(`[sisyphus] Killing session ${sessionName} (${sessionId})`);

  await flushTimers(sessionId);
  const session = state.getSession(cwd, sessionId);
  const wallClockMs = Date.now() - new Date(session.createdAt).getTime();
  await state.updateSession(cwd, sessionId, { wallClockMs });
  const windowId = orchestrator.getWindowId(sessionId);

  // Orphan pending/in-progress asks of running agents before status flip
  await orphanRunningAgentAsks(cwd, sessionId, session);

  // Kill all running agents
  let killedAgents = 0;
  for (const agent of session.agents) {
    if (agent.status === 'running') {
      await state.updateAgent(cwd, sessionId, agent.id, {
        status: 'killed',
        killedReason: 'session killed by user',
        completedAt: new Date().toISOString(),
      });
      killedAgents++;
    }
  }

  // Kill the orchestrator pane if it exists
  const orchPaneId = orchestrator.getOrchestratorPaneId(sessionId);
  if (orchPaneId) {
    tmux.killPane(orchPaneId);
  }

  // Mark session as completed
  await state.updateSessionStatus(cwd, sessionId, 'completed');

  // Untrack from pane monitor and pane registry
  untrackSession(sessionId);
  unregisterSessionPanes(sessionId);

  // Switch any attached clients back to the home session before destroying
  switchToHomeSession(session);

  // Kill the entire tmux session (destroys all panes/windows atomically)
  const killTarget = session.tmuxSessionId ?? session.tmuxSessionName;
  if (killTarget) {
    tmux.killSession(killTarget);
  } else if (windowId) {
    tmux.killWindow(windowId);
  }

  // Clean up agent counter
  clearAgentCounter(sessionId);
  orchestratorDone.delete(sessionId);

  try { recomputeDots(); } catch { /* best-effort */ }

  const killedSession = state.getSession(cwd, sessionId);
  emitHistoryEvent(sessionId, 'session-end', { status: 'killed', activeMs: killedSession.activeMs, wallClockMs: killedSession.wallClockMs ?? null, agentCount: killedSession.agents.length, cycleCount: killedSession.orchestratorCycles.length });
  writeSessionSummary(killedSession);

  console.log(`[sisyphus] Session ${sessionName} killed (${killedAgents} agents, ${Date.now() - t0}ms)`);
  return killedAgents;
}

export async function handleRestartAgent(sessionId: string, cwd: string, agentId: string): Promise<void> {
  const session = state.getSession(cwd, sessionId);
  const agent = session.agents.find(a => a.id === agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);

  const windowId = orchestrator.getWindowId(sessionId) ?? session.tmuxWindowId;
  if (!windowId) throw new Error(`No tmux window found for session ${sessionId}`);

  await restartAgent(sessionId, cwd, agentId, windowId);
}

export async function handleKillAgent(sessionId: string, cwd: string, agentId: string): Promise<void> {
  const session = state.getSession(cwd, sessionId);
  const agent = session.agents.find(a => a.id === agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  if (agent.status !== 'running') throw new Error(`Agent ${agentId} is not running (status: ${agent.status})`);

  // Orphan any pending/in-progress asks before cleanup so meta reflects orphan state
  await markAgentAsksOrphan(cwd, sessionId, agentId);

  // Unregister pane first so the pane monitor doesn't trigger a respawn
  unregisterAgentPane(sessionId, agentId);

  // Flush timer before killing so we capture accumulated active time
  const flushedActiveMs = flushAgentTimer(sessionId, agentId);

  // Kill the tmux pane
  if (agent.paneId) {
    tmux.killPane(agent.paneId);
  }

  await state.updateAgent(cwd, sessionId, agentId, {
    status: 'killed',
    killedReason: 'killed by user',
    completedAt: new Date().toISOString(),
    activeMs: flushedActiveMs,
  });
  emitHistoryEvent(sessionId, 'agent-killed', { agentId, status: 'killed', activeMs: flushedActiveMs, reason: 'killed by user' });
  gcBgTasks(cwd, sessionId, agentId);
}

export async function handleRollback(sessionId: string, cwd: string, toCycle: number): Promise<{ sessionId: string; restoredToCycle: number }> {
  const session = state.getSession(cwd, sessionId);
  const fromCycle = session.orchestratorCycles.length;

  // Validate cycle range
  if (toCycle < 1 || toCycle > session.orchestratorCycles.length) {
    const available = state.listSnapshots(cwd, sessionId);
    throw new Error(
      `Invalid cycle ${toCycle}. Available snapshots: ${available.length > 0 ? available.join(', ') : 'none'}`,
    );
  }

  // Validate snapshot exists
  const available = state.listSnapshots(cwd, sessionId);
  if (!available.includes(toCycle)) {
    throw new Error(
      `No snapshot for cycle ${toCycle}. Available snapshots: ${available.length > 0 ? available.join(', ') : 'none'}`,
    );
  }

  // Flush timers before reading activeMs values, then re-read state
  await flushTimers(sessionId);
  const flushedSession = state.getSession(cwd, sessionId);

  // Capture rollback count BEFORE restore (restore wipes state)
  const currentRollbackCount = (flushedSession.rollbackCount ?? 0) + 1;

  // Kill running agents (without completing session or killing window)
  let killedAgentCount = 0;
  for (const agent of flushedSession.agents) {
    if (agent.status === 'running') {
      // Don't update agent state — restoreSnapshot() below will overwrite it anyway.
      // History events are the only useful record that these agents were killed.
      emitHistoryEvent(sessionId, 'agent-exited', { agentId: agent.id, status: 'killed', activeMs: agent.activeMs, reason: 'session rolled back' });
      killedAgentCount++;
    }
  }

  // Kill orchestrator pane if running
  const orchPaneId = orchestrator.getOrchestratorPaneId(sessionId);
  if (orchPaneId) {
    tmux.killPane(orchPaneId);
  }

  // Untrack from monitor and registry
  untrackSession(sessionId);
  unregisterSessionPanes(sessionId);
  clearAgentCounter(sessionId);
  orchestratorDone.delete(sessionId);

  // Restore snapshot state
  await state.restoreSnapshot(cwd, sessionId, toCycle);

  // Delete snapshots for cycles after the rollback target
  state.deleteSnapshotsAfter(cwd, sessionId, toCycle);

  // Emit rollback event and persist count AFTER restore (restore wipes state)
  emitHistoryEvent(sessionId, 'rollback', { fromCycle, toCycle, killedAgentCount });
  await state.updateSession(cwd, sessionId, { rollbackCount: currentRollbackCount });

  return { sessionId, restoredToCycle: toCycle };
}

export async function handlePaneExited(
  paneId: string,
  cwd: string,
  sessionId: string,
  role: 'orchestrator' | 'agent',
  agentId?: string,
): Promise<void> {
  const session = state.getSession(cwd, sessionId);
  if (session.status !== 'active') return;

  if (role === 'agent' && agentId) {
    const agent = session.agents.find(a => a.id === agentId);
    if (!agent || agent.status !== 'running') return;

    // Agent exited without calling `sis agent submit` — orphan-ask emission
    // (kind:'error') fires the banner via ask-store's gate.
    const allDone = await handleAgentKilled(cwd, sessionId, agentId, 'pane exited');

    emitHistoryEvent(sessionId, 'agent-exited', { agentId, status: 'crashed', activeMs: agent?.activeMs ?? 0 });

    // Companion hook — fire-and-forget, errors must not break session flow
    try {
      const companion = loadCompanion();
      onAgentCrashed(companion);
      saveCompanion(companion);
      markEventCrash();
      const freshSession = state.getSession(cwd, sessionId);
      const typeLabel = agent.agentType.replace(/^sisyphus:/, '');
      let crashCtx = `${agent.name} (${typeLabel}) crashed: ${truncate(agent.instruction, 120)}`;
      const running = freshSession.agents.filter(a => a.status === 'running').length;
      crashCtx += `\n${running}/${freshSession.agents.length} agents still running`;
      fireCommentary('agent-crash', companion, crashCtx, false, session.cwd, sessionId);
    } catch { /* companion errors are non-fatal */ }

    if (allDone) {
      const windowId = orchestrator.getWindowId(sessionId) ?? session.tmuxWindowId;
      if (windowId) {
        onAllAgentsDone(sessionId, cwd, windowId);
      }
    }
  } else if (role === 'orchestrator') {
    // Orchestrator pane exited unexpectedly (crash, context exhaustion, /exit) —
    // pane-monitor emits an orphan-orchestrator ask (kind:'error') which fires
    // the banner via ask-store's gate.

    // Guard against pane monitor pausing us during the await below
    respawningSessions.add(sessionId);

    const cycleActiveMs = flushCycleTimer(sessionId, session.orchestratorCycles.length);
    await state.completeOrchestratorCycle(cwd, sessionId, undefined, undefined, cycleActiveMs);
    orchestratorDone.add(sessionId);
    const hasRunningAgents = session.agents.some(a => a.status === 'running');
    if (!hasRunningAgents && session.agents.length > 0) {
      const windowId = orchestrator.getWindowId(sessionId) ?? session.tmuxWindowId;
      if (windowId) {
        console.log(`[sisyphus] Orchestrator pane exited for session ${sessionId}, all agents done — triggering respawn`);
        onAllAgentsDone(sessionId, cwd, windowId);
        // Guard cleared inside onAllAgentsDone's setImmediate callback
      } else {
        respawningSessions.delete(sessionId);
      }
    } else if (!hasRunningAgents) {
      // No agents at all — pause session
      respawningSessions.delete(sessionId);
      await state.updateSessionStatus(cwd, sessionId, 'paused');
      console.log(`[sisyphus] Session ${sessionId} paused: orchestrator pane exited with no agents`);
    } else {
      // Agents still running — their panes keep the window alive
      respawningSessions.delete(sessionId);
    }
  }
}

/**
 * Tear down a session's local tmux footprint without destroying its state.json.
 * Used by cloud handoff (and pause-only quiesce) — the session lives on
 * elsewhere or is paused for reclaim, so we keep the directory intact but
 * release every tmux/pane-monitor resource the daemon was holding.
 *
 * `interrupted: true` means in-flight panes are being killed mid-work (force
 * handoff). Currently no extra bookkeeping vs `false`, but keeps the call
 * sites readable and lets us hook future telemetry per case.
 */
export async function quiesceLocalSession(
  sessionId: string,
  cwd: string,
  _opts: { interrupted: boolean },
): Promise<void> {
  await flushTimers(sessionId);
  const session = state.getSession(cwd, sessionId);

  const orchPaneId = orchestrator.getOrchestratorPaneId(sessionId);
  if (orchPaneId) tmux.killPane(orchPaneId);

  untrackSession(sessionId);
  unregisterSessionPanes(sessionId);
  clearAgentCounter(sessionId);
  orchestratorDone.delete(sessionId);
  respawningSessions.delete(sessionId);

  // Detach any clients still attached to the window before destroying it.
  switchToHomeSession(session);

  const killTarget = session.tmuxSessionId ?? session.tmuxSessionName;
  if (killTarget) tmux.killSession(killTarget);

  await state.updateSessionStatus(cwd, sessionId, 'paused');

  try { recomputeDots(); } catch (err) {
    console.warn(`[sisyphus] recomputeDots failed during quiesce: ${err instanceof Error ? err.message : String(err)}`);
  }
}
