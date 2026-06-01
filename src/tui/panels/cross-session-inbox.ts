import { buildPanelRows, buildEmptyPanelRows, type Rect } from '../render.js';
import type { AppState } from '../state.js';
import {
  seg, singleLine, formatTimeAgo, truncate, kindIcon, kindColor, type DetailLine,
} from '../lib/format.js';
import { coerceKind, type InboxItem, sessionIdFromDir, askIdFromDir } from '../../shared/inbox-types.js';

function buildInboxLines(items: (InboxItem & { sessionName?: string })[], width: number): DetailLine[] {
  const lines: DetailLine[] = [];
  if (items.length === 0) {
    lines.push(singleLine(' No pending asks', { dim: true, italic: true }));
    return lines;
  }
  lines.push(singleLine(` ${items.length} pending`, { bold: true }));
  lines.push(singleLine(' '));
  const contentWidth = width - 4;
  for (const item of items) {
    const kindKey = coerceKind(item.kind);
    const icon = kindIcon(kindKey);
    const iconColor = kindColor(kindKey);
    const sessionId = sessionIdFromDir(item.dir);
    const source = item.sessionName ? item.sessionName : sessionId.slice(0, 8);
    const askId = askIdFromDir(item.dir);
    const titleText = item.title ? item.title : `(${askId.slice(0, 8)})`;
    const blocked = formatTimeAgo(item.blockedSince);
    const maxTitle = Math.max(10, contentWidth - source.length - blocked.length - 8);
    lines.push([
      seg('  '),
      seg(icon, { color: iconColor }),
      seg(` ${source}`, { color: 'yellow' }),
      seg(' · ', { dim: true }),
      seg(truncate(titleText, maxTitle), { bold: true }),
      seg(`  ${blocked}`, { dim: true }),
    ]);
    if (item.subtitle) {
      lines.push(singleLine(`      ${truncate(item.subtitle, contentWidth - 6)}`, { dim: true }));
    }
  }
  return lines;
}

export function renderCrossSessionInboxRows(rect: Rect, state: AppState): string[] {
  if (rect.w <= 0 || rect.h <= 0) {
    return buildEmptyPanelRows(rect, state.focusPane === 'detail', 'red', '');
  }
  const focused = state.focusPane === 'detail';
  const items = state.aggregateInbox;
  const fingerprint = items.map(i => `${askIdFromDir(i.dir)}:${i.blockedSince}`).join(',');
  const cacheKey = `${items.length}:${fingerprint}:${rect.w}`;
  let lines: DetailLine[];
  if (cacheKey === state.inboxCacheKey && state.cachedInboxLines !== null) {
    lines = state.cachedInboxLines;
  } else {
    lines = buildInboxLines(items, rect.w);
    state.cachedInboxLines = lines;
    state.inboxCacheKey = cacheKey;
  }
  return buildPanelRows(rect, lines, state.crossSessionInboxScroll, focused, 'red', state.inboxRenderedCache);
}
