import { discoverOrchestratorModes } from './orchestrator-modes.js';

export interface PrevModeStats {
  cycles: number;
  activeMs: number;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const remM = min % 60;
  return remM ? `${h}h ${remM}m` : `${h}h`;
}

/**
 * Build the companion commentary for an orchestrator mode transition.
 *
 * Returns the LLM context (new-mode description + prev-mode stats) and the popup
 * border title — `Starting <Mode>` — shown in the tmux popup's `-T` slot.
 */
export function buildModeTransitionCommentary(
  cwd: string,
  prevMode: string,
  nextMode: string,
  prevModeStats: PrevModeStats,
): { context: string; popupTitle: string } {
  const popupTitle = ` Starting ${capitalize(nextMode)} `;

  const description = discoverOrchestratorModes(cwd)
    .find(m => m.name === nextMode)?.description?.trim();

  const label = prevModeStats.cycles === 1 ? 'cycle' : 'cycles';
  const context = [
    description
      ? `Entering ${capitalize(nextMode)} mode — ${description}`
      : `Entering ${capitalize(nextMode)} mode.`,
    `${capitalize(prevMode)}: ${prevModeStats.cycles} ${label} · ${formatDuration(prevModeStats.activeMs)} active.`,
  ].join('\n');

  return { context, popupTitle };
}
