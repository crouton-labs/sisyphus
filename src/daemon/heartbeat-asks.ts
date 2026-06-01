import { ulid } from 'ulid';
import * as askStore from './ask-store.js';
import * as state from './state.js';
import { loadSessionRegistry } from './server.js';
import { existsSync } from 'node:fs';
import { statePath } from '../shared/paths.js';
import type { AskMeta, Deck, Interaction } from '../shared/types.js';

export const HEARTBEAT_ASKED_BY = 'system:heartbeat';
export const HEARTBEAT_THRESHOLD_MS = 60 * 60 * 1000;
export const HEARTBEAT_SCAN_INTERVAL_MS = 15 * 60 * 1000;

let heartbeatTimer: NodeJS.Timeout | null = null;

function formatHoursAgo(ms: number): string {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 2) return '1h';
  return `${Math.floor(hours)}h`;
}

async function emitHeartbeatAsk(
  cwd: string,
  sessionId: string,
  original: AskMeta,
): Promise<void> {
  const now = Date.now();
  const askedAtMs = new Date(original.askedAt).getTime();
  const ageMs = now - askedAtMs;

  let sessionName: string | undefined;
  try {
    sessionName = state.getSession(cwd, sessionId).name;
  } catch {
    // tolerate — heartbeat emission must not crash if state is in flux
  }

  // Pull the original deck's title and the first interaction title for body context
  const origDeck = askStore.readDecisions(cwd, sessionId, original.askId);
  const origDeckTitle = origDeck?.title ?? original.title ?? '(untitled)';
  const origInteractionTitle = origDeck?.interactions[0]?.title ?? '';
  const bodyParts = [origDeckTitle];
  if (origInteractionTitle && origInteractionTitle !== origDeckTitle) {
    bodyParts.push(origInteractionTitle);
  }

  const interaction: Interaction = {
    id: 'heartbeat',
    title: 'Question still waiting',
    subtitle: `Asked ${formatHoursAgo(ageMs)} ago by ${original.askedBy}`,
    body: bodyParts.join('\n\n'),
    kind: 'notify',
    options: [{ id: 'ack', label: 'Acknowledged' }],
  };

  const deck: Deck = {
    title: 'Stale question',
    source: {
      sessionName,
      askedBy: HEARTBEAT_ASKED_BY,
      blockedSince: original.askedAt,
    },
    interactions: [interaction],
  };

  const askId = ulid();
  askStore.createAsk(cwd, sessionId, {
    askId,
    askedBy: HEARTBEAT_ASKED_BY,
    blocking: false,
    cwd,
    title: 'Stale question',
    subtitle: interaction.subtitle,
    kind: 'notify',
  });
  askStore.writeDecisions(cwd, sessionId, askId, deck);

  // Mark the original so we don't re-notify on the next scan, and record the
  // heartbeat askId so it can be cascade-resolved when the original is answered.
  await askStore.updateMeta(cwd, sessionId, original.askId, {
    heartbeatNotifiedAt: new Date().toISOString(),
    heartbeatAskId: askId,
  });
}

export async function scanSessionForStaleAsks(cwd: string, sessionId: string): Promise<void> {
  const now = Date.now();

  for (const askId of askStore.listAsks(cwd, sessionId)) {
    try {
      const meta = askStore.readMeta(cwd, sessionId, askId);
      if (!meta) continue;
      if (meta.status === 'answered') continue;
      if (meta.orphaned) continue;

      if (meta.heartbeatNotifiedAt) continue;
      // Don't emit a heartbeat for the heartbeat ask itself
      if (meta.askedBy === HEARTBEAT_ASKED_BY) continue;
      // Skip orphan-handler asks too — they have their own UX
      const askedAtMs = new Date(meta.askedAt).getTime();
      if (Number.isNaN(askedAtMs)) continue;
      if (now - askedAtMs <= HEARTBEAT_THRESHOLD_MS) continue;
      await emitHeartbeatAsk(cwd, sessionId, meta);
    } catch (err) {
      console.warn(
        `[sisyphus] heartbeat scan: ${sessionId}/${askId} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export async function scanAllSessionsForStaleAsks(): Promise<void> {
  const reg = loadSessionRegistry();
  for (const [sessionId, cwd] of Object.entries(reg)) {
    if (!existsSync(statePath(cwd, sessionId))) continue;
    try {
      await scanSessionForStaleAsks(cwd, sessionId);
    } catch (err) {
      console.warn(
        `[sisyphus] heartbeat scan failed for ${sessionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export function startHeartbeatScanner(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    scanAllSessionsForStaleAsks().catch(err => {
      console.warn('[sisyphus] heartbeat scan tick failed:', err instanceof Error ? err.message : err);
    });
  }, HEARTBEAT_SCAN_INTERVAL_MS);
  // Don't keep the event loop alive solely for this timer
  heartbeatTimer.unref?.();
}

export function stopHeartbeatScanner(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
