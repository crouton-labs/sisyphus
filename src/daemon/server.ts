import { createServer, type Server } from 'node:net';
import { unlinkSync, existsSync, writeFileSync, readFileSync, mkdirSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { socketPath, globalDir, messagesDir, sessionsDir } from '../shared/paths.js';
import { join, basename, dirname } from 'node:path';
import type { Request, Response, FocusRequest } from '../shared/protocol.js';
import { errUsage, errNotFound, errAmbiguous, errConflict, errTransient, errPermanent } from '../shared/protocol.js';
import type { MessageSource } from '../shared/types.js';
import { validateSessionId, validateRepoName } from '../shared/shell.js';
import * as sessionManager from './session-manager.js';
import { loadCompanion, saveCompanion } from './companion.js';
import * as state from './state.js';
import { lookupPane, unregisterPane } from './pane-registry.js';
import { emitHistoryEvent } from './history.js';
import { getActiveTimers } from './pane-monitor.js';
import type { Compositor } from './segments/index.js';
import { generateVisualForQuestion } from './ask-visual.js';
import { listAsks, readMeta, readDecisions, autoResolveAsk, listReviewInboxItems } from './ask-store.js';
import { resolveOrchestratorOrphanAsks } from './orphan-asks.js';
import { recomputeDots } from './status-dots.js';
import * as orchestrator from './orchestrator.js';
import * as agent from './agent.js';
import * as tmux from './tmux.js';
import { scanInbox, type InboxItem } from '@crouton-kit/humanloop';
import { askDir } from '../shared/paths.js';

let server: Server | null = null;
let compositor: Compositor | null = null;

export function setCompositor(c: Compositor): void {
  compositor = c;
}

interface SessionTracking {
  cwd: string;
  tmuxSession?: string;
  windowId?: string;
  tmuxSessionId?: string;
  messageCounter: number;
  name?: string;
}
const sessionTrackingMap = new Map<string, SessionTracking>();

// Latest dashboard deep-link focus request (last-write-wins, in-memory). Set by
// `focus-set`, consumed-and-cleared by `focus-get`. Ephemeral — losing it on a
// daemon restart is fine (the CLI re-fires after relaunching the dashboard).
let pendingFocus: FocusRequest | null = null;
const FOCUS_TTL_MS = 30_000;

function registryPath(): string {
  return join(globalDir(), 'session-registry.json');
}

function persistSessionRegistry(): void {
  const dir = globalDir();
  mkdirSync(dir, { recursive: true });
  const registry: Record<string, string> = {};
  for (const [id, tracking] of sessionTrackingMap) {
    registry[id] = tracking.cwd;
  }
  writeFileSync(registryPath(), JSON.stringify(registry, null, 2), 'utf-8');
}

export function loadSessionRegistry(): Record<string, string> {
  const p = registryPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, string>;
  } catch (err) {
    console.warn('[sisyphus] Failed to parse session registry:', err instanceof Error ? err.message : err);
    return {};
  }
}

export function registerSessionCwd(sessionId: string, cwd: string): void {
  const existing = sessionTrackingMap.get(sessionId);
  if (existing) {
    existing.cwd = cwd;
  } else {
    sessionTrackingMap.set(sessionId, { cwd, messageCounter: 0 });
  }
  persistSessionRegistry();
}

export function setSessionName(sessionId: string, name: string): void {
  const tracking = sessionTrackingMap.get(sessionId);
  if (tracking) tracking.name = name;
}

export function registerSessionTmux(sessionId: string, tmuxSession: string, windowId: string, tmuxSessionId?: string): void {
  const existing = sessionTrackingMap.get(sessionId);
  if (existing) {
    existing.tmuxSession = tmuxSession;
    existing.windowId = windowId;
    existing.tmuxSessionId = tmuxSessionId;
  } else {
    sessionTrackingMap.set(sessionId, { cwd: '', tmuxSession, windowId, tmuxSessionId, messageCounter: 0 });
  }
}

function unknownSessionError(sessionId: string): Response {
  return {
    ok: false,
    error: errNotFound('unknown_session', {
      message: `Unknown session: ${sessionId}. Run \`sis session inspect list --all\` to see available sessions.`,
      received: sessionId,
      next: 'sis session inspect list --all',
    }),
  };
}

/**
 * Build a map of sessionId → cwd from all known sources:
 * in-memory tracking map, persisted registry, and on-disk session directories.
 */
