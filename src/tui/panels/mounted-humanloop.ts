import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import { mountPanel, type Deck } from '@crouton-kit/humanloop';
import type { InteractionResponse, MountedPanel } from '@crouton-kit/humanloop';
import { readDecisions, readProgress, readMeta, updateMeta, writeOutput } from '../../daemon/ask-store.js';
import { askDecisionsPath, askProgressPath } from '../../shared/paths.js';
import type { AppState } from '../state.js';
import { requestRender, notify } from '../state.js';
import type { InboxItem } from '../../shared/inbox-types.js';
import { sessionIdFromDir, cwdFromDir, askIdFromDir } from '../../shared/inbox-types.js';
import type { Request, Response } from '../../shared/protocol.js';
import { rawSend } from '../../shared/client.js';
import type { Key } from '../terminal.js';
import type { AskMeta, Session } from '../../shared/types.js';

// ── Orphan dispatch ───────────────────────────────────────────────────────────

export type OrphanTakeoverFn = (target: { sessionId: string; agentId: string; paneId?: string }) => Promise<void>;

export interface DispatchOrphanDeps {
  daemonSend: (request: Request) => Promise<Response>;
  onOrphanTakeover?: OrphanTakeoverFn;
  sessionId: string;
  cwd: string;
}

/**
 * Pure dispatch for orphan resolution choices. Extracted so tests can drive it
 * directly without mounting the full panel.
 */
export async function dispatchOrphanResolution(
  orphanTarget: NonNullable<AskMeta['orphanTarget']>,
  selectedOptionId: string,
  deps: DispatchOrphanDeps,
): Promise<void> {
  if (selectedOptionId === 'takeover' && orphanTarget.kind === 'agent') {
    await deps.onOrphanTakeover?.({
      sessionId: deps.sessionId,
      agentId: orphanTarget.agentId,
      paneId: orphanTarget.paneId,
    });
  } else if (selectedOptionId === 'restart' && orphanTarget.kind === 'agent') {
    await deps.daemonSend({ type: 'restart-agent', sessionId: deps.sessionId, agentId: orphanTarget.agentId });
  } else if (selectedOptionId === 'resume' && orphanTarget.kind === 'orchestrator') {
    await deps.daemonSend({ type: 'resume', sessionId: deps.sessionId, cwd: deps.cwd });
  } else if (selectedOptionId === 'dismiss' && orphanTarget.kind === 'orchestrator') {
    // Clear the sticky orphan flag without spawning a new orchestrator — for cases
    // where the user has handled the situation manually (e.g. the tmux pane is still
    // alive) and just wants the "Needs You" badge gone.
    await deps.daemonSend({ type: 'clear-orphan', sessionId: deps.sessionId, cwd: deps.cwd });
  }
}

// ── Orphan takeover wiring ────────────────────────────────────────────────────

export interface OrphanTakeoverOps {
  send: (req: Request) => Promise<Response>;
  paneExists: typeof import('../lib/tmux.js').paneExists;
  switchToSession: typeof import('../lib/tmux.js').switchToSession;
  selectWindow: typeof import('../lib/tmux.js').selectWindow;
  selectPane: typeof import('../lib/tmux.js').selectPane;
}

/**
 * Build the orphan-takeover callback shared by full-screen resolution mode and
 * the inline inbox deck. Resolves the target session, switches tmux to its
 * pane/window, and notifies on failure.
 */
export function makeOrphanTakeover(state: AppState, ops: OrphanTakeoverOps): OrphanTakeoverFn {
  return async ({ sessionId, agentId, paneId }) => {
    const res = await ops.send({ type: 'status', sessionId });
    const sess = res.ok ? (res.data?.session as Session | undefined) : undefined;
    if (!sess) { notify(state, 'Session not found'); return; }
    if (paneId && ops.paneExists(paneId)) {
      if (sess.tmuxSessionName) ops.switchToSession(sess.tmuxSessionName);
      if (sess.tmuxWindowId) ops.selectWindow(sess.tmuxWindowId);
      ops.selectPane(paneId);
      return;
    }
    if (sess.tmuxSessionName) ops.switchToSession(sess.tmuxSessionName);
    notify(state, `Pane ${paneId ? paneId : '?'} is gone — agent ${agentId} cannot be taken over.`);
  };
}

// ── Visual entry ──────────────────────────────────────────────────────────────

export interface VisualEntry {
  status: 'loading' | 'ready' | 'error';
  content: string;
  visible: boolean;
  error?: string;
}

// ── Public handle interface ───────────────────────────────────────────────────

