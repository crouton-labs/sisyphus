import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { exportSessionToZip } from '../shared/session-export.js';
import { pasteFromClipboard } from '../shared/clipboard.js';
import type { Key } from './terminal.js';
import {
  type AppState,
  type ComposeAction,
  OPTIONAL_COMPOSE,
  requestRender,
  notify,
} from './state.js';
import type { TreeNode } from './types/tree.js';
import type { Agent } from '../shared/types.js';
import type { Response } from '../shared/protocol.js';
import { sessionDir, goalPath, roadmapPath, strategyPath, reportsDir } from '../shared/paths.js';
import type { Request } from '../shared/protocol.js';
import { findParentIndex } from './lib/tree.js';
import { badgeGalleryLeft, badgeGalleryRight, closeBadgeGallery, companionOverlayNextPage, companionOverlayShowHelp, companionOverlayDismissHelp, getCompanionPage, badgeListScrollUp, badgeListScrollDown } from './panels/overlays.js';
import { KEYMAP, MENU_FOR_MODE } from '../shared/keymap.js';
import type { MenuItem } from '../shared/keymap.js';

// ── Re-exported types (same definition, no React) ─────────────────────────────

export type LeaderAction =
  // already present
  | { type: 'enter-copy-menu' }
  | { type: 'copy-path' }
  | { type: 'copy-context' }
  | { type: 'copy-logs' }
  | { type: 'copy-session-id' }
  | { type: 'delete-session' }
  | { type: 'open-logs' }
  | { type: 'open-session-dir' }
  | { type: 'open-strategy' }
  | { type: 'open-roadmap' }
  | { type: 'search' }
  | { type: 'jump-to-session'; index: number }
  | { type: 'spawn-agent' }
  | { type: 'message-agent' }
  | { type: 'help' }
  | { type: 'companion-overlay' }
  | { type: 'companion-debug' }
  | { type: 'companion-pane' }
  | { type: 'enter-companion-menu' }
  | { type: 'shell-command' }
  | { type: 'jump-to-pane' }
  | { type: 'export-session' }
  | { type: 'kill' }
  | { type: 'quit' }
  | { type: 'dismiss' }
  // new submenu enters
  | { type: 'enter-open-menu' }
  | { type: 'enter-agent-menu' }
  | { type: 'enter-session-menu' }
  | { type: 'enter-go-menu' }
  // new copy variants
  | { type: 'copy-latest-report' }
  | { type: 'copy-agent-id' }
  // new open variants
  | { type: 'open-goal' }
  | { type: 'open-latest-report' }
  | { type: 'open-scratch' }
  | { type: 'edit-context-file' }
  // new agent variants
  | { type: 'restart-agent' }
  | { type: 'rerun-agent' }
  | { type: 'open-claude-agent' }
  | { type: 'tail-agent-logs' }
  | { type: 'kill-agent' }
  | { type: 'quick-spawn-explore' }
  | { type: 'quick-spawn-debug' }
  // new session variants
  | { type: 'new-session' }
  | { type: 'resume-session' }
  | { type: 'continue-session' }
  | { type: 'rollback' }
  | { type: 'kill-session' }
  | { type: 'go-to-window' }
  | { type: 'clone-session' }
  | { type: 'history' }
  // new go variants
  | { type: 'pick-session' }
  | { type: 'cycle-session' }
  | { type: 'reconnect' }
  // messaging / status
  | { type: 'message-orchestrator' }
  | { type: 'show-status' };

export interface KeybindingHandlers {
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEnter: () => void;
  onLeft: () => void;
  onRight: () => void;
  onSpace: () => void;
  onTab: () => void;
  onMessage: () => void;
  onGoToWindow: () => void;
  onEditGoal: () => void;
  onNewSession: () => void;
  onClaude: () => void;
  onOpenPlan: () => void;
  onQuit: () => void;
  onReRun: () => void;
  onResume: () => void;
  onContinue: () => void;
  onRestartAgent: () => void;
  onRollback: () => void;
  onToggleLogs: () => void;
  onEdit: () => void;
}

// ── InputActions interface ─────────────────────────────────────────────────────

export interface InputActions {
  // Navigation context (computed by caller, passed in)
  getNodes: () => TreeNode[];
  getCursorNode: () => TreeNode | undefined;
  getAgentForNode: (node: TreeNode | undefined) => Agent | null;

  // Async daemon operations
  sendAndNotify: (request: Request, successMsg: string) => void;
  send: (request: Request) => Promise<Response>;

  // Editor/tmux operations (injected — input.ts must not import these directly)
  openEditorPopup: typeof import('./lib/tmux.js').openEditorPopup;
  editInPopup: typeof import('./lib/tmux.js').editInPopup;
  promptInPopup: typeof import('./lib/tmux.js').promptInPopup;
  openCompanionPane: typeof import('./lib/tmux.js').openCompanionPane;
  openClaudeResumePopup: typeof import('./lib/tmux.js').openClaudeResumePopup;
  openClaudeResumeSession: typeof import('./lib/tmux.js').openClaudeResumeSession;
  selectWindow: typeof import('./lib/tmux.js').selectWindow;
  selectPane: typeof import('./lib/tmux.js').selectPane;
  switchToSession: typeof import('./lib/tmux.js').switchToSession;
  paneExists: typeof import('./lib/tmux.js').paneExists;
  openLogPopup: typeof import('./lib/tmux.js').openLogPopup;
  openShellPopup: typeof import('./lib/tmux.js').openShellPopup;
  openInFileManager: typeof import('./lib/tmux.js').openInFileManager;
  copyToClipboard: (text: string) => void;
  buildSessionContext: typeof import('./lib/context.js').buildSessionContext;

  // Compose via tmux popup
  composeViaPopup: typeof import('./lib/popup-compose.js').composeViaPopup;

  // Config
  resolveEditor: () => string;

  // Lifecycle
  cleanup: () => void;
}

/**
 * Map compose action kinds to daemon requests.
 */
export function dispatchComposeAction(
  action: ComposeAction,
  content: string,
  state: AppState,
  actions: InputActions,
): void {
  switch (action.kind) {
    case 'new-session':
      actions.sendAndNotify(
        { type: 'start', task: content, cwd: state.cwd },
        'Session created',
      );
      break;

    case 'message-orchestrator':
      actions.sendAndNotify(
        { type: 'message', sessionId: action.sessionId, content },
        'Message queued',
      );
      break;

    case 'resume':
      actions.sendAndNotify(
        { type: 'resume', sessionId: action.sessionId, cwd: state.cwd, message: content || undefined },
        'Session resumed',
      );
      break;

    case 'continue':
      void (async () => {
        try {
          const contRes = await actions.send({ type: 'continue', sessionId: action.sessionId });
          if (!contRes.ok) { notify(state, `Error: ${contRes.error}`); return; }
          actions.sendAndNotify(
            { type: 'resume', sessionId: action.sessionId, cwd: state.cwd, message: content || undefined },
            'Session continued',
          );
        } catch (err) {
          notify(state, `Error: ${(err as Error).message}`);
        }
      })();
      break;

    case 'spawn-agent':
      actions.sendAndNotify(
        {
          type: 'spawn',
          sessionId: action.sessionId,
          agentType: 'default',
          name: 'agent',
          instruction: content,
        },
        'Agent spawned',
      );
      break;

    case 'message-agent':
      actions.sendAndNotify(
        { type: 'message', sessionId: action.sessionId, content, source: { type: 'agent', agentId: action.agentId } },
        `Message sent to ${action.agentId}`,
      );
      break;
  }
}