function collectAllSessionIds(): Map<string, string> {
  const idToCwd = new Map<string, string>();

  // 1. In-memory tracking map (authoritative for active sessions)
  for (const [id, tracking] of sessionTrackingMap) {
    idToCwd.set(id, tracking.cwd);
  }

  // 2. Persisted registry
  const registry = loadSessionRegistry();
  for (const [id, cwd] of Object.entries(registry)) {
    if (!idToCwd.has(id)) idToCwd.set(id, cwd);
  }

  // 3. Scan on-disk session dirs across all known cwds
  const scannedCwds = new Set<string>();
  for (const cwd of idToCwd.values()) {
    if (scannedCwds.has(cwd)) continue;
    scannedCwds.add(cwd);
    try {
      const dir = sessionsDir(cwd);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !idToCwd.has(entry.name)) {
          idToCwd.set(entry.name, cwd);
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  return idToCwd;
}

/**
 * Resolve a potentially partial session ID to a full UUID.
 * Checks in-memory tracking map, persisted registry, and on-disk sessions.
 * Returns the full ID on unique match, or an error response on ambiguity.
 * Also hydrates the tracking map so downstream handlers get the correct cwd.
 */
function resolvePartialSessionId(partial: string): { id: string } | { error: Response } {
  // Exact match in memory — fast path
  if (sessionTrackingMap.has(partial)) return { id: partial };

  const allSessions = collectAllSessionIds();

  // Exact match across all sources
  if (allSessions.has(partial)) {
    ensureTracked(partial, allSessions);
    return { id: partial };
  }

  // Prefix match
  const matches = [...allSessions.keys()].filter(id => id.startsWith(partial));
  if (matches.length === 1) {
    const id = matches[0]!;
    ensureTracked(id, allSessions);
    return { id };
  }
  if (matches.length > 1) {
    return {
      error: {
        ok: false,
        error: errAmbiguous('ambiguous_session', {
          message: `Ambiguous session prefix "${partial}" matches ${matches.length} sessions`,
          received: partial,
          candidates: matches,
        }),
      },
    };
  }

  // No match — let downstream handlers produce their own errors
  return { id: partial };
}

/** If a session is not in the tracking map, hydrate it from the known cwd. */
function ensureTracked(id: string, idToCwd: Map<string, string>): void {
  if (sessionTrackingMap.has(id)) return;
  const cwd = idToCwd.get(id);
  if (cwd) {
    sessionTrackingMap.set(id, { cwd, messageCounter: 0 });
  }
}

async function handleRequest(req: Request): Promise<Response> {
  try {
    // Validate session IDs to prevent path traversal
    if ('sessionId' in req && req.sessionId) {
      if (!validateSessionId(req.sessionId)) {
        return {
          ok: false,
          error: errUsage('invalid_session_id', {
            message: 'Invalid session ID: must contain only alphanumeric characters, hyphens, and underscores',
            received: req.sessionId,
          }),
        };
      }
      const resolved = resolvePartialSessionId(req.sessionId);
      if ('error' in resolved) return resolved.error;
      (req as Record<string, unknown>).sessionId = resolved.id;
    }

    switch (req.type) {
      case 'start': {
        const session = await sessionManager.startSession(req.task, req.cwd, req.context, req.name, req.effort);
        sessionTrackingMap.set(session.id, {
          cwd: req.cwd,
          tmuxSession: session.tmuxSessionName,
          windowId: session.tmuxWindowId,
          tmuxSessionId: session.tmuxSessionId,
          messageCounter: 0,
          name: session.name,
        });
        persistSessionRegistry();
        return { ok: true, data: { sessionId: session.id, tmuxSessionName: session.tmuxSessionName } };
      }

      case 'clone': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        const result = await sessionManager.cloneSession(
          req.sessionId, tracking.cwd, req.goal, req.context, req.name, req.strategy
        );
        sessionTrackingMap.set(result.id, {
          cwd: tracking.cwd,
          tmuxSession: result.tmuxSessionName,
          windowId: result.tmuxWindowId,
          tmuxSessionId: result.tmuxSessionId,
          messageCounter: 0,
        });
        persistSessionRegistry();
        return { ok: true, data: { sessionId: result.id, tmuxSessionName: result.tmuxSessionName } };
      }

      case 'spawn': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        // Validate repo name to prevent path traversal from IPC clients bypassing CLI
        if (req.repo && req.repo !== '.' && !validateRepoName(req.repo)) {
          return {
            ok: false,
            error: errUsage('invalid_repo_name', {
              message: 'Invalid repo name: must be a simple directory name without path separators or ".."',
              received: req.repo,
            }),
          };
        }
        const result = await sessionManager.handleSpawn(req.sessionId, tracking.cwd, req.agentType, req.name, req.instruction, req.repo);
        return { ok: true, data: { agentId: result.agentId } };
      }

      case 'submit': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        if (!tracking.windowId) return {
          ok: false,
          error: errNotFound('no_tmux_window', {
            message: `No tmux window found for session: ${req.sessionId}`,
            received: req.sessionId,
          }),
        };
        await sessionManager.handleSubmit(tracking.cwd, req.sessionId, req.agentId, req.report, tracking.windowId);
        return { ok: true };
      }

      case 'report': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        await sessionManager.handleReport(tracking.cwd, req.sessionId, req.agentId, req.content);
        return { ok: true };
      }

      case 'yield': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        await sessionManager.handleYield(req.sessionId, tracking.cwd, req.nextPrompt, req.mode);
        return { ok: true };
      }

      case 'await': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        const result = await agent.handleAwait(tracking.cwd, req.sessionId, req.agentId);
        if (!result) return {
          ok: false,
          error: errNotFound('unknown_agent', {
            message: `Unknown agent: ${req.agentId} in session ${req.sessionId}`,
            received: req.agentId,
          }),
        };
        return {
          ok: true,
          data: {
            status: result.status,
            reportPath: result.reportPath,
            agentName: result.agentName,
            agentType: result.agentType,
          },
        };
      }

      case 'complete': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        await sessionManager.handleComplete(req.sessionId, tracking.cwd, req.report);
        return { ok: true };
      }

      case 'continue': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        await sessionManager.handleContinue(req.sessionId, tracking.cwd);
        return { ok: true };
      }

      case 'status': {
        let sessionId = req.sessionId;

        // If no session ID provided, find the most recent active/paused session for this cwd
        if (!sessionId && req.cwd) {
          const sessions = sessionManager.listSessions(req.cwd);
          const active = sessions.find(s => s.status === 'active') ?? sessions.find(s => s.status === 'paused');
          if (active) sessionId = active.id;
        }

        if (sessionId) {
          const cwd = sessionTrackingMap.get(sessionId)?.cwd ?? req.cwd;
          if (!cwd) return unknownSessionError(sessionId);
          const session = sessionManager.getSessionStatus(cwd, sessionId);
          // Overlay live in-memory timer values for real-time accuracy
          const timers = getActiveTimers(sessionId);
          if (timers) {
            session.activeMs = timers.sessionMs;
            for (const agent of session.agents) {
              const agentMs = timers.agentMs.get(agent.id);
              if (agentMs != null) agent.activeMs = agentMs;
            }
            for (const cycle of session.orchestratorCycles) {
              const cycleMs = timers.cycleMs.get(cycle.cycle);
              if (cycleMs != null) cycle.activeMs = cycleMs;
            }
          }
          return { ok: true, data: { session: session as unknown as Record<string, unknown> } };
        }
        return { ok: true, data: { message: 'daemon running' } };
      }

      case 'list': {
        const allSessions: Array<Record<string, unknown>> = [];
        // Overlay live in-memory timer values so callers see real-time activeMs
        // for the running session without waiting for a persistence flush.
        const overlayLiveTimers = (s: { id: string; activeMs: number }) => {
          const timers = getActiveTimers(s.id);
          if (timers) s.activeMs = timers.sessionMs;
        };
        if (req.all) {
          // List sessions across all known cwds
          const seenCwds = new Set<string>();
          for (const tracking of sessionTrackingMap.values()) {
            if (seenCwds.has(tracking.cwd)) continue;
            seenCwds.add(tracking.cwd);
            const sessions = sessionManager.listSessions(tracking.cwd);
            sessions.forEach(overlayLiveTimers);
            allSessions.push(...sessions.map(s => ({ ...s, cwd: tracking.cwd } as unknown as Record<string, unknown>)));
          }
        } else {
          // List sessions for the requesting cwd only
          const sessions = sessionManager.listSessions(req.cwd);
          sessions.forEach(overlayLiveTimers);
          allSessions.push(...sessions.map(s => ({ ...s, cwd: req.cwd } as unknown as Record<string, unknown>)));
          // Count total across all cwds for the hint. Use the cheap dir-scan
          // counter — loading every state.json across every tracked cwd just
          // to take `.length` was a multi-second cold-cache blocker.
          let totalCount = allSessions.length;
          const seenCwds = new Set<string>([req.cwd]);
          for (const tracking of sessionTrackingMap.values()) {
            if (seenCwds.has(tracking.cwd)) continue;
            seenCwds.add(tracking.cwd);
            totalCount += sessionManager.countSessions(tracking.cwd);
          }
          if (totalCount > allSessions.length) {
            return { ok: true, data: { sessions: allSessions, totalCount, filtered: true } };
          }
        }
        return { ok: true, data: { sessions: allSessions } };
      }

      case 'resume': {
        let tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) {
          // Session not in memory — try to recover from disk using the cwd provided by CLI
          const stateFile = `${req.cwd}/.sisyphus/sessions/${req.sessionId}/state.json`;
          if (existsSync(stateFile)) {
            tracking = { cwd: req.cwd, messageCounter: 0 };
            sessionTrackingMap.set(req.sessionId, tracking);
            persistSessionRegistry();
          } else {
            return {
            ok: false,
            error: errNotFound('unknown_session', {
              message: `Unknown session: ${req.sessionId}. No state.json found at ${stateFile}. Run \`sis session inspect list --all\` to see available sessions.`,
              received: req.sessionId,
              next: 'sis session inspect list --all',
            }),
          };
          }
        }
        const session = await sessionManager.resumeSession(req.sessionId, tracking.cwd, req.message);
        if (session.tmuxSessionName) tracking.tmuxSession = session.tmuxSessionName;
        if (session.tmuxWindowId) tracking.windowId = session.tmuxWindowId;
        return { ok: true, data: { sessionId: session.id, status: session.status, tmuxSessionName: session.tmuxSessionName } };
      }

      case 'clear-orphan': {
        // Clears the sticky orphan flag and resolves any pending orchestrator orphan asks
        // without spawning anything. For when the user has handled the situation manually
        // (e.g. orchestrator pane is actually still alive) and just wants the badge gone.
        // If the orchestrator pane is detected alive, also flip status active.
        const stateFile = `${req.cwd}/.sisyphus/sessions/${req.sessionId}/state.json`;
        if (!existsSync(stateFile)) {
          return {
            ok: false,
            error: errNotFound('unknown_session', {
              message: `Unknown session: ${req.sessionId}. No state.json at ${stateFile}.`,
              received: req.sessionId,
              next: 'sis session inspect list --all',
            }),
          };
        }
        await Promise.all([
          state.clearSessionOrphan(req.cwd, req.sessionId),
          resolveOrchestratorOrphanAsks(req.cwd, req.sessionId, 'dismiss'),
        ]);
        // Re-attach if a live orchestrator pane is detected — flip paused→active so the
        // session reflects reality without spawning a new orchestrator.
        let reattached = false;
        try {
          const session = state.getSession(req.cwd, req.sessionId);
          const orchPaneId = orchestrator.getOrchestratorPaneId(req.sessionId);
          if (orchPaneId && session.tmuxWindowId) {
            const livePanes = tmux.listPanes(session.tmuxWindowId);
            const alive = livePanes.some(p => p.paneId === orchPaneId);
            if (alive && session.status === 'paused') {
              await state.updateSessionStatus(req.cwd, req.sessionId, 'active');
              reattached = true;
            }
          }
        } catch { /* best-effort */ }
        try { recomputeDots(); } catch { /* best-effort */ }
        return { ok: true, data: { reattached } };
      }

      case 'kill': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        const killedAgents = await sessionManager.handleKill(req.sessionId, tracking.cwd);
        sessionTrackingMap.delete(req.sessionId);
        persistSessionRegistry();
        return { ok: true, data: { killedAgents, sessionId: req.sessionId } };
      }

      case 'kill-agent': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        await sessionManager.handleKillAgent(req.sessionId, tracking.cwd, req.agentId);
        return { ok: true, data: { agentId: req.agentId } };
      }

      case 'restart-agent': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        await sessionManager.handleRestartAgent(req.sessionId, tracking.cwd, req.agentId);
        return { ok: true, data: { agentId: req.agentId } };
      }

      case 'rollback': {
        let tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) {
          const stateFile = `${req.cwd}/.sisyphus/sessions/${req.sessionId}/state.json`;
          if (existsSync(stateFile)) {
            registerSessionCwd(req.sessionId, req.cwd);
            tracking = sessionTrackingMap.get(req.sessionId)!;
          } else {
            return unknownSessionError(req.sessionId);
          }
        }
        const result = await sessionManager.handleRollback(req.sessionId, tracking.cwd, req.toCycle);
        return { ok: true, data: result as unknown as Record<string, unknown> };
      }

      case 'reconnect': {
        let tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) {
          const stateFile = `${req.cwd}/.sisyphus/sessions/${req.sessionId}/state.json`;
          if (existsSync(stateFile)) {
            registerSessionCwd(req.sessionId, req.cwd);
            tracking = sessionTrackingMap.get(req.sessionId)!;
          } else {
            return unknownSessionError(req.sessionId);
          }
        }
        const result = await sessionManager.reconnectSession(req.sessionId, tracking.cwd);
        tracking.tmuxSession = result.tmuxSessionName;
        tracking.windowId = result.tmuxWindowId;
        tracking.tmuxSessionId = result.tmuxSessionId;
        return { ok: true, data: result };
      }

      case 'reopen-window': {
        let tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) {
          const stateFile = `${req.cwd}/.sisyphus/sessions/${req.sessionId}/state.json`;
          if (existsSync(stateFile)) {
            tracking = { cwd: req.cwd, messageCounter: 0 };
            sessionTrackingMap.set(req.sessionId, tracking);
            persistSessionRegistry();
          } else {
            return unknownSessionError(req.sessionId);
          }
        }
        const result = await sessionManager.reopenWindow(req.sessionId, tracking.cwd);
        tracking.tmuxSession = result.tmuxSessionName;
        tracking.windowId = result.tmuxWindowId;
        return { ok: true, data: result };
      }

      case 'delete': {
        // Kill session if active (best-effort)
        const activeTracking = sessionTrackingMap.get(req.sessionId);
        if (activeTracking) {
          try {
            await sessionManager.handleKill(req.sessionId, activeTracking.cwd);
          } catch {
            // May already be dead — continue
          }
          sessionTrackingMap.delete(req.sessionId);
          persistSessionRegistry();
        }
        // Remove session directory
        const { sessionDir } = await import('../shared/paths.js');
        rmSync(sessionDir(req.cwd, req.sessionId), { recursive: true, force: true });
        return { ok: true };
      }

      case 'pane-exited': {
        const entry = lookupPane(req.paneId);
        if (!entry) return { ok: true }; // Already handled or unknown
        const tracking = sessionTrackingMap.get(entry.sessionId);
        if (!tracking) {
          unregisterPane(req.paneId);
          return { ok: true };
        }
        unregisterPane(req.paneId);
        await sessionManager.handlePaneExited(req.paneId, tracking.cwd, entry.sessionId, entry.role, entry.agentId);
        return { ok: true };
      }

      case 'update-task': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        await state.updateTask(tracking.cwd, req.sessionId, req.task);
        return { ok: true };
      }

      case 'set-effort': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        await state.updateSession(tracking.cwd, req.sessionId, { effort: req.effort });
        return { ok: true };
      }

      case 'set-dangerous-mode': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        await state.updateSession(tracking.cwd, req.sessionId, { dangerousMode: req.enabled });
        let flushed = 0;
        if (req.enabled) {
          for (const askId of listAsks(tracking.cwd, req.sessionId)) {
            const meta = readMeta(tracking.cwd, req.sessionId, askId);
            if (!meta) continue;
            if (meta.status !== 'pending' && meta.status !== 'in-progress') continue;
            if (meta.orphaned) continue;
            const ok = await autoResolveAsk(tracking.cwd, req.sessionId, askId);
            if (ok) flushed += 1;
          }
        }
        return { ok: true, data: { enabled: req.enabled, flushed } };
      }

      case 'set-upload-status': {
        // File-backed lookup — manual upload works on completed sessions which aren't in sessionTrackingMap.
        // existsSync (not try/catch around getSession) closes the TOCTOU window: file-deletion mid-update
        // surfaces as a clear updateSession error rather than a swallowed JSON-parse / permission failure.
        // Path style mirrors the existing file-backed handlers — literal template, not `statePath()`.
        const stateFile = `${req.cwd}/.sisyphus/sessions/${req.sessionId}/state.json`;
        if (!existsSync(stateFile)) {
          return unknownSessionError(req.sessionId);
        }
        try {
          await state.updateSession(req.cwd, req.sessionId, {
            uploadStatus: req.status,
            uploadKey: req.storageKey,
            uploadError: req.error,
            ...(req.status === 'uploaded' && { uploadCompletedAt: new Date().toISOString() }),
          });
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            error: errPermanent('rpc_failed', {
              message: `Failed to persist upload status: ${err instanceof Error ? err.message : String(err)}`,
            }),
          };
        }
      }

      case 'message': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);

        tracking.messageCounter += 1;
        const id = `msg-${String(tracking.messageCounter).padStart(3, '0')}`;

        const source: MessageSource = req.source ?? { type: 'user' };
        const summary = req.content.length > 200 ? req.content.slice(0, 200) + '...' : req.content;

        if (req.agentId) {
          // Route to per-agent inbox: messages/<agentId>/<id>.md
          const dir = join(messagesDir(tracking.cwd, req.sessionId), req.agentId);
          mkdirSync(dir, { recursive: true });
          const filePath = join(dir, `${id}.md`);
          writeFileSync(filePath, req.content, 'utf-8');
          emitHistoryEvent(req.sessionId, 'message', { source: source.type, agentId: req.agentId, content: req.content });
          return { ok: true };
        }

        let filePath: string | undefined;
        if (req.content.length > 200) {
          const dir = messagesDir(tracking.cwd, req.sessionId);
          mkdirSync(dir, { recursive: true });
          filePath = join(dir, `${id}.md`);
          writeFileSync(filePath, req.content, 'utf-8');
        }

        await state.appendMessage(tracking.cwd, req.sessionId, {
          id,
          source,
          content: req.content,
          summary,
          ...(filePath ? { filePath } : {}),
          timestamp: new Date().toISOString(),
        });
        emitHistoryEvent(req.sessionId, 'message', { source: source.type, content: req.content });
        return { ok: true };
      }

      case 'tell': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        const session = state.getSession(tracking.cwd, req.sessionId);

        let paneId: string | undefined;
        let targetLabel: string;
        if (req.target.kind === 'orchestrator') {
          // Most-recent live cycle (no completedAt). Falls back to the trailing cycle's
          // paneId if all are completed but the pane is somehow still around.
          const liveCycle = [...session.orchestratorCycles].reverse().find(c => !c.completedAt);
          paneId = liveCycle?.paneId ?? session.orchestratorCycles.at(-1)?.paneId;
          targetLabel = 'orchestrator';
          if (!paneId) return {
            ok: false,
            error: errNotFound('no_orchestrator_pane', {
              message: 'No orchestrator pane found for this session',
              received: req.sessionId,
            }),
          };
        } else {
          const agentId = req.target.agentId;
          const ag = session.agents.find(a => a.id === agentId);
          if (!ag) return {
            ok: false,
            error: errNotFound('unknown_agent', {
              message: `Unknown agent: ${agentId} in session ${req.sessionId}`,
              received: agentId,
            }),
          };
          if (ag.status !== 'running') {
            return {
              ok: false,
              error: errConflict('agent_not_running', {
                message: `Agent ${agentId} is ${ag.status}, not running — cannot tell`,
                received: ag.status,
                expected: 'running',
              }),
            };
          }
          paneId = ag.paneId;
          targetLabel = agentId;
        }

        try {
          tmux.pasteToPane(paneId, req.text, req.submit);
        } catch (err) {
          return {
            ok: false,
            error: errPermanent('rpc_failed', {
              message: err instanceof Error ? err.message : String(err),
            }),
          };
        }

        // Record in session.messages for debuggability — the typed prompt won't otherwise
        // appear in any sisyphus log. Reuse the same id counter as `message`.
        tracking.messageCounter += 1;
        const id = `tell-${String(tracking.messageCounter).padStart(3, '0')}`;
        const source: MessageSource = req.source ?? { type: 'user' };
        const summary = req.text.length > 200 ? req.text.slice(0, 200) + '...' : req.text;
        await state.appendMessage(tracking.cwd, req.sessionId, {
          id,
          source,
          content: req.text,
          summary,
          timestamp: new Date().toISOString(),
        });
        emitHistoryEvent(req.sessionId, 'message', {
          source: source.type,
          delivery: 'tell',
          target: targetLabel,
          submit: req.submit,
          content: req.text,
        });
        return { ok: true, data: { paneId, target: targetLabel } };
      }

      case 'companion': {
        const companion = loadCompanion();
        if (req.name !== undefined) {
          companion.name = req.name;
          saveCompanion(companion);
        }
        return { ok: true, data: companion as unknown as Record<string, unknown> };
      }

      case 'register-segment': {
        if (!compositor) return { ok: false, error: errTransient('compositor_uninit', { message: 'Compositor not initialized' }) };
        compositor.registerExternal({
          id: req.id,
          side: req.side,
          priority: req.priority,
          bg: req.bg,
          content: req.content,
        });
        return { ok: true };
      }

      case 'update-segment': {
        if (!compositor) return { ok: false, error: errTransient('compositor_uninit', { message: 'Compositor not initialized' }) };
        try {
          compositor.updateExternal(req.id, req.content);
          return { ok: true };
        } catch (e) {
          return {
            ok: false,
            error: errPermanent('rpc_failed', { message: (e as Error).message }),
          };
        }
      }

      case 'unregister-segment': {
        if (!compositor) return { ok: false, error: errTransient('compositor_uninit', { message: 'Compositor not initialized' }) };
        compositor.unregisterExternal(req.id);
        return { ok: true };
      }

      case 'ask-generate-visual': {
        const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
        if (!ID_RE.test(req.askId)) return {
          ok: false,
          error: errUsage('invalid_ask_id', { message: `Invalid askId: ${req.askId}`, received: req.askId }),
        };
        if (!ID_RE.test(req.qid)) return {
          ok: false,
          error: errUsage('invalid_qid', { message: `Invalid qid: ${req.qid}`, received: req.qid }),
        };
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        if (!tracking.cwd) return {
          ok: false,
          error: errUsage('no_cwd_registered', {
            message: `No cwd registered for session: ${req.sessionId}`,
            received: req.sessionId,
          }),
        };
        const result = await generateVisualForQuestion({
          cwd: tracking.cwd,
          sessionId: req.sessionId,
          askId: req.askId,
          qid: req.qid,
          cols: req.cols,
          force: req.force,
        });
        if (result.ok) {
          return { ok: true, data: { markdownPath: result.markdownPath, ansiPath: result.ansiPath, turns: result.turns } };
        }
        return {
          ok: false,
          error: errPermanent('rpc_failed', { message: result.error }),
        };
      }

      case 'inbox-list': {
        const askDirs: string[] = [];
        const reviewItems: InboxItem[] = [];
        for (const [sessionId, tracking] of sessionTrackingMap) {
          if (!tracking.cwd) continue;
          // Scope to the requesting dashboard's cwd — only this directory's
          // sessions, never the whole fleet. Mirrors the string-identity cwd
          // assumption the `list` handler relies on (seenCwds.has(req.cwd)).
          if (tracking.cwd !== req.cwd) continue;
          askDirs.push(askDir(tracking.cwd, sessionId));
          reviewItems.push(...listReviewInboxItems(tracking.cwd, sessionId));
        }
        let items: InboxItem[];
        try {
          items = scanInbox(askDirs);
        } catch (err) {
          console.warn('[sisyphus] inbox-list: scanInbox failed:', err);
          items = [];
        }
        // scanInbox keys on deck.json and skips reviews (review.json). Merge the
        // review asks in and re-sort oldest-first to match scanInbox ordering.
        if (reviewItems.length > 0) {
          items = items.concat(reviewItems).sort((a, b) =>
            a.blockedSince < b.blockedSince ? -1 : a.blockedSince > b.blockedSince ? 1 : 0,
          );
        }
        // Attach sessionName from sessionTrackingMap by deriving sessionId from item.dir
        // dir: <cwd>/.sisyphus/sessions/<sessionId>/context/ask/<askId>
        const itemsWithName = items.map(item => {
          const sessionId = basename(dirname(dirname(dirname(item.dir))));
          const tracking = sessionTrackingMap.get(sessionId);
          const sessionName = tracking?.name ?? item.source?.sessionName;
          return { ...item, sessionName };
        });
        return { ok: true, data: { items: itemsWithName as unknown as Record<string, unknown> } };
      }

      case 'focus-set': {
        const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
        if (!ID_RE.test(req.askId)) return {
          ok: false,
          error: errUsage('invalid_ask_id', { message: `Invalid askId: ${req.askId}`, received: req.askId }),
        };
        // sessionId already validated + partial-resolved by the top-level guard.
        pendingFocus = { cwd: req.cwd, sessionId: req.sessionId, askId: req.askId, requestedAt: Date.now() };
        return { ok: true };
      }

      case 'focus-get': {
        // Consume-and-clear so exactly one dashboard acts on a given request.
        if (pendingFocus && pendingFocus.cwd === req.cwd) {
          const captured = pendingFocus;
          pendingFocus = null;
          if (Date.now() - captured.requestedAt > FOCUS_TTL_MS) {
            return { ok: true, data: { focus: null } };
          }
          return { ok: true, data: { focus: captured as unknown as Record<string, unknown> } };
        }
        return { ok: true, data: { focus: null } };
      }

      case 'cloud-handoff': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);

        const session = state.getSession(tracking.cwd, req.sessionId);
        if (session.handoff?.sentAt) {
          const where = session.handoff.target ? `${session.handoff.target.provider}:${session.handoff.target.repo}` : 'cloud';
          return {
            ok: false,
            error: errConflict('already_on_cloud', {
              message: `Session ${req.sessionId} is already on ${where}. Use \`sis cloud handoff pull\` first.`,
              received: req.sessionId,
              next: 'sis cloud handoff pull',
            }),
          };
        }
        if (session.handoff && !req.force) {
          return {
            ok: false,
            error: errConflict('handoff_already_queued', {
              message: `Session ${req.sessionId} already has a queued handoff. Pass --force to override or run \`sis cloud handoff cancel ${req.sessionId}\` to clear.`,
              received: req.sessionId,
            }),
          };
        }

        const { resolveProvider, defaultRepoName, checkRepoName, triggerForceHandoff } = await import('./cloud-handoff.js');
        let provider: string;
        try {
          provider = resolveProvider(req.provider);
        } catch (err) {
          return {
            ok: false,
            error: errPermanent('rpc_failed', { message: err instanceof Error ? err.message : String(err) }),
          };
        }
        const repo = req.repo ?? defaultRepoName(tracking.cwd);
        try {
          checkRepoName(repo);
        } catch (err) {
          return {
            ok: false,
            error: errUsage('invalid_repo_name', {
              message: err instanceof Error ? err.message : String(err),
              received: repo,
            }),
          };
        }

        await state.updateSession(tracking.cwd, req.sessionId, {
          handoff: {
            target: { provider, repo },
            queuedAt: new Date().toISOString(),
            force: req.force === true,
          },
        });

        if (req.force === true) {
          // Fire-and-forget; CLI may poll session state for sentAt/lastError.
          void triggerForceHandoff(req.sessionId, tracking.cwd);
          return { ok: true, data: { queued: true, force: true, provider, repo } };
        }
        return { ok: true, data: { queued: true, force: false, provider, repo } };
      }

      case 'cloud-handoff-cancel': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        const session = state.getSession(tracking.cwd, req.sessionId);
        if (!session.handoff) {
          return {
            ok: false,
            error: errNotFound('no_queued_handoff', {
              message: `Session ${req.sessionId} has no queued handoff.`,
              received: req.sessionId,
            }),
          };
        }
        if (session.handoff.sentAt) {
          return {
            ok: false,
            error: errConflict('already_shipped', {
              message: `Session ${req.sessionId} has already shipped to cloud — use \`sis cloud handoff pull\` to bring it back.`,
              received: req.sessionId,
              next: 'sis cloud handoff pull',
            }),
          };
        }
        await state.updateSession(tracking.cwd, req.sessionId, { handoff: undefined });
        return { ok: true, data: { cancelled: true } };
      }

      case 'cloud-reclaim-finalize': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        const session = state.getSession(tracking.cwd, req.sessionId);
        if (!session.handoff?.sentAt) {
          return {
            ok: false,
            error: errConflict('not_on_cloud', {
              message: `Session ${req.sessionId} was never sent to cloud; nothing to reclaim.`,
              received: req.sessionId,
            }),
          };
        }
        await state.updateSession(tracking.cwd, req.sessionId, {
          handoff: { ...session.handoff, reclaimedAt: new Date().toISOString() },
        });
        return { ok: true };
      }

      case 'admin-quiesce': {
        const tracking = sessionTrackingMap.get(req.sessionId);
        if (!tracking) return unknownSessionError(req.sessionId);
        const session = state.getSession(tracking.cwd, req.sessionId);
        if (session.handoff?.sentAt) {
          return {
            ok: false,
            error: errConflict('already_on_cloud', {
              message: `Session ${req.sessionId} already lives on cloud; nothing to quiesce locally.`,
              received: req.sessionId,
              next: 'sis cloud handoff pull',
            }),
          };
        }

        await state.updateSession(tracking.cwd, req.sessionId, {
          handoff: {
            queuedAt: new Date().toISOString(),
            force: req.force === true,
          },
        });

        if (req.force === true) {
          const { performHandoff } = await import('./cloud-handoff.js');
          void performHandoff(req.sessionId, tracking.cwd);
          return { ok: true, data: { queued: true, force: true } };
        }
        return { ok: true, data: { queued: true, force: false } };
      }

      default:
        return {
          ok: false,
          error: errUsage('unknown_request_type', {
            message: `Unknown request type: ${(req as Record<string, unknown>).type}`,
            received: (req as Record<string, unknown>).type,
          }),
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: errPermanent('internal_error', { message }) };
  }
}

