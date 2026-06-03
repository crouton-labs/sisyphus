import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { askIdFromDir } from '../shared/inbox-types.js';

import {
  type AppState,
  type SessionSummary,
  type CycleLog,
  setRenderFunction,
  requestRender,
  stabilizeCursor,
  autoExpandCycle,
  notify,
} from './state.js';
import { handleKeypress, type InputActions } from './input.js';
import { createFrameBuffer, flushFrame, writeCenter, copyRows } from './render.js';
import { writeToStdout, startKeypressListener, onResize } from './terminal.js';
import { buildTree } from './lib/tree.js';
import { precomputePrefixes } from './lib/tree-render.js';
import { resolveReports } from './lib/reports.js';
import { send, inboxList, focusGet } from './lib/client.js';
import {
  listAllWindowIds,
  openEditorPopup,
  editInPopup,
  openCompanionPane,
  openClaudeResumePopup,
  openClaudeResumeSession,
  selectWindow,
  selectPane,
  switchToSession,
  paneExists,
  openLogPopup,
  openShellPopup,
  openInFileManager,
  promptInPopup,
} from './lib/tmux.js';
import { copyToClipboard as sharedCopyToClipboard } from '../shared/clipboard.js';
import { buildSessionContext } from './lib/context.js';
import { renderTreePanel } from './panels/tree.js';
import { renderDetailRows, renderDigestRows, type DetailContext } from './panels/detail.js';
import { renderStackedDetailRows } from './panels/stacked-detail.js';
import { renderStatusLine } from './panels/bottom.js';
import { renderInboxDeckRows } from './panels/inbox-deck.js';
import { renderSubmenuOverlay, renderHelpOverlay, renderCompanionOverlay, renderCompanionDebugOverlay } from './panels/overlays.js';
import { KEYMAP, MENU_FOR_MODE } from '../shared/keymap.js';
import { companionPath } from '../shared/paths.js';
import type { CompanionState } from '../shared/companion-types.js';
import { normalizeCompanion } from '../shared/companion-normalize.js';
import { composeViaPopup, ensureSisyphusInitLua } from './lib/popup-compose.js';
import { loadConfig } from '../shared/config.js';
import { roadmapPath, goalPath, strategyPath, logsDir, contextDir, digestPath } from '../shared/paths.js';
import { statusIndicator, formatDuration, statusColor, agentStatusIcon, agentDisplayName, truncate, ansiColor, ansiDim, ansiBold } from './lib/format.js';
import type { TreeNode } from './types/tree.js';
import type { Agent, Session, StatusDigest } from '../shared/types.js';

// ── Module-level companion cache (reloads on mtime change, ~poll interval) ────

let _cachedCompanion: CompanionState | null = null;
let _companionMtime = 0;

function getCompanion(): CompanionState | null {
  try {
    const { mtimeMs } = statSync(companionPath());
    if (_cachedCompanion && mtimeMs === _companionMtime) return _cachedCompanion;
    _companionMtime = mtimeMs;
    _cachedCompanion = normalizeCompanion(JSON.parse(readFileSync(companionPath(), 'utf-8')) as CompanionState);
    return _cachedCompanion;
  } catch {
    return _cachedCompanion;
  }
}

// ── Module-level cache for latest rendered nodes (needed by keypress handler) ─

let latestNodes: TreeNode[] = [];

// ── Module-level cache for context file content ───────────────────────────────

let cachedContextFilePath: string | null = null;
let cachedContextFileContent: string | null = null;

// ── Previous frame for diffing ────────────────────────────────────────────────

let prevFrame: string[] = [];
// Tracks last known resolution state so render() can reset prevFrame on transition
let prevResolutionActive = false;
// Tracks whether the cursor was on needs-you-virtual last render, so leaving it unmounts the inline deck
let prevCursorOnNeedsYou = false;

// ── Panel dirty tracking ─────────────────────────────────────────────────────
// Tracks the inputs that affect each panel. When only the scroll offset changes,
// we can skip re-rendering panels whose inputs haven't changed.

let prevTreeInputs = '';
let prevBottomInputs = '';

// ── Dynamic tree width ──────────────────────────────────────────────────────
// Scale tree panel with terminal width so session names aren't aggressively
// truncated on wide terminals. Min 36 (fits 80-col), max 70.

function computeTreeWidth(cols: number): number {
  return Math.min(70, Math.max(36, Math.floor(cols * 0.25)));
}
let prevOverlayMode = '';
let cachedTreeRows: string[] = [];

// ── Cycle logs cache (avoids re-reading unchanged files every poll) ───────────

let cachedLogSessionId: string | null = null;
let cachedLogFiles: Map<string, { mtime: number; cycle: number; content: string }> = new Map();

