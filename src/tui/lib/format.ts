import stringWidth from 'string-width';

export { formatDuration, statusColor } from '../../shared/format.js';

export function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function truncate(text: string, max: number): string {
  // Collapse newlines and normalize wide emoji (see cleanMarkdown for rationale)
  const clean = text.replace(/\n/g, ' ').replace(/✅/g, '✓').replace(/❌/g, '✗').replace(/\p{Emoji_Presentation}/gu, '');
  if (max < 4) return clean.slice(0, max);
  const w = stringWidth(clean);
  if (w <= max) return clean;
  // Trim from the end until we fit, respecting display width
  let result = clean;
  while (stringWidth(result) > max - 1 && result.length > 0) {
    // Try to break at a word boundary
    const cut = result.lastIndexOf(' ', result.length - 2);
    if (cut > max * 0.4) {
      result = result.slice(0, cut);
    } else {
      result = result.slice(0, result.length - 1);
    }
  }
  return result + '…';
}

/** Strip markdown syntax to plain text */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+[.)]\s+/gm, '')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/---+/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract the first meaningful sentence from markdown-heavy text.
 * Much better than blind truncation — finds actual content.
 */
export function extractFirstSentence(text: string, maxLen: number): string {
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('---')) continue;
    if (trimmed.startsWith('```')) continue;
    if (trimmed.startsWith('|')) continue;
    if (trimmed.length < 5) continue;

    const cleaned = stripMarkdown(trimmed);
    if (cleaned.length < 5) continue;

    // Try to end at a sentence boundary
    const periodIdx = cleaned.indexOf('. ');
    if (periodIdx > 10 && periodIdx < maxLen) {
      return cleaned.slice(0, periodIdx + 1);
    }
    return truncate(cleaned, maxLen);
  }
  const fallback = stripMarkdown(text);
  return truncate(fallback, maxLen);
}

export function durationColor(startOrMs: string | number, endIso?: string | null): string {
  let totalMs: number;
  if (typeof startOrMs === 'number') {
    totalMs = startOrMs;
  } else {
    const start = new Date(startOrMs).getTime();
    const end = endIso ? new Date(endIso).getTime() : Date.now();
    totalMs = end - start;
  }
  if (totalMs < 10 * 60 * 1000) return '';
  if (totalMs < 30 * 60 * 1000) return 'yellow';
  return 'red';
}

export function statusIndicator(status: string): string {
  switch (status) {
    case 'active':
      return '▶';
    case 'completed':
      return '✓';
    case 'paused':
      return '⏸';
    default:
      return '·';
  }
}

export function agentStatusIcon(status: string): string {
  switch (status) {
    case 'running':
      return '▶';
    case 'completed':
      return '✓';
    case 'killed':
      return '✕';
    case 'crashed':
      return '!';
    case 'lost':
      return '?';
    default:
      return '·';
  }
}

export function agentTypeColor(agentType: string | undefined): string | undefined {
  if (!agentType) return undefined;
  const t = agentType.toLowerCase();
  if (t.includes('research')) return 'blue';
  if (t.includes('implement') || t.includes('code')) return 'green';
  if (t.includes('review') || t.includes('test')) return 'magenta';
  if (t.includes('plan')) return 'yellow';
  return undefined;
}

// Inbox kind → text-presentation icon / ANSI color. Shared by the
// cross-session inbox list and the inline inbox deck header.
export const KIND_ICON: Record<string, string> = {
  notify: '✉',
  validation: '✓',
  decision: '◆',
  context: '✎',
  error: '⚠',
  review: '◈',
};
export const KIND_COLOR: Record<string, string> = {
  notify: 'gray',
  validation: 'cyan',
  decision: 'cyan',
  context: 'cyan',
  error: 'red',
  review: 'magenta',
};

export function kindIcon(kind: string | undefined): string {
  return kind && kind in KIND_ICON ? KIND_ICON[kind]! : '·';
}

export function kindColor(kind: string | undefined): string {
  return kind && kind in KIND_COLOR ? KIND_COLOR[kind]! : 'cyan';
}

export function divider(width: number, char: string = '─'): string {
  return char.repeat(Math.max(0, width));
}

/** Strip YAML frontmatter (--- ... ---) from markdown content */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return content;
  return content.slice(end + 4).trimStart();
}

/** Clean inline markdown syntax for terminal display */
export function cleanMarkdown(line: string): string {
  return line
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    // Normalize wide emoji → single-width alternatives.
    // Ink's @alcalzone/ansi-tokenize treats emoji as width=1, but terminals
    // render them as width=2. This mismatch causes lines to overflow by 1
    // column, wrapping the right border to the next row (phantom blank lines).
    .replace(/✅/g, '✓')
    .replace(/❌/g, '✗')
    .replace(/\p{Emoji_Presentation}/gu, '');
}