export interface MountedResolutionHandle {
  handleKey(input: string, key: Key): void;
  render(): string[];
  handleResize(cols: number, rows: number): void;
  unmount(): void;
  canAcceptHostKeys(): boolean;
  /** True when the deck is at its top level (overview, no comment input) and
   *  Esc should tear it down rather than step back inside it. */
  atDeckTop(): boolean;
  advanceQueue(delta: number): void;
  spaceVisualToggle(): void;
  regenerateVisual(): void;
  /** Header info for the sisyphus header strip row 0. */
  getHeaderInfo(): {
    currentIndex: number;
    queueLength: number;
    sessionName: string | undefined;
    askTitle: string | undefined;
    askedBy: string | undefined;
    subtitle: string | undefined;
    blockedSince: string;
    kind: string | undefined;
  };
  /** Returns the id of the current (first unanswered) interaction, or undefined. */
  getCurrentQid(): string | undefined;
}

// ── Mount options ─────────────────────────────────────────────────────────────

export interface MountResolutionOpts {
  aggregateInbox: (InboxItem & { sessionName?: string })[];
  startIndex: number;
  cols: number;
  rows: number;
  daemonSend: (request: Request) => Promise<Response>;
  onUnmount: () => void;
  onOrphanTakeover?: OrphanTakeoverFn;
}

// ── Panel factory ─────────────────────────────────────────────────────────────

