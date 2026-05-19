import type { Session } from '../shared/types.js';
import type { InboxItem } from '../shared/inbox-types.js';
import type { TreeNode } from './types/tree.js';
import type { ReportBlock } from './lib/reports.js';

// ---------------------------------------------------------------------------
// Polling data interfaces (moved from usePolling.ts)
// ---------------------------------------------------------------------------

export interface SessionSummary {
  id: string;
  name?: string;
  task: string;
  status: string;
  agentCount: number;
  runningAgentCount: number;
  createdAt: string;
  activeMs: number;
  tmuxSessionName?: string;
  tmuxSessionId?: string;
  tmuxWindowId?: string;
  /** Cached result of windowExists check — avoids synchronous subprocess in render */
  windowAlive?: boolean;
  orphaned?: boolean;
}

export interface CycleLog {
  cycle: number;
  content: string;
}

// ---------------------------------------------------------------------------
// InputMode (moved from InputBar.tsx)
// ---------------------------------------------------------------------------

export type InputMode =
  | 'navigate'
  | 'report-detail'
  | 'leader'
  | 'copy-menu'
  | 'open-menu'
  | 'agent-menu'
  | 'session-menu'
  | 'go-menu'
  | 'companion-menu'
  | 'help'
  | 'companion-overlay'
  | 'companion-debug'
  | 'search';

// ---------------------------------------------------------------------------
// Compose mode types
// ---------------------------------------------------------------------------

export type ComposeAction =
  | { kind: 'new-session' }
  | { kind: 'message-orchestrator'; sessionId: string }
  | { kind: 'resume'; sessionId: string }
  | { kind: 'continue'; sessionId: string }
  | { kind: 'spawn-agent'; sessionId: string }
  | { kind: 'message-agent'; sessionId: string; agentId: string };

/** Actions where empty content is allowed (submit without typing) */
export const OPTIONAL_COMPOSE = new Set(['resume', 'continue']);

// ---------------------------------------------------------------------------
// Render scheduling
// ---------------------------------------------------------------------------

let renderScheduled = false;
let renderFn: (() => void) | null = null;

export function setRenderFunction(fn: () => void): void {
  renderFn = fn;
}

export function requestRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  setImmediate(() => {
    renderScheduled = false;
    renderFn?.();
  });
}

// ---------------------------------------------------------------------------
// ThrottledScroll
// ---------------------------------------------------------------------------

const FRAME_MS = 16; // ~60fps

export class ThrottledScroll {
  offset: number = 0;
  private target: number = 0;
  private max: number = Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onRender: () => void;

  constructor(onRender: () => void, initial = 0) {
    this.onRender = onRender;
    this.offset = initial;
    this.target = initial;
  }

