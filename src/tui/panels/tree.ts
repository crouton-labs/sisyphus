import stringWidth from 'string-width';
import type { FrameBuffer, Rect } from '../render.js';
import { drawBorder, writeClipped, colorToSGR } from '../render.js';
import { renderCompanion, getMoodAnsiCode } from '../../shared/companion-render.js';
import type { CompanionField, CompanionState } from '../../shared/companion-types.js';
import type { TreeNode } from '../types/tree.js';
import { renderTreePrefix } from '../lib/tree-render.js';
import {
  statusColor,
  statusIndicator,
  agentStatusIcon,
  truncate,
  formatDuration,
  formatTime,
  formatTimeAgo,
  durationColor,
  agentDisplayName,
  modeColor,
  abbreviateMode,
} from '../lib/format.js';

// ─── Node content renderer ────────────────────────────────────────────────────

interface NodeContent {
  icon: string;
  label: string;
  meta: string;
  color: string;
  dim: boolean;
  metaColor?: string;
  suffix?: string;
  suffixColor?: string;
}

function renderNodeContent(node: TreeNode, maxWidth: number): NodeContent {
  switch (node.type) {
    case 'section': {
      switch (node.section) {
        case 'running':
          return {
            icon: '',
            label: 'Running',
            meta: node.count > 0 ? `${node.count}` : '',
            color: 'green',
            dim: false,
            metaColor: 'gray',
          };
        case 'done':
          return {
            icon: '',
            label: `Done (${node.count})`,
            meta: '',
            color: 'gray',
            dim: true,
          };
      }
    }
    case 'needs-you-virtual': {
      const hasPending = node.pendingCount > 0;
      return {
        icon: '⚑',
        label: 'Needs You',
        meta: hasPending ? `${node.pendingCount} pending` : '',
        color: hasPending ? 'red' : 'gray',
        dim: !hasPending,
        metaColor: hasPending ? 'red' : undefined,
      };
    }
    case 'session': {
      const icon = statusIndicator(node.status);
      const color = statusColor(node.status);
      const dim = node.status === 'completed' || node.orphaned === true;
      const cyclePart = node.cycleCount > 0 ? `C${node.cycleCount}` : '';
      // Use tracked active time (matches detail panel), not wall-clock elapsed.
      const dur = formatDuration(node.activeMs);
      const agopart =
        node.status === 'completed' && node.completedAt ? formatTimeAgo(node.completedAt) : '';
      const meta = [cyclePart, dur, agopart].filter(Boolean).join(' ');
      const suffix = node.orphaned ? '⚠ orphan' : undefined;
      const suffixColor = node.orphaned ? 'red' : undefined;
      const displayText = node.name ?? node.task;
      const suffixWidth = suffix ? suffix.length + 1 : 0;
      const maxLabel = Math.max(8, maxWidth - meta.length - 4 - suffixWidth);
      return { icon, label: truncate(displayText, maxLabel), meta, color, dim, suffix, suffixColor };
    }
    case 'cycle': {
      const isRunning = !node.completedAt;
      const dur = isRunning ? 'running' : formatDuration(node.activeMs);
      const agents = `${node.agentCount} agent${node.agentCount !== 1 ? 's' : ''}`;
      const modeShort = abbreviateMode(node.mode);
      const mode = modeShort ? ` · ${modeShort}` : '';
      return {
        icon: isRunning ? '●' : '○',
        label: `C${node.cycleNumber}`,
        meta: `${dur} · ${agents}${mode}`,
        color: isRunning ? 'green' : 'gray',
        dim: !isRunning,
      };
    }
    case 'agent': {
      const icon = agentStatusIcon(node.status);
      const color = statusColor(node.status);
      const dur = formatDuration(node.activeMs);
      const durClr = durationColor(node.activeMs) || undefined;
      const dim = node.status === 'completed' || node.orphaned === true;
      const displayName = agentDisplayName({
        name: node.name,
        id: node.agentId,
        agentType: node.agentType,
      });
      const suffix = node.orphaned ? '⚠ orphan' : undefined;
      const suffixColor = node.orphaned ? 'red' : undefined;
      const suffixWidth = suffix ? suffix.length + 1 : 0;
      const maxLabel = Math.max(8, maxWidth - dur.length - 4 - suffixWidth);
      return {
        icon,
        label: truncate(displayName, maxLabel),
        meta: dur,
        color,
        dim,
        metaColor: durClr,
        suffix,
        suffixColor,
      };
    }
    case 'report': {
      const badge = node.reportType === 'final' ? 'FINAL' : 'UPDATE';
      const time = formatTime(node.timestamp);
      return {
        icon: node.reportType === 'final' ? '◆' : '◇',
        label: `${badge} ${time}`,
        meta: '',
        color: node.reportType === 'final' ? 'cyan' : 'yellow',
        dim: false,
      };
    }
    case 'messages':
      return {
        icon: '✉',
        label: `Messages (${node.count})`,
        meta: '',
        color: 'yellow',
        dim: false,
      };
    case 'message': {
      const maxLabel = Math.max(8, maxWidth - 8);
      return {
        icon: '·',
        label: truncate(`${node.source}: ${node.summary}`, maxLabel),
        meta: formatTime(node.timestamp),
        color: 'gray',
        dim: true,
      };
    }
    case 'context':
      return {
        icon: '⊞',
        label: `Context (${node.fileCount})`,
        meta: '',
        color: 'white',
        dim: node.fileCount === 0,
      };
    case 'context-file': {
      const maxLabel = Math.max(8, maxWidth - 4);
      return {
        icon: '·',
        label: truncate(node.label, maxLabel),
        meta: '',
        color: 'gray',
        dim: false,
      };
    }
  }
}