// ── Descriptor-driven dispatcher ──────────────────────────────────────────────

// Maps submenu ref → the LeaderAction type that enters it
const ENTER_FOR_REF: Record<string, LeaderAction['type']> = {
  copy:      'enter-copy-menu',
  open:      'enter-open-menu',
  agent:     'enter-agent-menu',
  session:   'enter-session-menu',
  go:        'enter-go-menu',
  companion: 'enter-companion-menu',
};

// Maps tuiAction strings (from MenuItem.tuiAction) to LeaderAction types
const TUI_ACTION_FOR_NAME: Record<string, LeaderAction['type']> = {
  'search':            'search',
  'edit-context-file': 'edit-context-file',
  'show-leader':       'help',
  'companion-overlay': 'companion-overlay',
  'companion-debug':   'companion-debug',
  'companion-pane':    'companion-pane',
};

// Hand-maintained mapping from script/popup name → LeaderAction type.
// The `satisfies` clause is the compile-time gate: any value not in LeaderAction['type']
// fails the build immediately. Add a row here when a new descriptor item must
// be handled in-process by the dashboard.
const TUI_HANDLERS = {
  'sisyphus-copy-path':           'copy-path',
  'sisyphus-copy-id':             'copy-session-id',
  'sisyphus-copy-context':        'copy-context',
  'sisyphus-copy-logs':           'copy-logs',
  'sisyphus-copy-latest-report':  'copy-latest-report',
  'sisyphus-copy-agent-id':       'copy-agent-id',
  'sisyphus-open-goal':           'open-goal',
  'sisyphus-open-roadmap':        'open-roadmap',
  'sisyphus-open-strategy':       'open-strategy',
  'sisyphus-open-logs':           'open-logs',
  'sisyphus-open-dir':            'open-session-dir',
  'sisyphus-open-latest-report':  'open-latest-report',
  'sisyphus-open-scratch':        'open-scratch',
  'sisyphus-spawn-agent':         'spawn-agent',
  'sisyphus-msg-agent':           'message-agent',
  'sisyphus-restart-agent-popup': 'restart-agent',
  'sisyphus-rerun-agent':         'rerun-agent',
  'sisyphus-jump-to-pane':        'jump-to-pane',
  'sisyphus-open-claude-agent':   'open-claude-agent',
  'sisyphus-tail-agent-logs':     'tail-agent-logs',
  'sisyphus-kill-agent':          'kill-agent',
  'sisyphus-quick-spawn-explore': 'quick-spawn-explore',
  'sisyphus-quick-spawn-debug':   'quick-spawn-debug',
  'sisyphus-new':                 'new-session',
  'sisyphus-resume-session':      'resume-session',
  'sisyphus-continue-session':    'continue-session',
  'sisyphus-rollback-session':    'rollback',
  'sisyphus-kill-session':        'kill-session',
  'sisyphus-delete-session':      'delete-session',
  'sisyphus-export-session':      'export-session',
  'sisyphus-go-to-window':        'go-to-window',
  'sisyphus-clone-session':       'clone-session',
  'sisyphus-history':             'history',
  'sisyphus-pick-session':        'pick-session',
  'sisyphus-cycle':               'cycle-session',
  'sisyphus-reconnect':           'reconnect',
  'sisyphus-help':                'help',
  'sisyphus-home':                'cycle-session',
  'sisyphus-msg':                 'message-orchestrator',
  'sisyphus-status-popup':        'show-status',
  'sisyphus-kill-pane':           'kill',
} as const satisfies Record<string, LeaderAction['type']>;

function findLatestReport(cwd: string, sessionId: string): string | null {
  const dir = reportsDir(cwd, sessionId);
  try {
    const files = readdirSync(dir);
    if (files.length === 0) return null;
    let latestFile = files[0]!;
    let latestMtime = statSync(join(dir, latestFile)).mtimeMs;
    for (let i = 1; i < files.length; i++) {
      const m = statSync(join(dir, files[i]!)).mtimeMs;
      if (m > latestMtime) { latestMtime = m; latestFile = files[i]!; }
    }
    return join(dir, latestFile);
  } catch { return null; }
}

async function goToSessionWindow(state: AppState, actions: InputActions): Promise<void> {
  const session = state.selectedSession;
  if (!session || !state.selectedSessionId) { notify(state, 'No session selected'); return; }

  if (session.status !== 'completed' && state.paneAlive && session.tmuxWindowId) {
    const switchTarget = session.tmuxSessionId ?? session.tmuxSessionName;
    if (switchTarget) actions.switchToSession(switchTarget);
    actions.selectWindow(session.tmuxWindowId);
    return;
  }

  // Pane appears dead but the tmux session may still exist with stale IDs
  // (window closed, daemon restarted, etc.) — try a daemon-side reconnect to
  // refresh tmuxSessionId/tmuxWindowId, then switch using the fresh IDs.
  // Falls through to a fresh `claude --resume` only if no tmux session by name exists.
  if (session.status !== 'completed') {
    const sessionId = state.selectedSessionId;
    const res = await actions.send({ type: 'reconnect', sessionId, cwd: state.cwd });
    if (res.ok) {
      const data = res.data ?? {};
      const tmuxName = (data['tmuxSessionName'] as string | undefined) ?? session.tmuxSessionName;
      const tmuxWin = data['tmuxWindowId'] as string | undefined;
      const tmuxId = data['tmuxSessionId'] as string | undefined;
      const switchTarget = tmuxId ?? tmuxName;
      if (switchTarget) actions.switchToSession(switchTarget);
      if (tmuxWin) actions.selectWindow(tmuxWin);
      notify(state, `Reconnected ${tmuxName ?? sessionId}`);
      return;
    }
  }

  const lastCycle = session.orchestratorCycles[session.orchestratorCycles.length - 1];
  const claudeSessionId = lastCycle?.claudeSessionId;
  if (!claudeSessionId) { notify(state, 'No orchestrator Claude session ID available'); return; }
  try {
    const label = session.name ?? state.selectedSessionId!.slice(0, 8);
    const sessionName = actions.openClaudeResumeSession(state.cwd, state.selectedSessionId!, claudeSessionId, label, lastCycle.resumeEnv, lastCycle.resumeArgs, lastCycle.cycle, lastCycle.mode);
    actions.switchToSession(sessionName);
  } catch {
    notify(state, 'Failed to open Claude session');
  }
}

