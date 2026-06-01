import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import {
  askDecisionsPath, askDir, askEntryDir, askMetaPath, askOutputPath, askProgressPath, askReviewPath, askVisualsDir,
} from '../shared/paths.js';
import type { InboxItem } from '@crouton-kit/humanloop';
import type { AskMeta, AskStatus, Deck, FeedbackResult, InteractionKind, InteractionResponse } from '../shared/types.js';
import { loadConfig } from '../shared/config.js';
import { emitHistoryEvent } from './history.js';
import { isSessionDangerous } from './state.js';
import { atomicWrite, withLock } from './lib/atomic.js';
import { sendTerminalNotification } from './notify.js';
import * as state from './state.js';

const ACTIONABLE_KINDS: ReadonlySet<InteractionKind> = new Set([
  'validation', 'decision', 'context', 'error', 'review',
]);

const HEARTBEAT_ASKED_BY = 'system:heartbeat';
const ORPHAN_ASKED_BY = 'system:orphan-handler';

function maybeNotifyOnAskCreated(cwd: string, sessionId: string, meta: AskMeta, suppress = false): void {
  if (process.env.NODE_ENV === 'test' || process.env.SISYPHUS_DISABLE_NOTIFY === '1') return;
  const isActionable = meta.kind !== undefined && ACTIONABLE_KINDS.has(meta.kind);
  const isHeartbeat = meta.askedBy === HEARTBEAT_ASKED_BY;
  if (!isActionable && !isHeartbeat) return;
  // The in-terminal ask popup already has the user's attention.
  if (suppress) return;

  try {
    const config = loadConfig(cwd);
    if (config.notifications?.enabled === false) return;
    const session = state.getSession(cwd, sessionId);
    const label = session.name ?? sessionId.slice(0, 8);
    const body = meta.title ?? 'Question pending';
    sendTerminalNotification(label, body, session.tmuxSessionName, 'urgent');
  } catch {
    // notify failures must never roll back the ask write
  }
}

export interface CreateAskParams {
  askId: string;
  askedBy: string;
  blocking: boolean;
  pid?: number;
  claudeSessionId?: string;
  cwd: string;
  title?: string;
  subtitle?: string;
  kind?: InteractionKind;
  orphanTarget?: AskMeta['orphanTarget'];
  suppressTerminalNotification?: boolean;
}

export function createAsk(cwd: string, sessionId: string, params: CreateAskParams): AskMeta {
  // askVisualsDir is a subdir of askEntryDir — one recursive mkdir creates both.
  mkdirSync(askVisualsDir(cwd, sessionId, params.askId), { recursive: true });

  const askedAt = new Date().toISOString();
  const meta: AskMeta = {
    askId: params.askId,
    askedBy: params.askedBy,
    askedAt,
    status: 'pending' as AskStatus,
    blocking: params.blocking,
    cwd: params.cwd,
    ...(params.pid !== undefined ? { pid: params.pid, startedAt: askedAt } : {}),
    ...(params.claudeSessionId !== undefined ? { claudeSessionId: params.claudeSessionId } : {}),
    ...(params.title !== undefined ? { title: params.title } : {}),
    ...(params.subtitle !== undefined ? { subtitle: params.subtitle } : {}),
    ...(params.kind !== undefined ? { kind: params.kind } : {}),
    ...(params.orphanTarget !== undefined ? { orphanTarget: params.orphanTarget } : {}),
  };

  atomicWrite(askMetaPath(cwd, sessionId, params.askId), JSON.stringify(meta, null, 2));
  emitHistoryEvent(sessionId, 'ask-issued', {
    askId: params.askId,
    askedBy: params.askedBy,
    blocking: params.blocking,
    askedAt,
  });
  maybeNotifyOnAskCreated(cwd, sessionId, meta, params.suppressTerminalNotification === true);
  return meta;
}