// ─── Tree panel renderer ──────────────────────────────────────────────────────

export function renderTreePanel(
  buf: FrameBuffer,
  rect: Rect,
  nodes: TreeNode[],
  cursorIndex: number,
  focused: boolean,
  companion?: CompanionState | null,
): void {
  const { x, y, w, h } = rect;

  // 1. Border — yellow when focused
  drawBorder(buf, x, y, w, h, focused ? 'cyan' : 'gray');

  // 2. Inner dimensions
  const innerX = x + 2;
  const innerW = w - 4;
  const innerY = y + 1;
  const innerH = h - 2;

  if (innerW <= 0 || innerH <= 0) return;

  // 3. Empty state
  if (nodes.length === 0) {
    writeClipped(buf, innerX, innerY, '\x1b[1m Sessions \x1b[0m', innerW);
    writeClipped(buf, innerX, innerY + 1, '\x1b[2mNo sessions found.\x1b[0m', innerW);
    writeClipped(buf, innerX, innerY + 2, '\x1b[2mPress [n] to create one.\x1b[0m', innerW);
    writeClipped(buf, innerX, innerY + 3, '\x1b[2mPress [?] for all keybindings.\x1b[0m', innerW);
    return;
  }

  // 4. Scroll logic — reserve rows at bottom for companion (blank + face + wrapped commentary)
  let companionRows = 0;
  let _companionCommentaryLines: string[] = [];
  if (companion) {
    const commentaryText = companion.lastCommentary?.text;
    if (commentaryText) {
      const words = commentaryText.split(' ');
      let current = '';
      let currentWidth = 0;
      for (const word of words) {
        const wordWidth = stringWidth(word);
        if (currentWidth + wordWidth + 1 > innerW && currentWidth > 0) {
          _companionCommentaryLines.push(current);
          current = word;
          currentWidth = wordWidth;
        } else if (currentWidth === 0) {
          current = word;
          currentWidth = wordWidth;
        } else {
          current = `${current} ${word}`;
          currentWidth += 1 + wordWidth;
        }
      }
      if (current.length > 0) _companionCommentaryLines.push(current);
    }
    companionRows = 1 + 1 + _companionCommentaryLines.length; // blank + face + commentary lines
  }
  const maxVisible = Math.max(1, innerH - companionRows);
  const halfVisible = Math.floor(maxVisible / 2);
  const scrollOffset = Math.max(
    0,
    Math.min(cursorIndex - halfVisible, nodes.length - maxVisible),
  );

  // 5. Scroll indicator adjustments
  const hasTopIndicator = scrollOffset > 0;
  const hasBottomIndicator = scrollOffset + maxVisible < nodes.length;

  let rowStart = innerY;
  let availRows = maxVisible;

  if (hasTopIndicator) {
    const topMore = scrollOffset;
    writeClipped(buf, innerX, rowStart, `\x1b[2m↑ ${topMore} more\x1b[0m`, innerW);
    rowStart++;
    availRows--;
  }

  if (hasBottomIndicator) {
    availRows--;
  }

  // 6. Render visible nodes
  const visible = nodes.slice(scrollOffset, scrollOffset + availRows + (hasBottomIndicator ? 1 : 0));
  const renderCount = Math.min(visible.length, availRows);

  for (let i = 0; i < renderCount; i++) {
    const node = visible[i]!;
    const realIdx = scrollOffset + i;
    const isSelected = realIdx === cursorIndex;
    const prefix = node.prefix ?? renderTreePrefix(node, nodes, realIdx);
    const contentWidth = innerW;
    const { icon, label, meta, color, dim, metaColor, suffix, suffixColor } = renderNodeContent(
      node,
      contentWidth - prefix.length,
    );

    // Build ANSI string
    let content = '';

    // icon with color
    if (icon) {
      if (dim) content += `\x1b[2;${colorToSGR(color)}m${icon}\x1b[0m `;
      else content += `\x1b[${colorToSGR(color)}m${icon}\x1b[0m `;
    }

    // label
    if (dim) content += `\x1b[2m${label}\x1b[0m`;
    else content += label;

    // meta
    if (meta) {
      if (metaColor) content += ` \x1b[${colorToSGR(metaColor)}m${meta}\x1b[0m`;
      else content += ` \x1b[2m${meta}\x1b[0m`;
    }

    // suffix
    if (suffix && suffixColor) {
      content += ` \x1b[${colorToSGR(suffixColor)}m${suffix}\x1b[0m`;
    }

    let line = prefix;
    if (isSelected) {
      const bold = '\x1b[1m';
      const inverse = focused ? '\x1b[7m' : '';
      line += `${inverse}${bold}${content}\x1b[0m`;
    } else {
      line += content;
    }

    writeClipped(buf, innerX, rowStart + i, line, innerW);
  }

  // 7. Bottom scroll indicator
  if (hasBottomIndicator) {
    const bottomMore = nodes.length - scrollOffset - maxVisible;
    const bottomRow = rowStart + availRows;
    writeClipped(buf, innerX, bottomRow, `\x1b[2m↓ ${bottomMore} more\x1b[0m`, innerW);
  }

  // 8. Companion pinned to bottom (blank + face + wrapped commentary)
  if (companion) {
    const commentaryCount = _companionCommentaryLines.length;
    const faceRow = y + h - 2 - commentaryCount;
    const hasActive = nodes.some((n) => n.type === 'session' && n.status === 'active');
    const fields: CompanionField[] = hasActive
      ? ['face', 'boulder', 'verb']
      : ['face', 'boulder', 'hobby'];
    // Don't use renderCompanion's internal color — applyColor's string replace
    // breaks when maxWidth truncates the result. Apply mood color externally.
    const faceLine = renderCompanion(companion, fields, {
      maxWidth: innerW,
      agentCount: companion.recentActiveAgents ?? 0,
      verbIndex: companion.spinnerVerbIndex,
    });
    const moodCode = getMoodAnsiCode(companion.mood);
    writeClipped(buf, innerX, faceRow, `\x1b[${moodCode}m${faceLine}\x1b[0m`, innerW);

    for (let i = 0; i < commentaryCount; i++) {
      writeClipped(buf, innerX, faceRow + 1 + i, `\x1b[${moodCode}m${_companionCommentaryLines[i]}\x1b[0m`, innerW);
    }
  }
}