function dispatchItem(item: MenuItem, state: AppState, actions: InputActions): void {
  if (item.action.type === 'submenu') {
    const t = ENTER_FOR_REF[item.action.ref];
    if (!t) return handleLeaderAction({ type: 'dismiss' }, state, actions);
    return handleLeaderAction({ type: t } as LeaderAction, state, actions);
  }
  if (item.tuiAction) {
    const t = TUI_ACTION_FOR_NAME[item.tuiAction];
    if (t) return handleLeaderAction({ type: t } as LeaderAction, state, actions);
  }
  if (item.action.type === 'tui') {
    const t = TUI_ACTION_FOR_NAME[item.action.action];
    if (t) return handleLeaderAction({ type: t } as LeaderAction, state, actions);
    notify(state, `No tui-action handler for ${item.action.action}`);
    return handleLeaderAction({ type: 'dismiss' }, state, actions);
  }
  if (item.action.type === 'script' || item.action.type === 'popup') {
    const t = TUI_HANDLERS[item.action.name as keyof typeof TUI_HANDLERS];
    if (t) return handleLeaderAction({ type: t } as LeaderAction, state, actions);
    notify(state, `No dashboard handler for ${item.action.name}`);
    return handleLeaderAction({ type: 'dismiss' }, state, actions);
  }
  // tmux-only items silently dismissed on dashboard
  handleLeaderAction({ type: 'dismiss' }, state, actions);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function expandSessionLatestCycle(state: AppState, node: TreeNode): void {
  if (node.type === 'session' && state.selectedSession?.id === node.sessionId) {
    const cycles = state.selectedSession.orchestratorCycles;
    if (cycles.length > 0) {
      const latest = cycles[cycles.length - 1]!;
      state.expanded.add(`cycle:${node.sessionId}:${latest.cycle}`);
    }
  }
}

// ── handleReportDetailKey ─────────────────────────────────────────────────────

function handleReportDetailKey(input: string, key: Key, state: AppState, _actions: InputActions): void {
  if (key.escape || key.return) {
    state.mode = 'navigate';
    requestRender();
    return;
  }
  if (key.upArrow) {
    state.detailScroll.scrollBy(-1);
    return;
  }
  if (key.downArrow) {
    state.detailScroll.scrollBy(1);
    return;
  }
}

// ── handleLeaderKey ───────────────────────────────────────────────────────────

function handleLeaderAction(action: LeaderAction, state: AppState, actions: InputActions): void {
  const nodes = actions.getNodes();
  const cursorNode = actions.getCursorNode();
  const session = state.selectedSession;
  const selectedSessionId = state.selectedSessionId;
  const agents = session?.agents ?? [];

  switch (action.type) {
    case 'enter-copy-menu':
      state.mode = 'copy-menu';
      requestRender();
      return;

    case 'copy-path': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      const path = sessionDir(state.cwd, selectedSessionId);
      try {
        actions.copyToClipboard(path);
        notify(state, `Copied path (${path})`);
      } catch {
        notify(state, 'Failed to copy to clipboard');
      }
      break;
    }

    case 'copy-context': {
      if (!selectedSessionId || !session) { notify(state, 'No session selected'); break; }
      try {
        const xml = actions.buildSessionContext(session, state.cwd);
        actions.copyToClipboard(xml);
        notify(state, `Copied context (${xml.length} chars)`);
      } catch {
        notify(state, 'Failed to copy context');
      }
      break;
    }

    case 'copy-logs': {
      if (!state.logsContent) { notify(state, 'No logs content'); break; }
      try {
        actions.copyToClipboard(state.logsContent);
        notify(state, `Copied logs (${state.logsContent.length} chars)`);
      } catch {
        notify(state, 'Failed to copy to clipboard');
      }
      break;
    }

    case 'copy-session-id': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      try {
        actions.copyToClipboard(selectedSessionId);
        notify(state, `Copied session ID (${selectedSessionId})`);
      } catch {
        notify(state, 'Failed to copy to clipboard');
      }
      break;
    }

    case 'delete-session': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      try {
        const text = actions.promptInPopup('Delete session? (y/yes to confirm):');
        const answer = text?.trim().toLowerCase();
        if (answer === 'y' || answer === 'yes') {
          actions.sendAndNotify({ type: 'delete', sessionId: selectedSessionId, cwd: state.cwd }, 'Session deleted');
        } else {
          notify(state, 'Delete cancelled');
        }
      } catch {
        notify(state, 'Failed to open prompt');
      }
      break;
    }

    case 'open-logs': {
      try {
        actions.openLogPopup();
      } catch {
        notify(state, 'Failed to open log popup');
      }
      break;
    }

    case 'open-session-dir': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      try {
        actions.openInFileManager(sessionDir(state.cwd, selectedSessionId));
      } catch {
        notify(state, 'Failed to open session directory');
      }
      break;
    }

    case 'open-strategy': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      const editor = actions.resolveEditor();
      try {
        actions.openEditorPopup(state.cwd, editor, strategyPath(state.cwd, selectedSessionId));
      } catch {
        notify(state, 'Failed to open strategy');
      }
      break;
    }

    case 'open-roadmap': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      const editor = actions.resolveEditor();
      try {
        actions.openEditorPopup(state.cwd, editor, roadmapPath(state.cwd, selectedSessionId));
      } catch {
        notify(state, 'Failed to open roadmap');
      }
      break;
    }

    case 'search': {
      state.mode = 'search';
      state.searchText = '';
      requestRender();
      return;
    }

    case 'jump-to-session': {
      let count = 0;
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i]?.type === 'session') {
          count++;
          if (count === action.index) {
            state.cursorIndex = i;
            state.cursorNodeId = nodes[i]!.id;
            break;
          }
        }
      }
      break;
    }

    case 'spawn-agent': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      actions.composeViaPopup({ kind: 'spawn-agent', sessionId: selectedSessionId }, state, actions);
      break;
    }

    case 'message-agent': {
      const agent = actions.getAgentForNode(cursorNode);
      if (!agent) { notify(state, 'Cursor must be on an agent'); break; }
      actions.composeViaPopup({ kind: 'message-agent', sessionId: selectedSessionId!, agentId: agent.id }, state, actions);
      break;
    }

    case 'help':
      state.mode = 'help';
      requestRender();
      return;

    case 'enter-companion-menu':
      state.mode = 'companion-menu';
      requestRender();
      return;

    case 'companion-overlay':
      state.mode = 'companion-overlay';
      requestRender();
      return;

    case 'companion-debug':
      state.mode = 'companion-debug';
      requestRender();
      return;

    case 'companion-pane':
      try {
        actions.openCompanionPane(state.cwd);
      } catch {
        notify(state, 'Failed to open companion pane');
      }
      return;

    case 'shell-command': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      try {
        const text = actions.promptInPopup('$', { w: '80%' });
        if (text?.trim()) {
          actions.openShellPopup(state.cwd, text.trim());
        }
      } catch {
        notify(state, 'Failed to open prompt');
      }
      break;
    }

    case 'jump-to-pane': {
      const agent = actions.getAgentForNode(cursorNode);
      if (!agent?.paneId) { notify(state, 'Select an agent with an active pane'); break; }
      if (session?.tmuxSessionName) actions.switchToSession(session.tmuxSessionName);
      if (session?.tmuxWindowId) actions.selectWindow(session.tmuxWindowId);
      actions.selectPane(agent.paneId);
      break;
    }

    case 'export-session': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      exportSessionToZip(selectedSessionId, state.cwd)
        .then(outputPath => notify(state, `Exported to ${outputPath}`))
        .catch(err => notify(state, `Export failed: ${(err as Error).message}`));
      break;
    }

    case 'kill': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      const node = nodes[state.cursorIndex];
      if (node && (node.type === 'agent' || node.type === 'report')) {
        const agentId = node.agentId;
        const agent = agents.find((a) => a.id === agentId);
        if (agent?.status !== 'running') { notify(state, `Agent ${agentId} is not running`); break; }
        actions.sendAndNotify({ type: 'kill-agent', sessionId: selectedSessionId, agentId }, `Killed ${agentId}`);
      } else {
        actions.sendAndNotify({ type: 'kill', sessionId: selectedSessionId }, 'Session killed');
      }
      break;
    }

    case 'quit':
      actions.cleanup();
      return;

    case 'enter-open-menu':
      state.mode = 'open-menu';
      requestRender();
      return;

    case 'enter-agent-menu':
      state.mode = 'agent-menu';
      requestRender();
      return;

    case 'enter-session-menu':
      state.mode = 'session-menu';
      requestRender();
      return;

    case 'enter-go-menu':
      state.mode = 'go-menu';
      requestRender();
      return;

    case 'copy-latest-report': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      const latest = findLatestReport(state.cwd, selectedSessionId);
      if (!latest) { notify(state, 'No reports found'); break; }
      try {
        const content = readFileSync(latest, 'utf-8');
        actions.copyToClipboard(content);
        notify(state, `Copied latest report (${content.length} chars)`);
      } catch {
        notify(state, 'Failed to copy report');
      }
      break;
    }

    case 'copy-agent-id': {
      const agent = actions.getAgentForNode(cursorNode);
      if (!agent) { notify(state, 'Cursor must be on an agent'); break; }
      try {
        actions.copyToClipboard(agent.id);
        notify(state, `Copied agent ID (${agent.id})`);
      } catch {
        notify(state, 'Failed to copy to clipboard');
      }
      break;
    }

    case 'open-goal': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      const editor = actions.resolveEditor();
      try {
        actions.openEditorPopup(state.cwd, editor, goalPath(state.cwd, selectedSessionId));
      } catch {
        notify(state, 'Failed to open goal');
      }
      break;
    }

    case 'open-latest-report': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      const latest = findLatestReport(state.cwd, selectedSessionId);
      if (!latest) { notify(state, 'No reports found'); break; }
      const editor = actions.resolveEditor();
      try {
        actions.openEditorPopup(state.cwd, editor, latest);
      } catch {
        notify(state, 'Failed to open report');
      }
      break;
    }

    case 'open-scratch': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      const editor = actions.resolveEditor();
      try {
        actions.openEditorPopup(state.cwd, editor, join(sessionDir(state.cwd, selectedSessionId), 'scratch.md'));
      } catch {
        notify(state, 'Failed to open scratch');
      }
      break;
    }

    case 'edit-context-file': {
      if (!cursorNode || cursorNode.type !== 'context-file') { notify(state, 'Cursor must be on a context file'); break; }
      const editor = actions.resolveEditor();
      try {
        actions.openEditorPopup(state.cwd, editor, cursorNode.filePath);
      } catch {
        notify(state, 'Failed to open file in editor');
      }
      break;
    }

    case 'restart-agent': {
      const agent = actions.getAgentForNode(cursorNode);
      if (!agent || !selectedSessionId) { notify(state, 'Select an agent to restart'); break; }
      actions.sendAndNotify(
        { type: 'restart-agent', sessionId: selectedSessionId, agentId: agent.id },
        `Restarted ${agent.id}`,
      );
      break;
    }

    case 'rerun-agent': {
      const agent = actions.getAgentForNode(cursorNode);
      if (!agent || !selectedSessionId) { notify(state, 'Select an agent to re-run'); break; }
      actions.sendAndNotify(
        {
          type: 'spawn',
          sessionId: selectedSessionId,
          agentType: agent.agentType,
          name: `${agent.name}-retry`,
          instruction: agent.instruction,
        },
        `Re-spawned ${agent.name}`,
      );
      break;
    }

    case 'open-claude-agent': {
      const agent = actions.getAgentForNode(cursorNode);
      if (!agent) { notify(state, 'Cursor must be on an agent'); break; }
      if (!agent.claudeSessionId) { notify(state, 'No Claude session ID available'); break; }
      try {
        actions.openClaudeResumePopup(state.cwd, agent.claudeSessionId, agent.resumeEnv, agent.resumeArgs);
      } catch {
        notify(state, 'Failed to open Claude session');
      }
      break;
    }

    case 'tail-agent-logs': {
      const agent = actions.getAgentForNode(cursorNode);
      if (!agent) { notify(state, 'Cursor must be on an agent'); break; }
      if (!agent.paneId) { notify(state, 'Agent has no active pane'); break; }
      try {
        actions.openShellPopup(state.cwd, `tmux capture-pane -t ${agent.paneId} -p -S -2000 | less +G`);
      } catch {
        notify(state, 'Failed to open logs');
      }
      break;
    }

    case 'kill-agent': {
      const agent = actions.getAgentForNode(cursorNode);
      if (!agent || !selectedSessionId) { notify(state, 'Select an agent to kill'); break; }
      if (agent.status !== 'running') { notify(state, `Agent ${agent.id} is not running`); break; }
      actions.sendAndNotify({ type: 'kill-agent', sessionId: selectedSessionId, agentId: agent.id }, `Killed ${agent.id}`);
      break;
    }

    case 'quick-spawn-explore': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      const pasted = pasteFromClipboard();
      if ('reason' in pasted) {
        notify(state, pasted.reason);
        break;
      }
      const exploreInstruction = pasted.text.trim();
      if (exploreInstruction.length < 20) {
        notify(state, `Clipboard too short (${exploreInstruction.length} chars; need 20+)`);
        break;
      }
      actions.sendAndNotify(
        { type: 'spawn', sessionId: selectedSessionId, agentType: 'sisyphus:explore', name: `explore-${Date.now()}`, instruction: exploreInstruction },
        'Explore agent spawned',
      );
      break;
    }

    case 'quick-spawn-debug': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      const pasted = pasteFromClipboard();
      if ('reason' in pasted) {
        notify(state, pasted.reason);
        break;
      }
      const debugInstruction = pasted.text.trim();
      if (debugInstruction.length < 20) {
        notify(state, `Clipboard too short (${debugInstruction.length} chars; need 20+)`);
        break;
      }
      actions.sendAndNotify(
        { type: 'spawn', sessionId: selectedSessionId, agentType: 'sisyphus:debug', name: `debug-${Date.now()}`, instruction: debugInstruction },
        'Debug agent spawned',
      );
      break;
    }

    case 'new-session': {
      actions.composeViaPopup({ kind: 'new-session' }, state, actions);
      break;
    }

    case 'resume-session': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      if (session?.status === 'active' && state.paneAlive) { notify(state, 'Session already active'); break; }
      actions.composeViaPopup({ kind: 'resume', sessionId: selectedSessionId }, state, actions);
      break;
    }

    case 'continue-session': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      if (session?.status !== 'completed') { notify(state, 'Session not completed'); break; }
      actions.composeViaPopup({ kind: 'continue', sessionId: selectedSessionId }, state, actions);
      break;
    }

    case 'rollback': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      try {
        const text = actions.promptInPopup('Rollback to cycle:');
        if (text?.trim()) {
          const toCycle = parseInt(text.trim(), 10);
          if (isNaN(toCycle) || toCycle < 1) { notify(state, 'Invalid cycle number'); break; }
          actions.sendAndNotify(
            { type: 'rollback', sessionId: selectedSessionId, cwd: state.cwd, toCycle },
            `Rolled back to cycle ${toCycle} — use [R]esume to respawn`,
          );
        }
      } catch {
        notify(state, 'Failed to open prompt');
      }
      break;
    }

    case 'kill-session': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      actions.sendAndNotify({ type: 'kill', sessionId: selectedSessionId }, 'Session killed');
      break;
    }

    case 'go-to-window': {
      void goToSessionWindow(state, actions);
      break;
    }

    case 'clone-session': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      try {
        actions.openShellPopup(state.cwd, `sis session recover clone ${selectedSessionId}`);
      } catch {
        notify(state, 'Failed to open shell');
      }
      break;
    }

    case 'history': {
      try {
        actions.openShellPopup(state.cwd, 'sis session inspect history');
      } catch {
        notify(state, 'Failed to open shell');
      }
      break;
    }

    case 'pick-session': {
      try {
        actions.openShellPopup(state.cwd, 'sis pick-session');
      } catch {
        notify(state, 'Failed to open shell');
      }
      break;
    }

    case 'cycle-session': {
      try {
        actions.openShellPopup(state.cwd, 'sis cycle');
      } catch {
        notify(state, 'Failed to open shell');
      }
      break;
    }

    case 'reconnect': {
      try {
        actions.openShellPopup(state.cwd, 'sis session recover reconnect');
      } catch {
        notify(state, 'Failed to open shell');
      }
      break;
    }

    case 'message-orchestrator': {
      if (!selectedSessionId) { notify(state, 'No session selected'); break; }
      actions.composeViaPopup({ kind: 'message-orchestrator', sessionId: selectedSessionId }, state, actions);
      break;
    }

    case 'show-status': {
      try {
        actions.openShellPopup(state.cwd, `sis session inspect status${selectedSessionId ? ` ${selectedSessionId}` : ''}`);
      } catch {
        notify(state, 'Failed to open status');
      }
      break;
    }

    case 'dismiss':
      closeBadgeGallery();
      break;
  }

  state.mode = 'navigate';
  requestRender();
}