export function writeDecisions(cwd: string, sessionId: string, askId: string, deck: Deck): void {
  atomicWrite(askDecisionsPath(cwd, sessionId, askId), JSON.stringify(deck, null, 2));
  void maybeAutoResolveAsk(cwd, sessionId, askId, deck);
}

export function readDecisions(cwd: string, sessionId: string, askId: string): Deck | null {
  const p = askDecisionsPath(cwd, sessionId, askId);
  try {
    // { encoding } in try body intentional — keeps try content free of bare } for linter clarity
    return JSON.parse(readFileSync(p, { encoding: 'utf-8' })) as Deck;
  } catch (_e) {
    return null;
  }
}

export async function writeProgress(
  cwd: string, sessionId: string, askId: string, responses: InteractionResponse[],
): Promise<void> {
  atomicWrite(askProgressPath(cwd, sessionId, askId), JSON.stringify({
    partial: true,
    responses,
    savedAt: new Date().toISOString(),
  }, null, 2));
  const cur = readMeta(cwd, sessionId, askId);
  if (cur?.status === 'pending') {
    await updateMeta(cwd, sessionId, askId, { status: 'in-progress', startedAt: new Date().toISOString() });
  }
}

export function readProgress(
  cwd: string, sessionId: string, askId: string,
): { responses: InteractionResponse[]; savedAt: string } | null {
  const p = askProgressPath(cwd, sessionId, askId);
  try {
    const data = JSON.parse(readFileSync(p, { encoding: 'utf-8' })) as Record<string, unknown>;
    if (!Array.isArray(data['responses'])) return null;
    return { responses: data['responses'] as InteractionResponse[], savedAt: data['savedAt'] as string };
  } catch (_e) {
    return null;
  }
}

export function writeOutput(
  cwd: string, sessionId: string, askId: string,
  responses: InteractionResponse[], completedAt?: string,
): void {
  atomicWrite(askOutputPath(cwd, sessionId, askId), JSON.stringify({
    responses,
    completedAt: completedAt ?? new Date().toISOString(),
  }, null, 2));
}

export function writeReview(cwd: string, sessionId: string, askId: string, params: { file: string }): void {
  atomicWrite(askReviewPath(cwd, sessionId, askId), JSON.stringify({ file: params.file }, null, 2));
}

export function readReview(cwd: string, sessionId: string, askId: string): { file: string } | null {
  const p = askReviewPath(cwd, sessionId, askId);
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as { file: string };
  } catch {
    return null;
  }
}

export function writeReviewOutput(
  cwd: string, sessionId: string, askId: string, feedback: FeedbackResult, completedAt?: string,
): void {
  atomicWrite(askOutputPath(cwd, sessionId, askId), JSON.stringify({
    kind: 'review',
    feedback,
    completedAt: completedAt ?? new Date().toISOString(),
  }, null, 2));
}

export function readMeta(cwd: string, sessionId: string, askId: string): AskMeta | null {
  const p = askMetaPath(cwd, sessionId, askId);
  if (!existsSync(p)) {
    return null;
  }
  return JSON.parse(readFileSync(p, 'utf-8')) as AskMeta;
}

export async function updateMeta(
  cwd: string, sessionId: string, askId: string, patch: Partial<AskMeta>,
): Promise<AskMeta> {
  const next = await withLock(askId, () => {
    const cur = readMeta(cwd, sessionId, askId);
    if (!cur) {
      throw new Error(`updateMeta: askId ${askId} not found`);
    }
    const updated: AskMeta = { ...cur, ...patch };
    atomicWrite(askMetaPath(cwd, sessionId, askId), JSON.stringify(updated, null, 2));
    return updated;
  });
  // Cascade-resolve the linked heartbeat ask when the original is marked answered.
  if (patch.status === 'answered' && next.heartbeatAskId) {
    const hbAskId = next.heartbeatAskId;
    cascadeResolveHeartbeatAsk(cwd, sessionId, hbAskId).catch(err => {
      console.warn(
        `[sisyphus] heartbeat cascade-resolve failed for ${hbAskId}:`,
        err instanceof Error ? err.message : err,
      );
    });
  }
  return next;
}

