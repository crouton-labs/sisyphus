import stringWidth from 'string-width';
import { readFileSync } from 'node:fs';
import { clipAnsi, type Rect } from '../render.js';
import { type AppState, requestRender } from '../state.js';
import { send } from '../lib/client.js';
import { paneExists, switchToSession, selectWindow, selectPane } from '../lib/tmux.js';
import {
  mountResolutionPanel,
  makeOrphanTakeover,
  type MountedResolutionHandle,
} from './mounted-humanloop.js';
import { kindIcon, kindColor, formatTimeAgo, truncate, ansiDim, ansiColor } from '../lib/format.js';
import { cwdFromDir, sessionIdFromDir, askIdFromDir } from '../../shared/inbox-types.js';
import { askReviewDraftPath, askReviewPath } from '../../shared/paths.js';
import { mountReviewActionPanel } from './review-action.js';

// Dimensions the live handle was last mounted/resized at. Reset to null
// whenever no handle is mounted so a fresh mount re-establishes them.
let lastMountDims: { cols: number; rows: number } | null = null;

function mountInlineDeck(
  state: AppState,
  cols: number,
  rows: number,
): MountedResolutionHandle | null {
  return mountResolutionPanel(
    {
      aggregateInbox: state.aggregateInbox,
      startIndex: 0,
      cols,
      rows,
      daemonSend: send,
      onUnmount: () => {
        state.inlineDeck = null;
        state.visuals.clear();
        // Whenever the deck goes away (queue drained, ask vanished, Esc,
        // cursor-leave) return focus to the session tree so navigation resumes.
        state.focusPane = 'tree';
        requestRender();
      },
      onOrphanTakeover: makeOrphanTakeover(state, {
        send,
        paneExists,
        switchToSession,
        selectWindow,
        selectPane,
      }),
    },
    state,
  );
}

/**
 * Read the comment count from a review draft file, returning 0 on any error.
 */