function handleOverlayKey(input: string, key: Key, state: AppState, actions: InputActions): void {
  if (state.mode === 'help') {
    if (key.escape || input === '?') { handleLeaderAction({ type: 'dismiss' }, state, actions); }
    // any other key: ignore
    return;
  }

  if (state.mode === 'companion-overlay') {
    if (input === '?') {
      if (getCompanionPage() === 'help') companionOverlayDismissHelp();
      else companionOverlayShowHelp();
      requestRender(); return;
    }
    if (key.escape) {
      if (getCompanionPage() === 'help') { companionOverlayDismissHelp(); requestRender(); return; }
      handleLeaderAction({ type: 'dismiss' }, state, actions); return;
    }
    if (key.tab) { companionOverlayNextPage(); requestRender(); return; }
    if (getCompanionPage() === 'badges') {
      if (key.upArrow || input === 'k') { badgeGalleryLeft(); requestRender(); return; }
      if (key.downArrow || input === 'j') { badgeGalleryRight(); requestRender(); return; }
      if (key.leftArrow || input === 'h') { badgeListScrollUp(); requestRender(); return; }
      if (key.rightArrow || input === 'l') { badgeListScrollDown(); requestRender(); return; }
    }
    // any other key: ignore
    return;
  }

  if (state.mode === 'companion-debug') {
    handleLeaderAction({ type: 'dismiss' }, state, actions);
  }
}