/**
 * Auto-resolves a heartbeat ask when its linked original ask has been answered.
 * Called from updateMeta when status transitions to 'answered' and heartbeatAskId is set.
 */
async function cascadeResolveHeartbeatAsk(cwd: string, sessionId: string, heartbeatAskId: string): Promise<void> {
  const hbMeta = readMeta(cwd, sessionId, heartbeatAskId);
  if (!hbMeta) return;
  if (hbMeta.status === 'answered') return;
  if (existsSync(askOutputPath(cwd, sessionId, heartbeatAskId))) return;
  writeOutput(cwd, sessionId, heartbeatAskId, [{
    id: 'heartbeat',
    selectedOptionId: 'ack',
    freetext: 'auto-resolved: original ask was answered',
  }]);
  await updateMeta(cwd, sessionId, heartbeatAskId, {
    status: 'answered',
    completedAt: new Date().toISOString(),
  });
}

export function listAsks(cwd: string, sessionId: string): string[] {
  const dir = askDir(cwd, sessionId);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
}

/**
 * Build dashboard inbox items for the session's pending review asks. `scanInbox`
 * (humanloop) keys on `deck.json` and so never surfaces reviews, which write
 * `review.json` instead — without this, `sis ask review submit` blocks forever
 * with nothing shown in the dashboard. Mirror scanInbox's resolved/orphan
 * filtering so a review drops off the inbox once it's submitted.
 */
export function listReviewInboxItems(cwd: string, sessionId: string): InboxItem[] {
  const items: InboxItem[] = [];
  for (const askId of listAsks(cwd, sessionId)) {
    const meta = readMeta(cwd, sessionId, askId);
    if (!meta || meta.kind !== 'review') continue;
    if (meta.orphaned) continue;
    if (meta.status !== 'pending' && meta.status !== 'in-progress') continue;
    if (existsSync(askOutputPath(cwd, sessionId, askId))) continue; // resolved
    const review = readReview(cwd, sessionId, askId);
    items.push({
      dir: askEntryDir(cwd, sessionId, askId),
      id: askId,
      title: meta.title ?? (review ? `Review ${basename(review.file)}` : 'Review'),
      kind: 'review',
      blockedSince: meta.askedAt,
    });
  }
  return items;
}

export interface PendingAskRef {
  askId: string;
  status: AskStatus;
  title?: string;
}

/**
 * Open asks (pending or in-progress) attributed to a specific caller. Used to gate
 * yield/submit so a deck can't be abandoned mid-flight — terminating the caller's
 * pane orphans any answer the user produces afterward.
 *
 * Skips: meta.orphaned, status === 'answered', decks where response.json already
 * exists (the user resolved the deck but markAnswered hasn't run yet, e.g. because
 * the original waiter died before observing the response), and non-blocking decks
 * (mode-transition notifications, heartbeat asks, orphan-recovery surfaces — these
 * have no CLI waiter, so terminating the caller doesn't orphan anything).
 */
/**
 * Build auto-responses for a deck by selecting the first option of every
 * interaction. Skips interactions with no options. Used by dangerous mode.
 */
function buildAutoResponses(deck: Deck): InteractionResponse[] {
  const out: InteractionResponse[] = [];
  for (const interaction of deck.interactions) {
    const first = interaction.options[0];
    if (!first) continue;
    out.push({ id: interaction.id, selectedOptionId: first.id });
  }
  return out;
}

/**
 * Unconditionally auto-resolve the given ask using the supplied (or just-read)
 * deck. Skips when response.json already exists or no responses can be built.
 * The flush path passes the deck directly; the writeDecisions hook also passes
 * the deck so we never re-read it.
 */