export function mountResolutionPanel(
  opts: MountResolutionOpts,
  state: AppState,
): MountedResolutionHandle | null {
  let queue = [...opts.aggregateInbox];
  let currentIndex = opts.startIndex;
  let bodyCols = opts.cols;

  const item = () => queue[currentIndex]!;

  function itemCoords(it: InboxItem): { cwd: string; sessionId: string; askId: string } {
    return {
      cwd: cwdFromDir(it.dir),
      sessionId: sessionIdFromDir(it.dir),
      askId: askIdFromDir(it.dir),
    };
  }

  function buildDeck(idx: number): Deck | null {
    const it = queue[idx];
    if (!it) return null;
    const { cwd, sessionId, askId } = itemCoords(it);
    const deck = readDecisions(cwd, sessionId, askId);
    if (!deck) return null;
    deck.source = {
      sessionName: (it as InboxItem & { sessionName?: string }).sessionName ?? it.source?.sessionName,
      askedBy: it.source?.askedBy,
      blockedSince: it.blockedSince,
    };
    return deck;
  }

  // Coords for the initial item — stable reference for initial deck + progress read.
  const { cwd: initCwd, sessionId: initSessionId, askId: initAskId } = itemCoords(item());

  // Initial deck — if missing (file gone, stale inbox, etc.) return null so the caller
  // never enters resolution mode. Returning a live no-op handle traps the user with no
  // way to escape because handleKey is unbound.
  const initialDeck = buildDeck(currentIndex);
  if (!initialDeck) return null;

  // Track answered count for current-qid derivation (Gap 2 option a)
  let currentDeck = initialDeck;
  const initialProgress = readProgress(initCwd, initSessionId, initAskId);
  let answeredCount = initialProgress?.responses.length ?? 0;

  function getCurrentQid(): string | undefined {
    return currentDeck.interactions[answeredCount]?.id ?? currentDeck.interactions[0]?.id;
  }

  function fireVisualGen(force: boolean): void {
    const qid = getCurrentQid();
    if (!qid) return;
    const it = item();
    const { sessionId: itSessionId, askId: itAskId } = itemCoords(it);
    state.visuals.set(qid, { status: 'loading', content: '', visible: true });
    requestRender();
    void (async () => {
      const res = await rawSend({
        type: 'ask-generate-visual',
        sessionId: itSessionId,
        askId: itAskId,
        qid,
        cols: bodyCols,
        force,
      }, 60_000);
      if (res.ok) {
        const ansiPath = (res.data as { ansiPath: string }).ansiPath;
        const ansi = readFileSync(ansiPath, 'utf-8');
        state.visuals.set(qid, { status: 'ready', content: ansi, visible: true });
      } else {
        const errMsg = typeof res.error === 'string' ? res.error : res.error?.message;
        state.visuals.set(qid, { status: 'error', content: '', visible: true, error: errMsg });
      }
      requestRender();
    })();
  }

  // Mirror humanloop's standalone launchTui pattern: track latest responses
  // so onExit (incomplete submit via final-phase Enter) can submit partials.
  let lastResponses: InteractionResponse[] = [];

  const submitResponses = (responses: InteractionResponse[]): void => {
    void (async () => {
      const it = item();
      const { cwd, sessionId, askId } = itemCoords(it);
      const completedAt = new Date().toISOString();

      // Orphan disposition: dispatch before writeOutput so action lands first
      const meta = readMeta(cwd, sessionId, askId);
      if (meta?.orphanTarget && responses.length > 0) {
        const sel = responses[0]!.selectedOptionId;
        if (sel) {
          await dispatchOrphanResolution(meta.orphanTarget, sel, {
            daemonSend: opts.daemonSend,
            onOrphanTakeover: opts.onOrphanTakeover,
            sessionId,
            cwd,
          });
        }
      }

      writeOutput(cwd, sessionId, askId, responses, completedAt);
      await updateMeta(cwd, sessionId, askId, { status: 'answered', completedAt });

      // Optimistic local sync. Drop the answered ask from the polled snapshot
      // (so renderInboxDeckRows' lazy-mount doesn't re-mount on stale data
      // before the next 2.5s poll lands) and from the handle's local queue.
      state.aggregateInbox = state.aggregateInbox.filter((i) => i.dir !== it.dir);
      const idx = queue.findIndex((i) => i.dir === it.dir);
      if (idx >= 0) queue.splice(idx, 1);

      if (queue.length === 0) {
        teardown();
        return;
      }

      currentIndex = Math.min(currentIndex, queue.length - 1);
      const nextItem = queue[currentIndex]!;
      const nextCoords = itemCoords(nextItem);
      const nextDeck = buildDeck(currentIndex);
      if (!nextDeck) {
        teardown();
        return;
      }

      currentDeck = nextDeck;
      const nextProgress = readProgress(nextCoords.cwd, nextCoords.sessionId, nextCoords.askId);
      answeredCount = nextProgress?.responses.length ?? 0;
      lastResponses = [];

      state.visuals.clear();

      panel.loadDeck(nextDeck, {
        progressPath: askProgressPath(nextCoords.cwd, nextCoords.sessionId, nextCoords.askId),
      });
      setDeckWatch(nextCoords, nextDeck);
      requestRender();
    })();
  };

  // ── Live deck reload ──────────────────────────────────────────────────────
  // An agent may rewrite the current item's decisions file in-flight (sisyphus
  // writeDecisions). Watch only the *current* item's file; on a real change
  // reload the panel in place — loadDeck re-resumes answers by surviving id.
  // Re-pointed on every navigation so a stale item is never watched. The host
  // never writes the decisions file, so there is no feedback loop; a
  // structurally-identical rewrite is ignored so a touch never disrupts the
  // human, and a partial/corrupt read is skipped and retried next tick.
  let watchedDeckPath: string | null = null;
  let lastWatchedDeckJson = '';

  const onWatchedDeckChange = (): void => {
    const nextDeck = buildDeck(currentIndex);
    if (!nextDeck) return;
    const nextJson = JSON.stringify(nextDeck);
    if (nextJson === lastWatchedDeckJson) return;
    lastWatchedDeckJson = nextJson;
    currentDeck = nextDeck;
    const { cwd: rcwd, sessionId: rsid, askId: raid } = itemCoords(item());
    const progress = readProgress(rcwd, rsid, raid);
    answeredCount = progress?.responses.length ?? 0;
    state.visuals.clear();
    panel.loadDeck(nextDeck, { progressPath: askProgressPath(rcwd, rsid, raid) });
    requestRender();
  };

  function setDeckWatch(
    coords: { cwd: string; sessionId: string; askId: string },
    baselineDeck: Deck,
  ): void {
    const p = askDecisionsPath(coords.cwd, coords.sessionId, coords.askId);
    lastWatchedDeckJson = JSON.stringify(baselineDeck);
    if (p === watchedDeckPath) return;
    if (watchedDeckPath !== null) {
      try { unwatchFile(watchedDeckPath, onWatchedDeckChange); } catch { /* best-effort */ }
    }
    watchedDeckPath = p;
    watchFile(p, { interval: 500 }, onWatchedDeckChange);
  }

  const panel: MountedPanel = mountPanel({
    deck: initialDeck,
    cols: opts.cols,
    rows: opts.rows,
    progressPath: askProgressPath(initCwd, initSessionId, initAskId),
    onProgress: (responses: InteractionResponse[]) => {
      answeredCount = responses.length;
      lastResponses = responses;
      requestRender();
      const it = item();
      const { cwd, sessionId, askId } = itemCoords(it);
      const cur = readMeta(cwd, sessionId, askId);
      if (cur?.status === 'pending') {
        void updateMeta(cwd, sessionId, askId, { status: 'in-progress', startedAt: new Date().toISOString() });
      }
    },
    onComplete: (responses: InteractionResponse[]) => {
      submitResponses(responses);
    },
    // Final-phase Enter on an incomplete deck routes here (humanloop only fires
    // onComplete when responses === interactions). The 'final' UI prompts
    // "enter submit", so honor that by submitting whatever was answered.
    onExit: () => {
      submitResponses(lastResponses);
    },
  });

  setDeckWatch({ cwd: initCwd, sessionId: initSessionId, askId: initAskId }, initialDeck);

  function teardown(): void {
    if (watchedDeckPath !== null) {
      try { unwatchFile(watchedDeckPath, onWatchedDeckChange); } catch { /* best-effort */ }
      watchedDeckPath = null;
    }
    panel.unmount();
    opts.onUnmount();
  }

  return {
    handleKey(input: string, key: Key) {
      // Key from sisyphus is a structural superset of humanloop Key — no cast needed
      panel.handleKey(input, key);
    },

    render() {
      return panel.render();
    },

    handleResize(cols: number, rows: number) {
      bodyCols = cols;
      panel.handleResize(cols, rows);
    },

    unmount() {
      teardown();
    },

    canAcceptHostKeys() {
      return panel.canAcceptHostKeys();
    },

    atDeckTop() {
      return panel.atDeckTop();
    },

    advanceQueue(delta: number) {
      const newIndex = Math.max(0, Math.min(queue.length - 1, currentIndex + delta));
      if (newIndex === currentIndex) return;
      currentIndex = newIndex;
      const nextDeck = buildDeck(currentIndex);
      if (!nextDeck) return;
      currentDeck = nextDeck;
      const it = item();
      const { cwd: advCwd, sessionId: advSid, askId: advAid } = itemCoords(it);
      const progress = readProgress(advCwd, advSid, advAid);
      answeredCount = progress?.responses.length ?? 0;
      panel.loadDeck(nextDeck, {
        progressPath: askProgressPath(advCwd, advSid, advAid),
      });
      setDeckWatch({ cwd: advCwd, sessionId: advSid, askId: advAid }, nextDeck);
      requestRender();
    },

    spaceVisualToggle() {
      const qid = getCurrentQid();
      if (!qid) return;
      const entry = state.visuals.get(qid);
      if (!entry) {
        fireVisualGen(false);
      } else if (entry.status === 'ready') {
        state.visuals.set(qid, { ...entry, visible: !entry.visible });
        requestRender();
      } else if (entry.status === 'loading') {
        // debounce — no-op
      } else {
        // error → retry
        fireVisualGen(false);
      }
    },

    regenerateVisual() {
      const qid = getCurrentQid();
      if (!qid) return;
      state.visuals.set(qid, { status: 'loading', content: '', visible: true });
      requestRender();
      fireVisualGen(true);
    },

    getHeaderInfo() {
      const it = item();
      const askTitle = currentDeck.title ?? currentDeck.interactions[0]?.title;
      const itWithName = it as InboxItem & { sessionName?: string };
      return {
        currentIndex,
        queueLength: queue.length,
        sessionName: itWithName.sessionName ?? it.source?.sessionName,
        askTitle: askTitle ?? undefined,
        askedBy: it.source?.askedBy,
        subtitle: it.subtitle,
        blockedSince: it.blockedSince,
        kind: it.kind,
      };
    },

    getCurrentQid,
  };
}