// ── Deferred detail-read pass tracking ───────────────────────────────────────
// Module-level so the stale-pass guard and selection tracker survive across
// poll() invocations. `scheduleDetailReads` itself is nested in startApp.

let detailPassToken = 0;
let lastPolledDetailSessionId: string | null | undefined = undefined;

// ── Resolution frame renderer (3e) ───────────────────────────────────────────

function renderResolutionFrame(buf: import('./render.js').FrameBuffer, state: AppState): void {
  const handle = state.resolutionHandle!;
  const info = handle.getHeaderInfo();
  const now = new Date().toISOString();

  // Build header strip (row 0)
  // Format: [esc] back   ●●●○○ N of M   sessionName/title   ⏱ blocked Xm
  const escPart = ansiDim(' [esc] back');

  // Queue dots (max 12)
  const dotLimit = 12;
  const qLen = info.queueLength;
  let dotsPart = '';
  if (qLen <= dotLimit) {
    for (let i = 0; i < qLen; i++) {
      dotsPart += i < info.currentIndex ? '●' : '○';
    }
  } else {
    for (let i = 0; i < dotLimit; i++) {
      dotsPart += i < info.currentIndex ? '●' : '○';
    }
    const trailing = qLen - dotLimit;
    dotsPart += ` +${trailing}`;
  }
  const posLabel = ` ${info.currentIndex + 1} of ${info.queueLength}`;

  const sourcePart = info.sessionName
    ? ansiBold(info.sessionName) + (info.askTitle ? `/${truncate(info.askTitle, 32)}` : '')
    : '';

  const blocked = formatDuration(info.blockedSince, now);
  const timePart = ansiDim(`⏱ blocked ${blocked}`);

  const parts = [escPart, '   ', dotsPart, posLabel, '   ', sourcePart, '   ', timePart];
  let header = parts.join('');
  // Truncate if over width (drop source first, then truncate)
  if (header.replace(/\x1b\[[0-9;]*m/g, '').length > state.cols) {
    const shortened = [escPart, '   ', dotsPart, posLabel, '   ', timePart].join('');
    header = shortened;
  }
  buf.lines[0] = header + ' '.repeat(Math.max(0, state.cols - header.replace(/\x1b\[[0-9;]*m/g, '').length));

  // Rows 1..h-1: humanloop body OR visual (v0 toggle)
  const qid = handle.getCurrentQid();
  const visualEntry = qid ? state.visuals.get(qid) : undefined;

  const bodyH = state.rows - 1;

  if (visualEntry?.visible && visualEntry.status === 'ready') {
    // v0 toggle: visual replaces humanloop body entirely
    const visualLines = visualEntry.content.split('\n');
    for (let i = 0; i < bodyH; i++) {
      buf.lines[i + 1] = i < visualLines.length ? visualLines[i]! : '';
    }
  } else {
    // Show humanloop content (with optional loading/error overlay on center row)
    const humanloopLines = handle.render();
    const midRow = Math.floor(bodyH / 2);
    for (let i = 0; i < bodyH; i++) {
      if (visualEntry?.visible && visualEntry.status === 'loading' && i === midRow) {
        const placeholderText = '[generating visual… ~30s]';
        const placeholder = ansiDim(placeholderText);
        const padL = Math.floor((state.cols - placeholderText.length) / 2);
        buf.lines[i + 1] = ' '.repeat(Math.max(0, padL)) + placeholder;
      } else if (visualEntry?.visible && visualEntry.status === 'error' && i === midRow) {
        const errText = visualEntry.error ? visualEntry.error : 'unknown';
        buf.lines[i + 1] = ansiColor(`[visual error: ${errText}]`, 'red') + ansiDim('  [R] retry');
      } else {
        buf.lines[i + 1] = i < humanloopLines.length ? humanloopLines[i]! : '';
      }
    }
  }
}

// ── Status header constants ──────────────────────────────────────────────────

const STATUS_ROW_COUNT = 2; // Fixed height for status header (avoids nvim resize on cursor change)

function buildStatusRows(
  cursorNode: TreeNode | undefined,
  session: Session | null,
  state: AppState,
): string[] {
  if (cursorNode?.type === 'needs-you-virtual') {
    const count = state.aggregateInbox.length;
    return [
      ' ' + ansiColor('⚑', 'red', true) + ' ' + ansiColor('Inbox', 'white', true),
      ' ' + ansiDim(`${count} pending ask${count !== 1 ? 's' : ''} in this project`),
    ];
  }

  if (cursorNode?.type === 'section') {
    const label = cursorNode.section === 'running' ? 'Running' : 'Done';
    return [ansiDim(` ${label} section`), ''];
  }

  if (!cursorNode || !session) {
    return [ansiDim(' No session selected'), ''];
  }

  const dur = formatDuration(session.createdAt, session.completedAt);
  const indicator = statusIndicator(session.status);
  const sColor = statusColor(session.status);
  const title = truncate(session.name ?? session.task, 40);

  switch (cursorNode.type) {
    case 'session': {
      return [
        ' ' + ansiColor(indicator, sColor, true) + ' ' + ansiColor(title, 'white', true),
        ' ' + ansiDim(`${session.status} · ${session.orchestratorCycles.length} cycles · ${session.agents.length} agents · ${dur}`),
      ];
    }
    case 'cycle': {
      const cycle = session.orchestratorCycles.find(c => c.cycle === cursorNode.cycleNumber);
      if (!cycle) return [' ' + ansiColor(title, 'white', true), ''];
      const cDur = cycle.completedAt ? formatDuration(cycle.timestamp, cycle.completedAt) : 'running';
      const cStatus = cycle.completedAt ? 'completed' : 'running';
      return [
        ' ' + ansiColor(indicator, sColor, true) + ' ' + ansiColor(title, 'white', true) + ansiDim(` · Cycle ${cycle.cycle}`),
        ' ' + ansiDim(`${cStatus} · ${cDur} · ${cycle.agentsSpawned.length} agents`),
      ];
    }
    case 'agent':
    case 'report': {
      const agentId = cursorNode.type === 'agent' ? cursorNode.agentId : cursorNode.agentId;
      const agent = session.agents.find(a => a.id === agentId);
      if (!agent) return [' ' + ansiColor(title, 'white', true), ''];
      const aIcon = agentStatusIcon(agent.status);
      const aDur = formatDuration(agent.spawnedAt, agent.completedAt);
      const aName = agentDisplayName(agent);
      return [
        ' ' + ansiColor(aIcon, statusColor(agent.status === 'running' ? 'active' : agent.status), true) + ' ' + ansiColor(`${agent.id} · ${aName}`, 'white', true),
        ' ' + ansiDim(`${agent.status} · ${agent.agentType || '—'} · ${aDur}`),
      ];
    }
    case 'context-file': {
      const name = cursorNode.filePath.split('/').pop() ?? cursorNode.filePath;
      return [
        ' ' + ansiColor('⊞', 'white') + ' ' + ansiColor(name, 'white', true),
        ' ' + ansiDim(`context file · ${session.status}`),
      ];
    }
    case 'messages':
    case 'message': {
      return [
        ' ' + ansiColor(indicator, sColor, true) + ' ' + ansiColor(title, 'white', true),
        ' ' + ansiDim(`${session.messages.length} messages`),
      ];
    }
    default: {
      return [
        ' ' + ansiColor(indicator, sColor, true) + ' ' + ansiColor(title, 'white', true),
        ' ' + ansiDim(`${session.status} · ${dur}`),
      ];
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getAgentForNode(node: TreeNode | undefined, agents: Agent[]): Agent | null {
  if (!node) return null;
  if (node.type === 'agent' || node.type === 'report') {
    return agents.find((a) => a.id === node.agentId) ?? null;
  }
  return null;
}

// ── startApp ──────────────────────────────────────────────────────────────────

export function startApp(state: AppState, cleanup: () => void): void {
  const config = loadConfig(state.cwd);

  // Materialize ~/.config/sisyphus/init.lua if missing (idempotent)
  ensureSisyphusInitLua();

  // Track selectedSessionId to detect changes across renders (for immediate poll)
  let prevSelectedSessionId: string | null | undefined = undefined;
  let debouncedPollTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Polling ─────────────────────────────────────────────────────────────────

  async function poll(): Promise<void> {
    try {
      let selectedSession: Session | null = null;
      let paneAlive = true;
      let contextFiles: string[] = [];

      const listPromise = send({ type: 'list', cwd: state.cwd });
      const statusPromise = state.selectedSessionId
        ? send({ type: 'status', sessionId: state.selectedSessionId, cwd: state.cwd })
        : null;
      const inboxPromise = inboxList(state.cwd);
      const focusPromise = focusGet(state.cwd);

      const [listRes, statusRes, aggregateInbox, focusReq] = await Promise.all([
        listPromise,
        statusPromise ?? Promise.resolve(null),
        inboxPromise,
        focusPromise,
      ]);
      state.aggregateInbox = aggregateInbox;

      if (focusReq !== null && !state.resolutionActive) {
        state.pendingFocus = { sessionId: focusReq.sessionId, askId: focusReq.askId, attempts: 0 };
        state.searchFilter = null;
      }

      const sessions: SessionSummary[] = listRes.ok
        ? ((listRes.data?.sessions as SessionSummary[] | undefined) ?? [])
        : [];

      // Skip expensive sync I/O when resolution mode is active — panels are hidden,
      // data won't be rendered, and blocking here delays keystroke rendering.
      if (!state.resolutionActive) {

      // Batch-check window existence in a single tmux call
      const aliveWindows = listAllWindowIds();
      for (const s of sessions) {
        if (s.status !== 'completed' && s.tmuxWindowId) {
          s.windowAlive = aliveWindows.has(s.tmuxWindowId);
        }
      }

      if (state.selectedSessionId) {
        if (statusRes?.ok) {
          selectedSession = (statusRes.data?.session as Session | undefined) ?? null;
        }

        // Use cached windowAlive from the session list scan above
        if (selectedSession?.tmuxWindowId) {
          const cached = sessions.find((s) => s.id === state.selectedSessionId);
          paneAlive = cached?.windowAlive ?? false;
        }

        // contextFiles feeds the tree (cacheKey + buildTree). Deferring it would
        // flicker the tree on every selection change, so it stays synchronous
        // and on the first-paint path. (Plan decision 1.)
        try {
          const cd = contextDir(state.cwd, state.selectedSessionId);
          if (existsSync(cd)) {
            const entries = readdirSync(cd, { withFileTypes: true })
              .filter((e) => !e.name.startsWith('.'));
            const flat: string[] = [];
            for (const e of entries) {
              if (e.isDirectory()) {
                try {
                  const sub = readdirSync(join(cd, e.name))
                    .filter((f) => !f.startsWith('.'))
                    .map((f) => `${e.name}/${f}`);
                  flat.push(...sub);
                } catch {
                  // subdir may be unreadable
                }
              } else {
                flat.push(e.name);
              }
            }
            contextFiles = flat.sort();
          }
        } catch {
          // context dir may not exist yet
        }
      }

      } // end !state.resolutionActive

      state.sessions = sessions;
      state.selectedSession = selectedSession;
      state.paneAlive = paneAlive;
      state.contextFiles = contextFiles;
      state.error = null;

      // Selection-change reset: drop the previous session's detail/digest/logs
      // content so the first paint shows the new session's tree with empty
      // detail panels (the deferred pass fills them one tick later). Steady-state
      // ticks leave the content intact to avoid empty→full flicker every poll.
      const detailSelectionChanged = state.selectedSessionId !== lastPolledDetailSessionId;
      lastPolledDetailSessionId = state.selectedSessionId;
      if (detailSelectionChanged) {
        state.planContent = '';
        state.strategyContent = '';
        state.goalContent = '';
        state.completionSummaryContent = '';
        state.logsContent = '';
        state.logsCycles = [];
        state.digestData = null;
        state.cachedReportBlocks.clear();
      }

      requestRender(); // first paint — tree-critical data only

      // Defer the per-file detail/digest/logs reads to a post-paint
      // setImmediate so first paint isn't blocked on file I/O. The token +
      // captured-session guard discards a superseded pass. Not scheduled on the
      // error path (plan decision 5).
      const myToken = ++detailPassToken;
      const mySession = state.selectedSessionId;
      setImmediate(() => scheduleDetailReads(myToken, mySession));
    } catch (err) {
      const wasError = state.error !== null;
      state.error = (err as Error).message;
      if (!wasError) prevFrame = []; // force full redraw on error transition
      requestRender();
    }
  }

  // Deferred detail-read pass. Runs after first paint; reads the same files
  // synchronously into locals, then commits in one atomic event-loop tick.
  // Guarded at entry and again immediately before commit — two checks suffice
  // because the body has no interleave point. (Plan decisions 2-4.)
  function scheduleDetailReads(myToken: number, mySession: string | null): void {
    if (myToken !== detailPassToken || state.selectedSessionId !== mySession || state.resolutionActive) return;

    let planContent = '';
    let strategyContent = '';
    let goalContent = '';
    let completionSummaryContent = '';
    let logsContent = '';
    let logsCycles: CycleLog[] = [];
    let digestData: StatusDigest | null = null;

    if (mySession) {
      try {
        const pp = roadmapPath(state.cwd, mySession);
        if (existsSync(pp)) {
          planContent = readFileSync(pp, 'utf-8');
        }
      } catch {
        // roadmap.md may not exist yet
      }

      try {
        const gp = goalPath(state.cwd, mySession);
        if (existsSync(gp)) {
          goalContent = readFileSync(gp, 'utf-8');
        }
      } catch {
        // goal.md may not exist yet
      }

      try {
        const sp = strategyPath(state.cwd, mySession);
        if (existsSync(sp)) {
          strategyContent = readFileSync(sp, 'utf-8');
        }
      } catch {
        // strategy.md may not exist yet
      }

      try {
        const cp = join(contextDir(state.cwd, mySession), 'completion-summary.md');
        if (existsSync(cp)) {
          completionSummaryContent = readFileSync(cp, 'utf-8');
        }
      } catch {
        // completion-summary.md may not exist (only written on done)
      }

      try {
        const ld = logsDir(state.cwd, mySession);
        if (existsSync(ld)) {
          // Reset cache when session changes
          if (mySession !== cachedLogSessionId) {
            cachedLogFiles = new Map();
            cachedLogSessionId = mySession;
          }

          const files = readdirSync(ld)
            .filter((f) => f.startsWith('cycle-'))
            .sort();

          // Remove cache entries for deleted files
          const fileSet = new Set(files);
          for (const key of cachedLogFiles.keys()) {
            if (!fileSet.has(key)) cachedLogFiles.delete(key);
          }

          // Only re-read files whose mtime changed
          for (const f of files) {
            const filePath = join(ld, f);
            const mtime = statSync(filePath).mtimeMs;
            const cached = cachedLogFiles.get(f);
            if (!cached || cached.mtime !== mtime) {
              const match = f.match(/cycle-(\d+)\.md$/);
              const cycle = match ? parseInt(match[1]!, 10) : 0;
              const content = readFileSync(filePath, 'utf-8');
              cachedLogFiles.set(f, { mtime, cycle, content });
            }
          }

          logsCycles = files.map((f) => {
            const entry = cachedLogFiles.get(f)!;
            return { cycle: entry.cycle, content: entry.content };
          });
          logsContent = logsCycles.map((c) => c.content).join('\n');
        }
      } catch {
        // logs may not exist yet
      }

      try {
        const dp = digestPath(state.cwd, mySession);
        if (existsSync(dp)) {
          const raw = JSON.parse(readFileSync(dp, 'utf-8'));
          if (
            raw &&
            typeof raw.recentWork === 'string' &&
            typeof raw.currentActivity === 'string' &&
            typeof raw.whatsNext === 'string' &&
            Array.isArray(raw.unusualEvents)
          ) {
            digestData = raw as StatusDigest;
          }
        }
      } catch {
        // digest.json may not exist or be malformed
      }
    }

    // Re-check the same guard before commit. The body above was fully
    // synchronous, so no interleave point exists between the two checks.
    if (myToken !== detailPassToken || state.selectedSessionId !== mySession || state.resolutionActive) return;

    state.planContent = planContent;
    state.strategyContent = strategyContent;
    state.goalContent = goalContent;
    state.completionSummaryContent = completionSummaryContent;
    state.logsContent = logsContent;
    state.logsCycles = logsCycles;
    state.digestData = digestData;

    // Resolve report files here (not render) to avoid sync disk reads on
    // keypress. selectedSession was committed synchronously in poll()'s
    // first-paint section; the token + mySession guard guarantees it matches.
    state.cachedReportBlocks.clear();
    const sel = state.selectedSession;
    if (sel) {
      for (const agent of sel.agents) {
        state.cachedReportBlocks.set(agent.id, resolveReports(agent.reports));
      }
    }

    requestRender();
  }

  // ── Render function ──────────────────────────────────────────────────────────

  function render(): void {
    const stdoutRows = process.stdout.rows;
    const stdoutCols = process.stdout.columns;
    state.rows = (typeof stdoutRows === 'number' && stdoutRows > 0) ? stdoutRows : 24;
    state.cols = (typeof stdoutCols === 'number' && stdoutCols > 0) ? stdoutCols : 80;

    const buf = createFrameBuffer(state.cols, state.rows);

    // Terminal too small
    if (state.cols < 60 || state.rows < 12) {
      writeCenter(buf, Math.floor(state.rows / 2), 'Terminal too small — resize to continue');
      const out = flushFrame(buf.lines, prevFrame);
      writeToStdout(out);
      prevFrame = buf.lines;
      return;
    }

    // Detect resolution mode transition → force full redraw (CLAUDE.md cache-pair invariant)
    if (state.resolutionActive !== prevResolutionActive) {
      prevFrame = [];
      prevResolutionActive = state.resolutionActive;
    }

    // Resolution mode full-screen takeover (3e)
    if (state.resolutionActive && state.resolutionHandle) {
      renderResolutionFrame(buf, state);
      const out = flushFrame(buf.lines, prevFrame, '\x1b[0 q\x1b[?25l');
      writeToStdout(out);
      prevFrame = buf.lines;
      return;
    }

    // Compute layout
    const treeWidth = computeTreeWidth(state.cols);
    const remaining = state.cols - treeWidth;
    const detailWidth = Math.floor(remaining * 0.6);
    const digestWidth = remaining - detailWidth;
    const contentHeight = state.rows - 1;

    const treeRect = { x: 0, y: 0, w: treeWidth, h: contentHeight };
    const detailRect = { x: treeWidth, y: 0, w: detailWidth, h: contentHeight };
    const digestRect = { x: treeWidth + detailWidth, y: 0, w: digestWidth, h: contentHeight };
    const bottomY = contentHeight;

    // Derive data
    const filteredSessions: SessionSummary[] = state.searchFilter
      ? state.sessions.filter((s) => {
          const q = state.searchFilter!.toLowerCase();
          return s.task.toLowerCase().includes(q) || s.id.toLowerCase().includes(q);
        })
      : state.sessions;

    // Ensure all sections are expanded so a pending focus target can appear in the tree
    if (state.pendingFocus) {
      state.expanded.add('section:running');
      state.expanded.add('section:done');
    }

    const statusFP = filteredSessions.map(s => `${s.status}:${s.windowAlive}:${s.runningAgentCount}:${s.orphaned ?? false}`).join(',');
    const inboxFP = `${state.aggregateInbox.length}:${state.aggregateInbox.map(i => askIdFromDir(i.dir)).join(',')}`;
    const cacheKey = `${state.expanded.size}:${filteredSessions.length}:${state.selectedSession?.id}:${state.contextFiles.length}:${state.searchFilter}:${statusFP}:${inboxFP}`;

    let nodes: TreeNode[];
    if (cacheKey === state.treeCacheKey && state.cachedTreeNodes !== null) {
      nodes = state.cachedTreeNodes;
    } else {
      nodes = buildTree(
        filteredSessions,
        state.selectedSession,
        state.expanded,
        state.cwd,
        state.contextFiles,
        state.aggregateInbox,
      );
      precomputePrefixes(nodes);
      state.cachedTreeNodes = nodes;
      state.treeCacheKey = cacheKey;
    }

    // Cursor stabilization
    stabilizeCursor(state, nodes);

    // Cache latest nodes for keypress handler
    latestNodes = nodes;

    // Track cursor node identity
    const cursorNode = nodes[state.cursorIndex];
    if (cursorNode) state.cursorNodeId = cursorNode.id;

    // Cursor leaving needs-you-virtual unmounts the inline inbox deck
    const onNeedsYou = cursorNode?.type === 'needs-you-virtual';
    if (prevCursorOnNeedsYou && !onNeedsYou && state.inlineDeck) state.inlineDeck.unmount();
    prevCursorOnNeedsYou = onNeedsYou;

    // Resolve pending deep-link focus request (set by poll() via focus-get)
    if (state.pendingFocus) {
      const { askId } = state.pendingFocus;
      const askPresent = state.aggregateInbox.some(i => askIdFromDir(i.dir) === askId);
      const nyIdx = nodes.findIndex(n => n.type === 'needs-you-virtual');
      if (askPresent && nyIdx >= 0) {
        // Land the deep-linked ask in the center-pane inline deck instead of the
        // fullscreen resolution takeover: point the cursor at the Needs-You inbox
        // node, focus the detail pane so the deck owns keys, and record the askId
        // so the lazy mount opens on it (not the oldest queued ask).
        state.cursorIndex = nyIdx;
        state.cursorNodeId = nodes[nyIdx]!.id;
        state.inlineDeckStartAskId = askId;
        state.focusPane = 'detail';
        state.pendingFocus = null;
        requestRender();
      } else {
        state.pendingFocus.attempts++;
        if (state.pendingFocus.attempts > 25) state.pendingFocus = null;
      }
    }

    // Derive selectedSessionId from cursor
    // section and needs-you-virtual nodes have sessionId === '' — treat as null
    const rawSessionId = cursorNode?.sessionId;
    const newSessionId = rawSessionId ? rawSessionId : null;
    if (newSessionId !== state.selectedSessionId) {
      state.selectedSessionId = newSessionId;
      state.detailScroll.reset();
      state.digestScroll.reset();
      state.cachedDetailLines = null;
      state.detailCacheKey = '';
      state.cachedDigestLines = null;
      state.digestCacheKey = '';
      state.cachedInboxLines = null;
      state.inboxCacheKey = '';
      state.crossSessionInboxScroll.reset();
      state.flowExpanded = false;
      state.goalScroll.reset();
      state.strategyScroll.reset();
      state.roadmapScroll.reset();
      state.cachedStackedLines = null;
      state.stackedCacheKey = '';
      state.detailMode = 'gsr';
      state.focusedStrip = 'roadmap';
    }

    // Override detailMode when cursor is on the virtual inbox node
    if (cursorNode?.type === 'needs-you-virtual') {
      state.detailMode = 'cross-session-inbox';
    } else if (state.detailMode === 'cross-session-inbox') {
      state.detailMode = 'gsr';
    }

    // Trigger debounced poll when session changes (avoids poll storm during rapid scrolling)
    if (state.selectedSessionId !== prevSelectedSessionId) {
      prevSelectedSessionId = state.selectedSessionId;
      if (debouncedPollTimer !== null) clearTimeout(debouncedPollTimer);
      if (state.selectedSessionId !== null) {
        debouncedPollTimer = setTimeout(() => {
          debouncedPollTimer = null;
          void poll();
        }, 80);
      }
    }

    // Auto-expand cycle
    autoExpandCycle(state);

    // Resolve reports for detail panel
    const agents = state.selectedSession?.agents ?? [];
    const reportAgent =
      state.mode === 'report-detail' ? getAgentForNode(cursorNode, agents) : null;
    const reportBlocks = reportAgent ? (state.cachedReportBlocks.get(reportAgent.id) ?? []) : [];

    const detailAgent =
      cursorNode?.type === 'agent' || cursorNode?.type === 'report'
        ? getAgentForNode(cursorNode, agents)
        : null;
    const detailReportBlocks = detailAgent
      ? (state.cachedReportBlocks.get(detailAgent.id) ?? [])
      : [];

    // Load context file content (cached to avoid re-read on every render)
    let contextFileContent: string | null = null;
    if (cursorNode?.type === 'context-file') {
      if (cursorNode.filePath !== cachedContextFilePath) {
        cachedContextFilePath = cursorNode.filePath;
        try {
          if (existsSync(cursorNode.filePath)) {
            cachedContextFileContent = readFileSync(cursorNode.filePath, 'utf-8');
          } else {
            cachedContextFileContent = null;
          }
        } catch {
          cachedContextFileContent = null;
        }
      }
      contextFileContent = cachedContextFileContent;
    } else {
      // Clear cache when cursor moves away
      cachedContextFilePath = null;
      cachedContextFileContent = null;
    }

    // Panel dirty tracking — compute fingerprints for each panel's inputs
    const treeFocused = state.mode === 'navigate' && state.focusPane === 'tree';
    const treeInputs = `${state.treeCacheKey}:${state.cursorIndex}:${treeFocused}`;
    const bottomInputs = `${state.notification}:${state.error}:${state.mode}:${state.searchText}:${cursorNode?.type}`;
    const overlayMode = (state.mode === 'leader' || state.mode === 'copy-menu' || state.mode === 'open-menu' || state.mode === 'agent-menu' || state.mode === 'session-menu' || state.mode === 'go-menu' || state.mode === 'companion-menu' || state.mode === 'help' || state.mode === 'companion-overlay' || state.mode === 'companion-debug') ? state.mode : '';
    let companionFP = '';
    if (state.mode === 'companion-overlay' || state.mode === 'companion-debug') {
      const c = getCompanion();
      const ts = c && c.lastCommentary ? c.lastCommentary.timestamp : '';
      const xp = c ? c.xp : 0;
      const dm = c?.debugMood ? `${c.debugMood.winner}:${c.debugMood.scores[c.debugMood.winner]}` : '';
      companionFP = `${ts}:${xp}:${dm}`;
    }
    const overlayInputs = `${overlayMode}:${companionFP}`;

    const hasPrev = prevFrame.length === buf.height;
    const treeDirty = !hasPrev || treeInputs !== prevTreeInputs;
    const bottomDirty = !hasPrev || bottomInputs !== prevBottomInputs;
    const overlayDirty = !hasPrev || overlayInputs !== prevOverlayMode;

    prevTreeInputs = treeInputs;
    prevBottomInputs = bottomInputs;
    prevOverlayMode = overlayInputs;

    // Render tree into a narrow buffer (treeWidth-wide) so rows are the right size
    // for concatenation. Cached when clean.
    let treeRows: string[];
    if (treeDirty) {
      const treeBlank = ' '.repeat(treeWidth);
      const treeBuf: import('./render.js').FrameBuffer = {
        lines: Array.from({ length: contentHeight }, () => treeBlank),
        width: treeWidth,
        height: contentHeight,
      };
      renderTreePanel(
        treeBuf,
        { x: 0, y: 0, w: treeWidth, h: contentHeight },
        nodes,
        state.cursorIndex,
        treeFocused,
        getCompanion(),
      );
      cachedTreeRows = treeBuf.lines;
      treeRows = treeBuf.lines;
    } else {
      treeRows = cachedTreeRows;
    }

    // Render detail + logs as self-contained row strings, then compose by concatenation.
    // This eliminates all sliceDisplayCols calls — the main scroll bottleneck.
    const detailCtx: DetailContext = {
      nodes,
      session: state.selectedSession,
      agents,
      reportBlocks,
      detailReportBlocks,
      contextFileContent,
    };

    let detailRows: string[];
    if (cursorNode?.type === 'needs-you-virtual') {
      detailRows = renderInboxDeckRows(detailRect, state);
    } else if (state.useStackedDetail) {
      detailRows = renderStackedDetailRows(detailRect, state, detailCtx);
    } else {
      detailRows = renderDetailRows(detailRect, state, detailCtx);
    }
    const rightPanelRows = renderDigestRows(digestRect, state);

    // Compose panel rows into buffer by concatenation (no slicing/splicing)
    for (let i = 0; i < contentHeight; i++) {
      buf.lines[i] = treeRows[i]! + detailRows[i]! + rightPanelRows[i]!;
    }

    // Bottom row (single status line — notifications replace keybindings transiently)
    if (bottomDirty || overlayDirty) {
      renderStatusLine(buf, bottomY, state, cursorNode?.type);
    } else {
      copyRows(buf, prevFrame, bottomY, 1);
    }

    // Overlays (rendered AFTER panels — overwrites panel content)
    if (overlayMode) {
      const ACCENT: Record<string, string> = {
        topLevel: 'magenta',
        copy: 'cyan',
        open: 'green',
        agent: 'blue',
        session: 'red',
        go: 'yellow',
        companion: 'magenta',
      };
      const menuId = MENU_FOR_MODE[state.mode];
      if (menuId) {
        const menu = menuId === 'topLevel' ? KEYMAP.topLevel : KEYMAP.submenus[menuId]!;
        const accent = ACCENT[menuId];
        renderSubmenuOverlay(buf, state.rows, state.cols, menu, accent !== undefined ? accent : 'white');
      }
      if (state.mode === 'help') renderHelpOverlay(buf, state.rows, state.cols);
      if (state.mode === 'companion-overlay') {
        const companion = getCompanion();
        if (companion) renderCompanionOverlay(buf, state.rows, state.cols, companion);
      }
      if (state.mode === 'companion-debug') {
        const companion = getCompanion();
        if (companion) renderCompanionDebugOverlay(buf, state.rows, state.cols, companion);
      }
    }

    // Build cursor suffix inside synchronized output block to prevent flicker
    const cursorSuffix = '\x1b[0 q\x1b[?25l';

    // Flush diff to stdout with cursor positioning inside sync block
    const out = flushFrame(buf.lines, prevFrame, cursorSuffix);
    writeToStdout(out);
    prevFrame = buf.lines;
  }

  // ── InputActions ─────────────────────────────────────────────────────────────

  const inputActions: InputActions = {
    getNodes: () => latestNodes,
    getCursorNode: () => latestNodes[state.cursorIndex],
    getAgentForNode: (node) => {
      const agents = state.selectedSession?.agents ?? [];
      return getAgentForNode(node, agents);
    },
    sendAndNotify: (request, successMsg) => {
      void send(request)
        .then((res) => {
          if (res.ok) {
            notify(state, successMsg);
          } else {
            const errMsg = typeof res.error === 'string' ? res.error : res.error.message;
            notify(state, `Error: ${errMsg}`);
          }
        })
        .catch((err: Error) => {
          notify(state, `Error: ${err.message}`);
        });
    },
    send,
    composeViaPopup,
    openEditorPopup,
    editInPopup,
    promptInPopup,
    openCompanionPane,
    openClaudeResumePopup,
    openClaudeResumeSession,
    selectWindow,
    selectPane,
    switchToSession,
    paneExists,
    openLogPopup,
    openShellPopup,
    openInFileManager,
    copyToClipboard: (text) => {
      const err = sharedCopyToClipboard(text);
      if (err !== null) notify(state, err.reason);
    },
    buildSessionContext,
    resolveEditor: () => {
      if (config.editor) return config.editor;
      if (process.env.EDITOR) return process.env.EDITOR;
      return 'nvim';
    },
    cleanup: () => {
      cleanup();
      process.exit(0);
    },
  };

  // ── Wire everything together ─────────────────────────────────────────────────

  setRenderFunction(render);

  const stopKeypress = startKeypressListener((input, key) => {
    handleKeypress(input, key, state, inputActions);
  });

  const stopResize = onResize(() => {
    const stdoutRows = process.stdout.rows;
    const stdoutCols = process.stdout.columns;
    state.rows = (typeof stdoutRows === 'number' && stdoutRows > 0) ? stdoutRows : 24;
    state.cols = (typeof stdoutCols === 'number' && stdoutCols > 0) ? stdoutCols : 80;
    prevFrame = []; // force full redraw
    if (state.resolutionActive && state.resolutionHandle) {
      state.resolutionHandle.handleResize(state.cols, state.rows - 1);
    }
    requestRender();
  });

  // Initial poll + recurring interval
  void poll();
  const pollInterval = setInterval(() => void poll(), 2500);

  // Register teardown so cleanup() releases all resources
  const origCleanup = inputActions.cleanup;
  inputActions.cleanup = () => {
    clearInterval(pollInterval);
    if (debouncedPollTimer !== null) clearTimeout(debouncedPollTimer);
    stopKeypress();
    stopResize();
    state.resolutionHandle?.unmount();
    state.detailScroll.destroy();
    state.digestScroll.destroy();
    state.goalScroll.destroy();
    state.strategyScroll.destroy();
    state.roadmapScroll.destroy();
    origCleanup();
  };

  // Initial render
  requestRender();
}