export async function autoResolveAsk(
  cwd: string, sessionId: string, askId: string, deck?: Deck,
): Promise<boolean> {
  try {
    if (existsSync(askOutputPath(cwd, sessionId, askId))) return false;
    const d = deck ?? readDecisions(cwd, sessionId, askId);
    if (!d) return false;
    const responses = buildAutoResponses(d);
    if (responses.length === 0) return false;
    writeOutput(cwd, sessionId, askId, responses);
    await updateMeta(cwd, sessionId, askId, {
      status: 'answered',
      completedAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    console.warn(`[sisyphus] dangerous-mode auto-resolve failed for ask ${askId}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Auto-resolve hook called from writeDecisions. If dangerous mode is on for
 * this session, auto-resolves the just-written deck. Failure is logged, never
 * thrown — must not roll back the deck write.
 */
async function maybeAutoResolveAsk(
  cwd: string, sessionId: string, askId: string, deck: Deck,
): Promise<void> {
  try {
    if (!isSessionDangerous(cwd, sessionId)) return;
    // Orphan-handler asks require human action — auto-selecting "resume" doesn't
    // trigger an actual resume, but it does mark the ask answered, which defeats
    // emitOrphanAsk's dedup and causes a notification flood every monitor tick
    // while the orchestrator stays gone.
    if (deck.source?.askedBy === ORPHAN_ASKED_BY) return;
    // Review asks have no deck options to auto-select; skip entirely.
    const meta = readMeta(cwd, sessionId, askId);
    if (meta?.kind === 'review') return;
    await autoResolveAsk(cwd, sessionId, askId, deck);
  } catch {
    // never roll back the deck write
  }
}

/**
 * Daemon-recovery hook: a daemon restart invalidates any in-flight ask "claim".
 * `scanInbox` hides an ask whose `progress.json` is younger than 300s
 * (`isClaimed`), on the assumption a live resolver owns it. After a restart that
 * assumption no longer holds — so a partially-answered, still-open ask stays
 * invisible in the dashboard inbox for up to 5 minutes while the orchestrator
 * blocks on it. Clear the partial progress for every unresolved ask on recovery
 * so it re-surfaces immediately as a clean pending ask, and reset its meta back
 * to `pending` for consistency.
 *
 * Safe: `progress.json` is only a resume/crash-recovery copy — a still-live
 * dashboard editor keeps its typed buffer in memory and re-persists on the next
 * keystroke, so removing the file doesn't disturb an active edit. Resolved asks
 * (response.json present) are left untouched. Best-effort throughout: a failed
 * unlink or meta write must never abort recovery. Returns the count cleared.
 */
export async function clearStaleAskClaims(cwd: string, sessionId: string): Promise<number> {
  let cleared = 0;
  for (const askId of listAsks(cwd, sessionId)) {
    const progressPath = askProgressPath(cwd, sessionId, askId);
    if (!existsSync(progressPath)) continue;
    if (existsSync(askOutputPath(cwd, sessionId, askId))) continue; // resolved — leave it
    try {
      unlinkSync(progressPath);
    } catch {
      continue; // couldn't clear — leave meta as-is rather than lie about state
    }
    cleared++;
    const meta = readMeta(cwd, sessionId, askId);
    if (meta?.status === 'in-progress') {
      await updateMeta(cwd, sessionId, askId, { status: 'pending', startedAt: undefined }).catch(() => {
        // meta reset is cosmetic — the unlink already re-surfaced the ask
      });
    }
  }
  return cleared;
}

export function listOpenAsksFor(cwd: string, sessionId: string, askedBy: string): PendingAskRef[] {
  const out: PendingAskRef[] = [];
  for (const askId of listAsks(cwd, sessionId)) {
    const meta = readMeta(cwd, sessionId, askId);
    if (!meta) continue;
    if (meta.askedBy !== askedBy) continue;
    if (meta.orphaned) continue;
    if (!meta.blocking) continue;
    if (meta.status !== 'pending' && meta.status !== 'in-progress') continue;
    if (existsSync(askOutputPath(cwd, sessionId, askId))) continue;
    out.push({ askId, status: meta.status, ...(meta.title !== undefined ? { title: meta.title } : {}) });
  }
  return out;
}