// Shared line types for scrollable panels

export type Seg = {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
  /** ANSI 38;2;R;G;B foreground tint (e.g. '38;2;226;217;198'). Wins over `color` when set. */
  fg?: string;
  /** ANSI 48;2;R;G;B background tint (e.g. '48;2;40;35;20') */
  bg?: string;
};

export type DetailLine = Seg[];

export function seg(text: string, opts?: Partial<Omit<Seg, 'text'>>): Seg {
  return { text, ...opts };
}

/** Create a single-segment DetailLine */
export function singleLine(text: string, opts?: Partial<Omit<Seg, 'text'>>): DetailLine {
  return [seg(text, opts)];
}

export function messageSourceLabel(source: string, agentId?: string): string {
  if (source === 'user') return 'You';
  if (source === 'agent') {
    if (!agentId) throw new Error('agentId required when source is agent');
    return agentId;
  }
  return 'system';
}

export function messageSourceColor(source: string): string {
  if (source === 'user') return 'yellow';
  if (source === 'agent') return 'cyan';
  return 'gray';
}

export function reportBadge(type: string): { label: string; color: string } {
  return type === 'final'
    ? { label: 'FINAL', color: 'cyan' }
    : { label: 'UPDATE', color: 'yellow' };
}

export function agentDisplayName(agent: { name: string; id: string; agentType: string }): string {
  return agent.name !== agent.id ? agent.name : agent.agentType;
}

export function abbreviateMode(mode: string | undefined | null): string {
  if (!mode) return '';
  if (mode === 'implementation') return 'impl';
  if (mode === 'planning') return 'plan';
  if (mode === 'discovery') return 'disc';
  if (mode === 'validation') return 'valid';
  return mode;
}

export function ansiBold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

export function ansiDim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`;
}

export function ansiColor(text: string, color: string, bold = false): string {
  const COLOR_MAP: Record<string, number> = { black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37, gray: 90 };
  const codes: number[] = [];
  if (bold) codes.push(1);
  const sgr = COLOR_MAP[color];
  if (sgr !== undefined) codes.push(sgr);
  if (codes.length === 0) return text;
  return `\x1b[${codes.join(';')}m${text}\x1b[0m`;
}

export function modeColor(mode?: string): string {
  if (mode === 'planning') return 'blue';
  if (mode === 'implementation') return 'green';
  if (mode === 'discovery') return 'yellow';
  if (mode === 'validation') return 'magenta';
  return 'cyan';
}

export function mergeStatusDisplay(status: string): { icon: string; label: string; color: string } | null {
  switch (status) {
    case 'merged': return { icon: '⊕', label: 'merged', color: 'green' };
    case 'pending': return { icon: '◌', label: 'pending', color: 'yellow' };
    case 'no-changes': return { icon: '∅', label: 'no changes', color: 'gray' };
    case 'conflict': return { icon: '⚠', label: 'conflict', color: 'red' };
    default: return null;
  }
}

export function wrapText(text: string, width: number): string[] {
  const cleaned = cleanMarkdown(text);
  if (width <= 0) return cleaned.split('\n');
  const result: string[] = [];
  for (const rawLine of cleaned.split('\n')) {
    if (stringWidth(rawLine) <= width) {
      result.push(rawLine);
      continue;
    }

    // Single-pass: walk characters tracking cumulative display width
    let lineStart = 0;
    let lastSpace = -1;
    let displayWidth = 0;

    for (let i = 0; i < rawLine.length; i++) {
      const charWidth = stringWidth(rawLine[i]!);
      displayWidth += charWidth;

      if (rawLine[i] === ' ') lastSpace = i;

      if (displayWidth > width) {
        let breakAt: number;
        if (lastSpace > lineStart) {
          // Break at last space that fits
          breakAt = lastSpace;
          result.push(rawLine.slice(lineStart, breakAt));
          // Skip past the space and any leading spaces
          lineStart = breakAt + 1;
          while (lineStart < rawLine.length && rawLine[lineStart] === ' ') lineStart++;
        } else {
          // No space — hard break at previous char
          breakAt = Math.max(lineStart + 1, i);
          result.push(rawLine.slice(lineStart, breakAt));
          lineStart = breakAt;
        }

        // Recalculate display width for the carried-over portion
        displayWidth = stringWidth(rawLine.slice(lineStart, i + 1));
        lastSpace = -1;
      }
    }

    if (lineStart < rawLine.length) {
      result.push(rawLine.slice(lineStart));
    }
  }
  return result;
}