function handleLeaderKey(input: string, key: Key, state: AppState, actions: InputActions): void {
  // Overlay modes (help, companion-overlay, companion-debug) are not in KEYMAP
  if (state.mode === 'help' || state.mode === 'companion-overlay' || state.mode === 'companion-debug') {
    return handleOverlayKey(input, key, state, actions);
  }

  if (key.escape) { handleLeaderAction({ type: 'dismiss' }, state, actions); return; }

  const menuId = MENU_FOR_MODE[state.mode];
  if (!menuId) return;

  const menu = menuId === 'topLevel' ? KEYMAP.topLevel : KEYMAP.submenus[menuId]!;
  const item = menu.items.find(i => i.key === input);
  if (!item) {
    // Digit 1-9: jump to session — only at top level
    if (state.mode === 'leader') {
      const digit = parseInt(input, 10);
      if (digit >= 1 && digit <= 9) {
        handleLeaderAction({ type: 'jump-to-session', index: digit }, state, actions);
        return;
      }
    }
    handleLeaderAction({ type: 'dismiss' }, state, actions);
    return;
  }
  dispatchItem(item, state, actions);
}

// Returns the scroll object that j/k should drive when detail pane is focused in stacked mode,
// or null when the caller should fall through to normal tree/logs scroll logic.
function getActiveDetailScroll(state: AppState) {
  if (state.focusPane !== 'detail' || !state.useStackedDetail) return null;
  if (state.detailMode === 'cycle-log') return state.detailScroll;
  return state.focusedStrip === 'goal' ? state.goalScroll
    : state.focusedStrip === 'strategy' ? state.strategyScroll
    : state.roadmapScroll;
}

// ── handleResolutionKey ───────────────────────────────────────────────────────
// Layered-key precedence (load-bearing):
// 1. esc steps back one level *inside* the deck (comment mode → card,
//    card → overview) while the deck has somewhere to go; only an esc at the
//    deck's top level (overview, no comment input) tears resolution mode down.
// 2. Shift+J/K queue walk, gated by canAcceptHostKeys
// 3. space/R visual gen/toggle, gated by canAcceptHostKeys
// 4. fall-through to humanloop