function readDraftCommentCount(cwd: string, sessionId: string, askId: string): number {
  try {
    const raw = readFileSync(askReviewDraftPath(cwd, sessionId, askId), 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (Array.isArray(data['comments'])) return data['comments'].length;
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Verify the review.json exists and return the file path, or null.
 */
function readReviewFile(cwd: string, sessionId: string, askId: string): string | null {
  try {
    const raw = readFileSync(askReviewPath(cwd, sessionId, askId), 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data['file'] === 'string') return data['file'];
    return null;
  } catch {
    return null;
  }
}

/**
 * Render the review-action panel in place of the humanloop deck when the
 * focused inbox item has kind === 'review'. Lazily mounts state.reviewPanel.
 */
function renderReviewPanel(
  rect: Rect,
  state: AppState,
  item: (typeof state.aggregateInbox)[0],
): string[] {
  const blank = clipAnsi('', rect.w);
  const cwd = cwdFromDir(item.dir);
  const sessionId = sessionIdFromDir(item.dir);
  const askId = askIdFromDir(item.dir);

  const reviewFile = readReviewFile(cwd, sessionId, askId);

  // Unmount stale panel if the askId changed (user navigated to a different review).
  const panelAskId = (state.reviewPanel as unknown as { _askId?: string } | null)?._askId;
  if (state.reviewPanel && panelAskId !== askId) {
    state.reviewPanel = null;
  }

  if (!state.reviewPanel) {
    if (!reviewFile) {
      // review.json missing — render a one-line error row and let the user Esc out.
      const rows: string[] = [];
      const mid = Math.floor(rect.h / 2);
      for (let i = 0; i < rect.h; i++) {
        rows.push(i === mid
          ? clipAnsi(ansiColor('[review.json not found — Esc to dismiss]', 'red'), rect.w)
          : blank);
      }
      return rows;
    }

    const draftCommentCount = readDraftCommentCount(cwd, sessionId, askId);
    const panel = mountReviewActionPanel({
      cwd,
      sessionId,
      askId,
      reviewFile,
      blockedSince: item.blockedSince,
      draftCommentCount,
      onAfterAction: () => {
        // Unmount panel; outer render loop will re-evaluate inbox on next poll.
        state.reviewPanel = null;
        state.focusPane = 'tree';
        requestRender();
      },
    });
    // Tag the panel with its askId so we can detect staleness above.
    (panel as unknown as Record<string, unknown>)['_askId'] = askId;
    state.reviewPanel = panel;
  }

  const panelRows = state.reviewPanel.render(rect.w, rect.h);
  const result: string[] = [];
  for (let i = 0; i < rect.h; i++) {
    const line = panelRows[i];
    result.push(clipAnsi(line !== undefined ? line : '', rect.w));
  }
  return result;
}

/**
 * Borderless inline inbox deck. Replaces the cross-session inbox list when the
 * cursor is on `needs-you-virtual`: lazily mounts a resolution handle on the
 * oldest pending ask, draws a 3-row header, then the deck/visual body. Every
 * emitted row is hard-clipped to `rect.w` so panel concatenation stays aligned.
 */
export function renderInboxDeckRows(rect: Rect, state: AppState): string[] {
  if (rect.w <= 0 || rect.h <= 0) {
    return Array.from({ length: Math.max(0, rect.h) }, () => clipAnsi('', rect.w));
  }

  // No live handle → re-establish dims on next mount.
  if (!state.inlineDeck) lastMountDims = null;

  const blank = clipAnsi('', rect.w);

  const emptyState = (): string[] => {
    const rows: string[] = [];
    const mid = Math.floor(rect.h / 2);
    const msg = 'No pending asks';
    const pad = Math.max(0, Math.floor((rect.w - msg.length) / 2));
    for (let i = 0; i < rect.h; i++) {
      rows.push(i === mid ? clipAnsi(' '.repeat(pad) + ansiDim(msg), rect.w) : blank);
    }
    return rows;
  };

  // Empty inbox → empty state, never mount.
  if (state.aggregateInbox.length === 0) {
    return emptyState();
  }

  // Check if the oldest pending item is a review kind — if so, render the
  // review-action panel instead of the humanloop inline deck.
  const firstItem = state.aggregateInbox[0]!;
  if (firstItem.kind === 'review') {
    return renderReviewPanel(rect, state, firstItem);
  }

  const HEADER = 3;
  const bodyRows = Math.max(1, rect.h - HEADER);

  if (!state.inlineDeck) {
    // Lazy mount on the oldest pending ask. Queue-stability rule: a live handle
    // is never re-pointed; remount predicate is purely `!state.inlineDeck`.
    const handle = mountInlineDeck(state, rect.w, bodyRows);
    state.inlineDeck = handle;
    lastMountDims = handle ? { cols: rect.w, rows: bodyRows } : null;
    if (!state.inlineDeck) return emptyState();
  } else if (
    !lastMountDims ||
    lastMountDims.cols !== rect.w ||
    lastMountDims.rows !== bodyRows
  ) {
    // Terminal/layout resize → reflow the live deck.
    state.inlineDeck.handleResize(rect.w, bodyRows);
    lastMountDims = { cols: rect.w, rows: bodyRows };
  }

  const handle = state.inlineDeck;
  const info = handle.getHeaderInfo();

  // Row 0 — icon + position + session + askedBy + age + title. Compute the
  // plain prefix width to budget the title; clipAnsi is the hard backstop.
  const icon = kindIcon(info.kind);
  const iconColor = kindColor(info.kind);
  let prefixPlain = ` ${icon} Ask ${info.currentIndex + 1}/${info.queueLength} · ${info.sessionName ?? '?'}`;
  if (info.askedBy) prefixPlain += ` · ${info.askedBy}`;
  prefixPlain += ` · ${formatTimeAgo(info.blockedSince)} — `;
  const prefixDisplayWidth = stringWidth(prefixPlain);
  const T = Math.max(8, rect.w - prefixDisplayWidth - 3);
  const title = truncate(info.askTitle ?? '', T);
  let line1 = ` ${ansiColor(icon, iconColor)} Ask ${info.currentIndex + 1}/${info.queueLength} · ${info.sessionName ?? '?'}`;
  if (info.askedBy) line1 += ` · ${info.askedBy}`;
  line1 += ` · ${formatTimeAgo(info.blockedSince)} — ${title}`;
  const row0 = clipAnsi(line1, rect.w);

  // Row 1 — subtitle or blank.
  const row1 = clipAnsi(info.subtitle ? ' ' + ansiDim(info.subtitle) : '', rect.w);

  // Row 2 — blank separator.
  const row2 = blank;

  // Rows 3..h-1 — visual-replacement branch mirroring renderResolutionFrame
  // (src/tui/app.ts:155-184) so Space/R behave identically in-panel.
  const qid = handle.getCurrentQid();
  const visualEntry = qid ? state.visuals.get(qid) : undefined;
  const body: string[] = [];
  if (visualEntry?.visible && visualEntry.status === 'ready') {
    const visualLines = visualEntry.content.split('\n');
    for (let i = 0; i < bodyRows; i++) {
      body.push(clipAnsi(i < visualLines.length ? visualLines[i]! : '', rect.w));
    }
  } else {
    const humanloopLines = handle.render();
    const midRow = Math.floor(bodyRows / 2);
    for (let i = 0; i < bodyRows; i++) {
      if (visualEntry?.visible && visualEntry.status === 'loading' && i === midRow) {
        const placeholderText = '[generating visual… ~30s]';
        const padL = Math.max(0, Math.floor((rect.w - placeholderText.length) / 2));
        body.push(clipAnsi(' '.repeat(padL) + ansiDim(placeholderText), rect.w));
      } else if (visualEntry?.visible && visualEntry.status === 'error' && i === midRow) {
        const errText = visualEntry.error ? visualEntry.error : 'unknown';
        body.push(
          clipAnsi(
            ansiColor(`[visual error: ${errText}]`, 'red') + ansiDim('  [R] retry'),
            rect.w,
          ),
        );
      } else {
        body.push(clipAnsi(i < humanloopLines.length ? humanloopLines[i]! : '', rect.w));
      }
    }
  }

  const rows: string[] = [row0, row1, row2];
  for (let i = 0; i < bodyRows && rows.length < rect.h; i++) {
    rows.push(body[i]!);
  }
  while (rows.length < rect.h) rows.push(blank);
  return rows.slice(0, rect.h);
}
