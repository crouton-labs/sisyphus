import type { Segment, RenderContext, SegmentOutput } from './types.js';
import { Compositor } from './compositor.js';

// ─── Session ordering ──────────────────────────────────────────────────────────

// The session-order file may contain a `---` divider. Names before it are
// anchored to the FRONT (in listed order); names after it are anchored to the
// END (in listed order). Sessions in neither list fall in the middle, sorted
// alphabetically. This lets you pin a session like `crtr` to always render last.
function orderSessions(sessions: string[], order: string[]): string[] {
  const dividerIdx = order.indexOf('---');
  const front = dividerIdx === -1 ? order : order.slice(0, dividerIdx);
  const back = dividerIdx === -1 ? [] : order.slice(dividerIdx + 1);
  const frontMap = new Map(front.map((name, idx) => [name, idx]));
  const backMap = new Map(back.map((name, idx) => [name, idx]));

  // bucket: 0 = front, 1 = middle (unlisted), 2 = back
  const rank = (name: string): { bucket: number; idx: number } => {
    if (frontMap.has(name)) return { bucket: 0, idx: frontMap.get(name)! };
    if (backMap.has(name)) return { bucket: 2, idx: backMap.get(name)! };
    return { bucket: 1, idx: 0 };
  };

  return [...sessions].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra.bucket !== rb.bucket) return ra.bucket - rb.bucket;
    if (ra.bucket === 1) return a.localeCompare(b); // middle: alphabetical
    return ra.idx - rb.idx;                          // front/back: listed order
  });
}

// ─── Session rendering ─────────────────────────────────────────────────────────

function renderNormalSession(
  name: string,
  color: string,
  activeBg: string,
  activeText: string,
  inactiveText: string,
  sectionBg: string,
  isActive: boolean,
): string {
  if (isActive) {
    return `#[bg=${activeBg}]#[fg=${color}] ● #[fg=${activeText}]#[bold]${name}#[nobold] #[bg=${sectionBg}]`;
  }
  return `#[fg=${color}] ● #[fg=${inactiveText}]${name} `;
}

// ─── Segment implementation ────────────────────────────────────────────────────

class SessionsSegment implements Segment {
  readonly id = 'sessions';
  readonly side = 'right' as const;
  readonly priority = 100;
  readonly bg: string;

  constructor(bg: string) {
    this.bg = bg;
  }

  render(ctx: RenderContext): SegmentOutput {
    const { allSessions, sisyphusPhases, sessionOrder, sessionStates, config } = ctx;
    const { colors } = config;

    // Build set of tmux session names that belong to sisyphus sessions
    const sisyphusTmuxNames = new Set<string>();
    for (const { tmuxSession } of sisyphusPhases.values()) {
      sisyphusTmuxNames.add(tmuxSession);
    }

    // Filter to normal (non-sisyphus) sessions
    const normalNames = allSessions
      .map(s => s.name)
      .filter(name => !sisyphusTmuxNames.has(name) && !name.startsWith('ssyph_'));

    if (normalNames.length === 0) {
      return { content: '' };
    }

    const ordered = orderSessions(normalNames, sessionOrder);

    const parts = ordered.map(name => {
      const state = sessionStates.get(name);
      let color: string;
      switch (state) {
        case 'processing': color = colors.processing; break;
        case 'stopped':    color = colors.stopped;    break;
        default:           color = colors.idle;        break;
      }
      return {
        name,
        rendered: renderNormalSession(
          name,
          color,
          colors.activeBg,
          colors.activeText,
          colors.inactiveText,
          this.bg,
          name === ctx.currentSession,
        ),
      };
    });

    const { content, trailingName } = Compositor.renderSessionBand(
      parts,
      this.bg,
      this.bg,     // compositor already drew the entry arrow; use sectionBg to suppress the first intra-band arrow
      colors.activeBg,
      ctx.currentSession,
    );

    return {
      content,
      trailingName: trailingName === null ? undefined : trailingName,
    };
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create the sessions segment.
 * Pass `ctx.config.segments.sessions?.bg` (or the DEFAULT_STATUS_BAR_CONFIG value)
 * as `bg` — the compositor uses this value for cross-band arrow color transitions.
 */
export function createSessionsSegment(bg: string): Segment {
  return new SessionsSegment(bg);
}