  private scheduleFlush(): void {
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.offset = this.target;
        this.onRender();
      }, FRAME_MS);
    }
  }

  private clamp(value: number): number {
    if (value < 0) return 0;
    if (value > this.max) return this.max;
    return value;
  }

  scrollBy(delta: number): void {
    this.target = this.clamp(this.target + delta);
    this.scheduleFlush();
  }

  scrollTo(value: number): void {
    this.target = this.clamp(value);
    this.scheduleFlush();
  }

  // Renderer pushes the current content's max scroll each frame so scrollBy
  // can't accumulate past the bottom. Without this, over-scroll inflates
  // `target` invisibly and reverse scrolls have to burn through the buffer
  // before any visual movement resumes.
  setMax(max: number): void {
    this.max = Math.max(0, max);
    if (this.target > this.max) this.target = this.max;
    if (this.offset > this.max) this.offset = this.max;
  }

  reset(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.target = 0;
    this.offset = 0;
  }

  destroy(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// AppState
// ---------------------------------------------------------------------------

export interface AppState {
  // Terminal dimensions
  rows: number;
  cols: number;

  // Tree navigation
  cursorIndex: number;
  expanded: Set<string>;
  mode: InputMode;
  focusPane: 'tree' | 'detail' | 'logs';

  // Session
  selectedSessionId: string | null;
  searchFilter: string | null;
  searchText: string;
  targetAgentId: string | null;

  // UI
  notification: string | null;
  notificationTimer: ReturnType<typeof setTimeout> | null;

  // Scroll
  detailScroll: ThrottledScroll;
  digestScroll: ThrottledScroll;

  // Aggregate inbox — fetched from daemon on each poll
  aggregateInbox: (InboxItem & { sessionName?: string })[];
  crossSessionInboxScroll: ThrottledScroll;
  cachedInboxLines: import('./lib/format.js').DetailLine[] | null;
  inboxCacheKey: string;
  inboxRenderedCache: import('./render.js').RenderedCache;

  // Stacked detail (3b) — cachedStackedLines + stackedCacheKey must be cleared together (cache pair invariant)
  useStackedDetail: boolean;
  detailMode: 'gsr' | 'cycle-log' | 'cross-session-inbox';
  focusedStrip: 'goal' | 'strategy' | 'roadmap';
  goalScroll: ThrottledScroll;
  strategyScroll: ThrottledScroll;
  roadmapScroll: ThrottledScroll;
  cachedStackedLines: {
    goal: import('./lib/format.js').DetailLine[];
    strategy: import('./lib/format.js').DetailLine[];
    roadmap: import('./lib/format.js').DetailLine[];
    cycleLog: import('./lib/format.js').DetailLine[];
  } | null;
  stackedCacheKey: string;
  stackedRenderedCache: import('./render.js').RenderedCache;

  // Polling data (from daemon)
  sessions: SessionSummary[];
  selectedSession: Session | null;
  planContent: string;
  strategyContent: string;
  goalContent: string;
  completionSummaryContent: string;
  logsContent: string;
  logsCycles: CycleLog[];
  digestData: import('../shared/types.js').StatusDigest | null;
  paneAlive: boolean;
  contextFiles: string[];
  error: string | null;

  // Cursor stabilization
  cursorNodeId: string | null;
  prevNodes: TreeNode[];
  prevCycleCount: number;

  // Render caches
  cachedReportBlocks: Map<string, ReportBlock[]>;
  cachedTreeNodes: TreeNode[] | null;
  treeCacheKey: string;
  cachedDetailLines: import('./lib/format.js').DetailLine[] | null;
  detailCacheKey: string;
  detailRenderedCache: import('./render.js').RenderedCache;
  cachedDigestLines: import('./lib/format.js').DetailLine[] | null;
  digestCacheKey: string;
  digestRenderedCache: import('./render.js').RenderedCache;

  // Cycle flow
  flowExpanded: boolean;

  // Resolution mode (3e)
  resolutionActive: boolean;
  resolutionHandle: import('./panels/mounted-humanloop.js').MountedResolutionHandle | null;
  inlineDeck: import('./panels/mounted-humanloop.js').MountedResolutionHandle | null;
  visuals: Map<string, import('./panels/mounted-humanloop.js').VisualEntry>;

  // Review panel — mounted in place of inlineDeck when focused inbox item is kind='review'
  reviewPanel: import('./panels/review-action.js').ReviewActionPanel | null;

  // Config
  cwd: string;
}

export function createAppState(cwd: string): AppState {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;

  const detailScroll = new ThrottledScroll(requestRender);
  const digestScroll = new ThrottledScroll(requestRender);
  const crossSessionInboxScroll = new ThrottledScroll(requestRender);
  const goalScroll = new ThrottledScroll(requestRender);
  const strategyScroll = new ThrottledScroll(requestRender);
  const roadmapScroll = new ThrottledScroll(requestRender);

  // Seed default-expanded sections (done stays collapsed)
  const expanded = new Set<string>();
  expanded.add('section:needs-you');
  expanded.add('section:running');

  return {
    rows,
    cols,
    cursorIndex: 0,
    expanded,
    mode: 'navigate',
    focusPane: 'tree',
    selectedSessionId: null,
    searchFilter: null,
    searchText: '',
    targetAgentId: null,
    notification: null,
    notificationTimer: null,
    detailScroll,
    digestScroll,
    aggregateInbox: [],
    crossSessionInboxScroll,
    cachedInboxLines: null,
    inboxCacheKey: '',
    inboxRenderedCache: { lines: [], ansi: [] },
    useStackedDetail: process.env.SISYPHUS_USE_STACKED_DETAIL !== '0',
    detailMode: 'gsr',
    focusedStrip: 'roadmap',
    goalScroll,
    strategyScroll,
    roadmapScroll,
    cachedStackedLines: null,
    stackedCacheKey: '',
    stackedRenderedCache: { lines: [], ansi: [] },
    sessions: [],
    selectedSession: null,
    planContent: '',
    strategyContent: '',
    goalContent: '',
    completionSummaryContent: '',
    logsContent: '',
    logsCycles: [],
    digestData: null,
    paneAlive: true,
    contextFiles: [],
    error: null,
    cursorNodeId: null,
    prevNodes: [],
    prevCycleCount: 0,
    cachedReportBlocks: new Map(),
    cachedTreeNodes: null,
    treeCacheKey: '',
    cachedDetailLines: null,
    detailCacheKey: '',
    detailRenderedCache: { lines: [], ansi: [] },
    cachedDigestLines: null,
    digestCacheKey: '',
    digestRenderedCache: { lines: [], ansi: [] },
    flowExpanded: false,
    resolutionActive: false,
    resolutionHandle: null,
    inlineDeck: null,
    visuals: new Map(),
    reviewPanel: null,
    cwd,
  };
}

// ---------------------------------------------------------------------------
// Notification helper
// ---------------------------------------------------------------------------

export function notify(state: AppState, msg: string): void {
  state.notification = msg;
  if (state.notificationTimer !== null) {
    clearTimeout(state.notificationTimer);
  }
  state.notificationTimer = setTimeout(() => {
    state.notification = null;
    state.notificationTimer = null;
    requestRender();
  }, 30_000);
}

// ---------------------------------------------------------------------------
// Cursor stabilization
// ---------------------------------------------------------------------------

export function stabilizeCursor(state: AppState, nodes: TreeNode[]): void {
  if (nodes.length === 0) {
    state.cursorIndex = 0;
    return;
  }

  const targetId = state.cursorNodeId;
  if (targetId === null) {
    state.cursorNodeId = nodes[0]?.id ?? null;
    return;
  }

  // If current index already points to the right node, no adjustment needed
  if (nodes[state.cursorIndex]?.id === targetId) return;

  // Find the tracked node in the new tree
  const newIndex = nodes.findIndex((n) => n.id === targetId);
  if (newIndex !== -1) {
    state.cursorIndex = newIndex;
  } else {
    // Node is gone (parent collapsed, session removed, etc.) — clamp
    const clamped = Math.min(state.cursorIndex, nodes.length - 1);
    state.cursorIndex = clamped;
    state.cursorNodeId = nodes[clamped]?.id ?? null;
  }
}

// ---------------------------------------------------------------------------
// Auto-expand cycle
// ---------------------------------------------------------------------------

export function autoExpandCycle(state: AppState): void {
  const selectedSession = state.selectedSession;
  if (!selectedSession) return;

  const sessionNodeId = `session:${selectedSession.id}`;
  const cycles = selectedSession.orchestratorCycles;

  // Only auto-manage cycle expansion if the session is already expanded by user
  if (!state.expanded.has(sessionNodeId)) {
    state.prevCycleCount = cycles.length;
    return;
  }

  if (cycles.length === 0) {
    state.prevCycleCount = 0;
    return;
  }

  const latest = cycles[cycles.length - 1]!;
  const latestId = `cycle:${selectedSession.id}:${latest.cycle}`;

  if (cycles.length > state.prevCycleCount && state.prevCycleCount > 0) {
    // New cycle appeared — collapse previous, expand latest
    const prevCycle = cycles[cycles.length - 2];
    if (prevCycle) {
      const prevId = `cycle:${selectedSession.id}:${prevCycle.cycle}`;
      state.expanded.delete(prevId);
      state.expanded.add(latestId);
    }
  } else if (!state.expanded.has(latestId)) {
    // Ensure latest is expanded
    state.expanded.add(latestId);
  }

  state.prevCycleCount = cycles.length;
}