function handleResolutionKey(input: string, key: Key, state: AppState, actions: InputActions): void {
  const handle = state.resolutionHandle;
  if (!handle) return;

  // 1. esc → step back inside the deck, or unmount if already at the top.
  //    Partial answers are persisted to progress.json on every change, so
  //    unmounting never loses them (re-entry resumes via tryResume).
  if (key.escape) {
    if (!handle.atDeckTop()) {
      handle.handleKey(input, key);
      requestRender();
      return;
    }
    handle.unmount();
    return;
  }

  // 2. Shift+J / Shift+K → queue walk (only when humanloop can accept host keys)
  if (input === 'J' && handle.canAcceptHostKeys()) {
    handle.advanceQueue(+1);
    return;
  }
  if (input === 'K' && handle.canAcceptHostKeys()) {
    handle.advanceQueue(-1);
    return;
  }

  // 3. space → toggle visual / fire generation (gated)
  if (input === ' ' && handle.canAcceptHostKeys()) {
    handle.spaceVisualToggle();
    return;
  }

  // 4. R → force regenerate visual (gated)
  if (input === 'R' && handle.canAcceptHostKeys()) {
    handle.regenerateVisual();
    return;
  }

  // 5. Fall-through to humanloop
  handle.handleKey(input, key);
  requestRender();
}

// ── handleInlineDeckKey ───────────────────────────────────────────────────────
// Same layered precedence as handleResolutionKey, but bound to state.inlineDeck.
// Esc unmounts and moves the tree cursor off needs-you-virtual (to the first
// session, else the next node below it, else nodes[0]); stabilizeCursor resolves
// the index on the next render.

function handleInlineDeckKey(input: string, key: Key, state: AppState, actions: InputActions): void {
  const handle = state.inlineDeck;
  if (!handle) return;

  // 1. esc → step back inside the deck (comment mode → card → overview); only
  //    an esc at the deck's top level unmounts and moves the tree cursor off
  //    needs-you-virtual. Partial answers persist to progress.json regardless.
  if (key.escape) {
    if (!handle.atDeckTop()) {
      handle.handleKey(input, key);
      requestRender();
      return;
    }
    handle.unmount();
    const nodes = actions.getNodes();
    const i = nodes.findIndex((n) => n.id === 'needs-you-virtual');
    const next = nodes.find((n) => n.type === 'session') ?? nodes[i + 1] ?? nodes[0];
    state.cursorNodeId = next?.id ?? null;
    state.focusPane = 'tree';
    requestRender();
    return;
  }

  // 2. Shift+Tab → step focus back to the tree (reverse of Tab/→ in). Deck
  //    stays mounted so partial progress survives; Tab/→ re-engages it.
  if (key.tab && key.shift) {
    state.focusPane = 'tree';
    requestRender();
    return;
  }

  // 3. Shift+J / Shift+K → queue walk (gated)
  if (input === 'J' && handle.canAcceptHostKeys()) {
    handle.advanceQueue(+1);
    return;
  }
  if (input === 'K' && handle.canAcceptHostKeys()) {
    handle.advanceQueue(-1);
    return;
  }

  // 4. space → toggle visual / fire generation (gated)
  if (input === ' ' && handle.canAcceptHostKeys()) {
    handle.spaceVisualToggle();
    return;
  }

  // 5. R → force regenerate visual (gated)
  if (input === 'R' && handle.canAcceptHostKeys()) {
    handle.regenerateVisual();
    return;
  }

  // 6. Fall-through to humanloop
  handle.handleKey(input, key);
  requestRender();
}

// ── Focus cycle ───────────────────────────────────────────────────────────────
// Tab / Shift-Tab walks an ordered list of focus stops. In stacked gsr mode,
// the detail pane expands into three strip stops (goal/strategy/roadmap).

type FocusStop = {
  pane: AppState['focusPane'];
  strip?: AppState['focusedStrip'];
};

function focusCycle(state: AppState): FocusStop[] {
  const stops: FocusStop[] = [{ pane: 'tree' }];
  if (state.useStackedDetail && state.detailMode === 'gsr') {
    stops.push({ pane: 'detail', strip: 'goal' });
    stops.push({ pane: 'detail', strip: 'strategy' });
    stops.push({ pane: 'detail', strip: 'roadmap' });
  } else {
    stops.push({ pane: 'detail', ...(state.useStackedDetail ? { strip: 'goal' as const } : {}) });
  }
  stops.push({ pane: 'logs' });
  return stops;
}

function currentFocusIndex(stops: FocusStop[], state: AppState): number {
  const exact = stops.findIndex(
    (s) => s.pane === state.focusPane && (s.strip === undefined || s.strip === state.focusedStrip),
  );
  if (exact !== -1) return exact;
  const fuzzy = stops.findIndex((s) => s.pane === state.focusPane);
  return fuzzy === -1 ? 0 : fuzzy;
}

// ── handleNavigateKey ─────────────────────────────────────────────────────────