// ── enterResolutionMode ───────────────────────────────────────────────────────

export function enterResolutionMode(
  state: AppState,
  askId: string,
  daemonSend: (request: Request) => Promise<Response>,
  onOrphanTakeover?: MountResolutionOpts['onOrphanTakeover'],
): void {
  const queue = state.aggregateInbox;
  const startIdx = queue.findIndex((item) => askIdFromDir(item.dir) === askId);
  if (startIdx < 0) {
    // Ask not in current inbox — use the first item as fallback
    if (queue.length === 0) return;
    enterResolutionMode(state, askIdFromDir(queue[0]!.dir), daemonSend, onOrphanTakeover);
    return;
  }

  const handle = mountResolutionPanel(
    {
      aggregateInbox: queue,
      startIndex: startIdx,
      cols: state.cols,
      rows: state.rows - 1,
      daemonSend,
      onUnmount: () => {
        state.resolutionActive = false;
        state.resolutionHandle = null;
        state.visuals.clear();
        requestRender();
      },
      onOrphanTakeover,
    },
    state,
  );

  if (!handle) {
    // Deck missing or unreadable — don't enter resolution mode. Leaving resolutionActive
    // false means the user stays in the session list and can keep navigating.
    requestRender();
    return;
  }

  state.resolutionHandle = handle;
  state.resolutionActive = true;
  requestRender();
}