export function startServer(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const sock = socketPath();

    if (existsSync(sock)) {
      unlinkSync(sock);
    }

    server = createServer((conn) => {
      let buffer = '';

      conn.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) continue;
          let req: Request;
          try {
            req = JSON.parse(line) as Request;
          } catch {
            conn.write(JSON.stringify({ ok: false, error: errUsage('invalid_json', { message: 'Invalid JSON' }) }) + '\n');
            continue;
          }

          handleRequest(req).then((res) => {
            if (!conn.destroyed) {
              conn.write(JSON.stringify(res) + '\n');
            }
          }).catch((err) => {
            console.warn('[sisyphus] Unhandled request error:', err instanceof Error ? err.message : err);
            if (!conn.destroyed) {
              conn.write(JSON.stringify({ ok: false, error: errPermanent('internal_error', { message: 'Internal server error' }) }) + '\n');
            }
          });
        }
      });

      conn.on('error', (err) => {
        // Suppress EPIPE — client disconnected before response was written
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
          console.error('[sisyphus] Connection error:', err.message);
        }
      });
    });

    server.on('error', reject);

    server.listen(sock, () => {
      // Restrict socket permissions to owner-only (prevent other users on multi-user systems)
      try {
        chmodSync(sock, 0o600);
      } catch { /* best-effort — some platforms may not support this */ }
      console.log(`[sisyphus] Daemon listening on ${sock}`);
      resolve(server!);
    });
  });
}

export function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => {
      const sock = socketPath();
      if (existsSync(sock)) {
        unlinkSync(sock);
      }
      server = null;
      resolve();
    });
  });
}