function handleNavigateKey(input: string, key: Key, state: AppState, actions: InputActions): void {
  const nodes = actions.getNodes();
  const cursorNode = actions.getCursorNode();
  const session = state.selectedSession;

  // k / ↑
  if (key.upArrow || input === 'k') {
    const upScroll = getActiveDetailScroll(state);
    if (upScroll) {
      upScroll.scrollBy(-1);
    } else if (state.focusPane === 'detail') {
      state.detailScroll.scrollBy(-1);
    } else if (state.focusPane === 'logs') {
      state.digestScroll.scrollBy(-1);
    } else {
      state.cursorIndex = Math.max(0, state.cursorIndex - 1);
      state.cursorNodeId = nodes[state.cursorIndex]?.id ?? state.cursorNodeId;
      requestRender();
    }
    return;
  }

  // j / ↓
  if (key.downArrow || input === 'j') {
    const downScroll = getActiveDetailScroll(state);
    if (downScroll) {
      downScroll.scrollBy(1);
    } else if (state.focusPane === 'detail') {
      state.detailScroll.scrollBy(1);
    } else if (state.focusPane === 'logs') {
      state.digestScroll.scrollBy(1);
    } else {
      state.cursorIndex = Math.min(nodes.length - 1, state.cursorIndex + 1);
      state.cursorNodeId = nodes[state.cursorIndex]?.id ?? state.cursorNodeId;
      requestRender();
    }
    return;
  }

  // u / d — fast scroll (vim-style ½-page) for detail/log strips. Tree focus
  // intentionally ignores these so cursor navigation stays single-step (j/k).
  // Roughly half the visible terminal height, clamped to a sensible band so a
  // tiny terminal still moves and a tall one doesn't leap past the strip.
  if (input === 'u' || input === 'd') {
    const direction = input === 'u' ? -1 : 1;
    const fastStep = Math.max(5, Math.min(20, Math.floor(state.rows / 4))) * direction;
    const fastScroll = getActiveDetailScroll(state);
    if (fastScroll) {
      fastScroll.scrollBy(fastStep);
      return;
    }
    if (state.focusPane === 'detail') {
      state.detailScroll.scrollBy(fastStep);
      return;
    }
    if (state.focusPane === 'logs') {
      state.digestScroll.scrollBy(fastStep);
      return;
    }
    return;
  }

  // h / ←
  if (key.leftArrow || input === 'h') {
    if (state.focusPane === 'logs') {
      state.focusPane = 'detail';
      requestRender();
      return;
    }
    if (state.focusPane === 'detail') {
      state.focusPane = 'tree';
      requestRender();
      return;
    }
    const node = nodes[state.cursorIndex];
    if (!node) return;
    if (node.expanded) {
      state.expanded.delete(node.id);
      requestRender();
    } else {
      const parentIdx = findParentIndex(nodes, state.cursorIndex);
      if (parentIdx !== state.cursorIndex) {
        state.cursorIndex = parentIdx;
        state.cursorNodeId = nodes[parentIdx]?.id ?? state.cursorNodeId;
        requestRender();
      }
    }
    return;
  }

  // l / →
  if (key.rightArrow || input === 'l') {
    const node = nodes[state.cursorIndex];
    if (!node) return;
    // Inline inbox deck: → / l focuses the detail pane so the deck takes keys
    // (mirrors Tab; needs-you-virtual is non-expandable so → is otherwise a no-op).
    if (node.type === 'needs-you-virtual' && state.focusPane === 'tree') {
      state.focusPane = 'detail';
      requestRender();
      return;
    }
    // When stacked detail active and cursor is on an already-expanded session in tree focus,
    // toggle between gsr and cycle-log detail mode instead of moving into child.
    if (
      state.useStackedDetail &&
      state.focusPane === 'tree' &&
      node.type === 'session' &&
      node.expanded
    ) {
      state.detailMode = state.detailMode === 'gsr' ? 'cycle-log' : 'gsr';
      state.cachedStackedLines = null;
      state.stackedCacheKey = '';
      requestRender();
      return;
    }
    if (node.expandable && !node.expanded) {
      state.expanded.add(node.id);
      expandSessionLatestCycle(state, node);
      requestRender();
    } else if (node.expandable && node.expanded) {
      // Move cursor to first child
      if (state.cursorIndex + 1 < nodes.length && nodes[state.cursorIndex + 1]!.depth > node.depth) {
        state.cursorIndex += 1;
        state.cursorNodeId = nodes[state.cursorIndex]?.id ?? state.cursorNodeId;
        requestRender();
      }
    }
    return;
  }

  // tab / shift+tab: walk the focus cycle forward / backward
  if (key.tab) {
    const stops = focusCycle(state);
    const idx = currentFocusIndex(stops, state);
    const next = stops[(idx + (key.shift ? -1 : 1) + stops.length) % stops.length]!;
    state.focusPane = next.pane;
    if (next.strip) state.focusedStrip = next.strip;
    requestRender();
    return;
  }

  // space: enter leader mode
  if (input === ' ') {
    state.mode = 'leader';
    requestRender();
    return;
  }

  // enter: expand / report-detail / open context file / resolution mode
  if (key.return) {
    const node = nodes[state.cursorIndex];
    if (!node) return;
    if (node.expandable && !node.expanded) {
      state.expanded.add(node.id);
      expandSessionLatestCycle(state, node);
      requestRender();
    } else if (node.type === 'report') {
      state.targetAgentId = node.agentId;
      state.mode = 'report-detail';
      requestRender();
    } else if (node.type === 'context-file') {
      const editor = actions.resolveEditor();
      try {
        actions.openEditorPopup(state.cwd, editor, node.filePath);
      } catch {
        notify(state, 'Failed to open file in editor');
      }
    }
    return;
  }

  // m: message orchestrator
  if (input === 'm') {
    if (!state.selectedSessionId) { notify(state, 'No session selected'); return; }
    actions.composeViaPopup({ kind: 'message-orchestrator', sessionId: state.selectedSessionId }, state, actions);
    return;
  }

  // w: go to tmux window (or resume orchestrator Claude session if window is dead/completed)
  if (input === 'w') {
    void goToSessionWindow(state, actions);
    return;
  }

  // o: open/resume claude session for agent or orchestrator cycle
  if (input === 'o') {
    if (!cursorNode) { notify(state, 'No node selected'); return; }
    let claudeSessionId: string | undefined;
    let resumeEnv: string | undefined;
    let resumeArgs: string | undefined;
    if (cursorNode.type === 'agent' || cursorNode.type === 'report') {
      const agent = actions.getAgentForNode(cursorNode);
      claudeSessionId = agent?.claudeSessionId ?? undefined;
      resumeEnv = agent?.resumeEnv;
      resumeArgs = agent?.resumeArgs;
    } else if (cursorNode.type === 'cycle' && session) {
      const cycle = session.orchestratorCycles.find(c => c.cycle === cursorNode.cycleNumber);
      claudeSessionId = cycle?.claudeSessionId;
      resumeEnv = cycle?.resumeEnv;
      resumeArgs = cycle?.resumeArgs;
    }
    if (!claudeSessionId) { notify(state, 'No Claude session ID available'); return; }
    try {
      actions.openClaudeResumePopup(state.cwd, claudeSessionId, resumeEnv, resumeArgs);
    } catch {
      notify(state, 'Failed to open Claude session');
    }
    return;
  }

  // g: edit goal
  if (input === 'g') {
    if (!state.selectedSessionId) { notify(state, 'No session selected'); return; }
    const gp = goalPath(state.cwd, state.selectedSessionId);
    const editor = actions.resolveEditor();
    try {
      actions.openEditorPopup(state.cwd, editor, gp, { w: '80', h: '50%' });
    } catch {
      notify(state, `Failed to open goal in ${editor}`);
    }
    return;
  }

  // n: new session
  if (input === 'n') {
    actions.composeViaPopup({ kind: 'new-session' }, state, actions);
    return;
  }

  // c: open companion pane
  if (input === 'c') {
    try {
      actions.openCompanionPane(state.cwd);
    } catch {
      notify(state, 'Failed to open companion pane');
    }
    return;
  }

  // p: open plan/roadmap
  if (input === 'p') {
    if (!state.selectedSessionId) { notify(state, 'No session selected'); return; }
    const pp = roadmapPath(state.cwd, state.selectedSessionId);
    const editor = actions.resolveEditor();
    try {
      actions.openEditorPopup(state.cwd, editor, pp);
    } catch {
      notify(state, `Failed to open roadmap in ${editor}`);
    }
    return;
  }

  // q: quit
  if (input === 'q') {
    actions.cleanup();
  }

  // r: re-run agent
  if (input === 'r') {
    const agent = actions.getAgentForNode(cursorNode);
    if (!agent || !state.selectedSessionId) { notify(state, 'Select an agent to re-run'); return; }
    actions.sendAndNotify(
      {
        type: 'spawn',
        sessionId: state.selectedSessionId,
        agentType: agent.agentType,
        name: `${agent.name}-retry`,
        instruction: agent.instruction,
      },
      `Re-spawned ${agent.name}`,
    );
    return;
  }

  // R: resume session
  if (input === 'R') {
    if (!state.selectedSessionId) { notify(state, 'No session selected'); return; }
    if (session?.status === 'active' && state.paneAlive) { notify(state, 'Session already active'); return; }
    actions.composeViaPopup({ kind: 'resume', sessionId: state.selectedSessionId }, state, actions);
    return;
  }

  // C: continue session
  if (input === 'C') {
    if (!state.selectedSessionId) { notify(state, 'No session selected'); return; }
    if (session?.status !== 'completed') { notify(state, 'Session not completed'); return; }
    actions.composeViaPopup({ kind: 'continue', sessionId: state.selectedSessionId }, state, actions);
    return;
  }

  // x: restart agent
  if (input === 'x') {
    const agent = actions.getAgentForNode(cursorNode);
    if (!agent || !state.selectedSessionId) { notify(state, 'Select an agent to restart'); return; }
    actions.sendAndNotify(
      { type: 'restart-agent', sessionId: state.selectedSessionId, agentId: agent.id },
      `Restarted ${agent.id}`,
    );
    return;
  }

  // b: rollback to cycle
  if (input === 'b') {
    if (!state.selectedSessionId) { notify(state, 'No session selected'); return; }
    {
      const sessionId = state.selectedSessionId;
      try {
        const text = actions.promptInPopup('Rollback to cycle:');
        if (text?.trim()) {
          const toCycle = parseInt(text.trim(), 10);
          if (isNaN(toCycle) || toCycle < 1) { notify(state, 'Invalid cycle number'); return; }
          actions.sendAndNotify(
            { type: 'rollback', sessionId, cwd: state.cwd, toCycle },
            `Rolled back to cycle ${toCycle} — use [R]esume to respawn`,
          );
        }
      } catch {
        notify(state, 'Failed to open prompt');
      }
    }
    return;
  }

  // e: edit context file
  if (input === 'e') {
    if (!cursorNode || cursorNode.type !== 'context-file') return;
    const editor = actions.resolveEditor();
    try {
      actions.openEditorPopup(state.cwd, editor, cursorNode.filePath);
    } catch {
      notify(state, 'Failed to open file in editor');
    }
    return;
  }

  // S: edit strategy
  if (input === 'S') {
    if (!state.selectedSessionId) { notify(state, 'No session selected'); return; }
    const sp = strategyPath(state.cwd, state.selectedSessionId);
    const editor = actions.resolveEditor();
    try {
      actions.openEditorPopup(state.cwd, editor, sp);
    } catch {
      notify(state, `Failed to open strategy in ${editor}`);
    }
    return;
  }

  // F: toggle cycle flow expanded/collapsed
  if (input === 'F') {
    state.flowExpanded = !state.flowExpanded;
    state.cachedDetailLines = null;
    state.cachedDigestLines = null;
    state.cachedStackedLines = null;
    state.stackedCacheKey = '';
    requestRender();
    return;
  }

  // D: toggle DANGEROUS mode for the selected session (auto-accept default for every ask)
  if (input === 'D') {
    const sessionId = state.selectedSessionId;
    const session = state.selectedSession;
    if (!sessionId || !session) { notify(state, 'No session selected'); return; }
    const next = !(session.dangerousMode === true);
    session.dangerousMode = next;
    requestRender();
    void (async () => {
      try {
        const res = await actions.send({ type: 'set-dangerous-mode', sessionId, enabled: next });
        if (!res.ok) {
          if (state.selectedSession === session) session.dangerousMode = !next;
          notify(state, `Dangerous mode toggle failed: ${res.error}`);
          requestRender();
          return;
        }
        const flushed = (res.data?.['flushed'] as number | undefined) ?? 0;
        notify(state, next
          ? (flushed > 0 ? `DANGEROUS mode ON — ${flushed} pending ask(s) auto-resolved` : 'DANGEROUS mode ON')
          : 'DANGEROUS mode OFF');
      } catch (err) {
        if (state.selectedSession === session) session.dangerousMode = !next;
        notify(state, `Dangerous mode toggle failed: ${(err as Error).message}`);
        requestRender();
      }
    })();
    return;
  }

  // /: search (vim-like, direct from navigate)
  if (input === '/') {
    state.mode = 'search';
    state.searchText = '';
    requestRender();
    return;
  }

}

// ── handleSearchKey ──────────────────────────────────────────────────────────

function handleSearchKey(input: string, key: Key, state: AppState): void {
  if (key.return) {
    // Lock in the current filter
    state.mode = 'navigate';
    requestRender();
    return;
  }

  if (key.escape) {
    // Clear filter and exit
    state.searchFilter = null;
    state.searchText = '';
    state.mode = 'navigate';
    requestRender();
    return;
  }

  if (key.backspace) {
    state.searchText = state.searchText.slice(0, -1);
    state.searchFilter = state.searchText || null;
    requestRender();
    return;
  }

  // Ignore control keys
  if (key.ctrl || key.meta || !input || input.length !== 1) return;

  state.searchText += input;
  state.searchFilter = state.searchText;
  requestRender();
}

// ── Main dispatch ─────────────────────────────────────────────────────────────

export function handleKeypress(input: string, key: Key, state: AppState, actions: InputActions): void {
  // Resolution mode intercepts all keys (before mode checks — esc always exits)
  if (state.resolutionActive) {
    handleResolutionKey(input, key, state, actions);
    return;
  }
  // Review panel owns the keystream only when the detail pane is focused and
  // the focused inbox item is kind='review'. Esc is handled here (unmounts panel
  // and returns focus to tree); all other keys route to the panel's handleKey
  // first and fall through on false.
  if (
    state.reviewPanel &&
    state.focusPane === 'detail' &&
    actions.getCursorNode()?.type === 'needs-you-virtual'
  ) {
    if (key.escape) {
      state.reviewPanel = null;
      state.focusPane = 'tree';
      requestRender();
      return;
    }
    if (key.tab && key.shift) {
      state.focusPane = 'tree';
      requestRender();
      return;
    }
    const consumed = state.reviewPanel.handleKey(input);
    if (consumed) {
      requestRender();
      return;
    }
    // Not consumed — fall through to normal navigation below.
  }

  // Inline inbox deck owns the keystream only when the detail pane is focused
  // (Tab/→ into it). While focus is on the tree, j/k pass through so the cursor
  // can move past needs-you-virtual without the deck trapping navigation.
  if (
    state.inlineDeck &&
    state.focusPane === 'detail' &&
    actions.getCursorNode()?.type === 'needs-you-virtual'
  ) {
    handleInlineDeckKey(input, key, state, actions);
    return;
  }
  if (state.mode === 'search') {
    handleSearchKey(input, key, state);
  } else if (state.mode === 'leader' || state.mode === 'copy-menu' || state.mode === 'open-menu' || state.mode === 'agent-menu' || state.mode === 'session-menu' || state.mode === 'go-menu' || state.mode === 'companion-menu' || state.mode === 'help' || state.mode === 'companion-overlay' || state.mode === 'companion-debug') {
    handleLeaderKey(input, key, state, actions);
  } else if (state.mode === 'report-detail') {
    handleReportDetailKey(input, key, state, actions);
  } else {
    handleNavigateKey(input, key, state, actions);
  }
}
