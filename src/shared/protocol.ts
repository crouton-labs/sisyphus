import type { MessageSource, UploadStatus } from './types.js';

export type Request =
  | { type: 'start'; task: string; context?: string; cwd: string; name?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' }
  | { type: 'spawn'; sessionId: string; agentType: string; name: string; instruction: string; repo?: string }
  | { type: 'submit'; sessionId: string; agentId: string; report: string }
  | { type: 'report'; sessionId: string; agentId: string; content: string }
  | { type: 'yield'; sessionId: string; agentId: string; nextPrompt?: string; mode?: string }
  | { type: 'await'; sessionId: string; agentId: string }
  | { type: 'complete'; sessionId: string; report: string }
  | { type: 'clone'; sessionId: string; goal: string; context?: string; name?: string; strategy?: boolean }
  | { type: 'continue'; sessionId: string }
  | { type: 'status'; sessionId?: string; cwd?: string }
  | { type: 'list'; cwd: string; all?: boolean }
  | { type: 'resume'; sessionId: string; cwd: string; message?: string }
  | { type: 'clear-orphan'; sessionId: string; cwd: string }
  | { type: 'kill'; sessionId: string }
  | { type: 'kill-agent'; sessionId: string; agentId: string }
  | { type: 'restart-agent'; sessionId: string; agentId: string }
  | { type: 'pane-exited'; paneId: string }
  | { type: 'message'; sessionId: string; content: string; source?: MessageSource; agentId?: string }
  | { type: 'tell'; sessionId: string; target: { kind: 'orchestrator' } | { kind: 'agent'; agentId: string }; text: string; submit: boolean; source?: MessageSource }
  | { type: 'update-task'; sessionId: string; task: string }
  | { type: 'set-effort'; sessionId: string; effort: 'low' | 'medium' | 'high' | 'xhigh' }
  | { type: 'set-dangerous-mode'; sessionId: string; enabled: boolean }
  | { type: 'set-upload-status'; sessionId: string; cwd: string; status: UploadStatus; storageKey?: string; error?: string }
  | { type: 'rollback'; sessionId: string; cwd: string; toCycle: number }
  | { type: 'delete'; sessionId: string; cwd: string }
  | { type: 'reopen-window'; sessionId: string; cwd: string }
  | { type: 'reconnect'; sessionId: string; cwd: string }
  | { type: 'companion'; name?: string }
  | { type: 'register-segment'; id: string; side: 'left' | 'right'; priority: number; bg: string; content: string }
  | { type: 'update-segment'; id: string; content: string }
  | { type: 'unregister-segment'; id: string }
  | { type: 'ask-generate-visual'; sessionId: string; askId: string; qid: string; cols: number; force?: boolean }
  // Response: { ok: true, data: { items: (InboxItem & { sessionName?: string })[] } }
  // `cwd` scopes the inbox to sessions in the requesting dashboard's working
  // directory — no cross-directory ("fleet") aggregation.
  | { type: 'inbox-list'; cwd: string }
  // Deep-link focus: an external process (the `sis ask` triage popup) asks the
  // dashboard for this cwd to focus a session and open a specific ask. `focus-set`
  // stores the latest request; `focus-get` consumes-and-clears it so the dashboard
  // acts exactly once. `cwd` scopes the request to the matching dashboard.
  // focus-set response: { ok: true }
  // focus-get response: { ok: true, data: { focus: FocusRequest | null } }
  | { type: 'focus-set'; cwd: string; sessionId: string; askId: string }
  | { type: 'focus-get'; cwd: string }
  // Queue (or immediately fire) a cloud handoff. `provider` is resolved via
  // `pickProvider` on the daemon side; `repo` defaults to the local repo basename.
  // Response: { ok: true, data: { queued: boolean, sentAt?: string } }
  | { type: 'cloud-handoff'; sessionId: string; cwd: string; provider?: string; repo?: string; force?: boolean }
  // Cancel a queued handoff. Rejects if `sentAt` is already set.
  | { type: 'cloud-handoff-cancel'; sessionId: string; cwd: string }
  // Pause-only quiesce — no cloud push. Used by `sis cloud handoff pull` on the box
  // to stop the box-side session before rsync-ing state back to local.
  | { type: 'admin-quiesce'; sessionId: string; cwd: string; force?: boolean }
  // Finalize a reclaim: mark `handoff.reclaimedAt`. Called by `sis cloud handoff pull`
  // after the rsync down completes and the local orchestrator is respawned.
  | { type: 'cloud-reclaim-finalize'; sessionId: string; cwd: string };

/**
 * A pending dashboard deep-link focus request. Set by `focus-set`, consumed by
 * `focus-get`. `requestedAt` (epoch ms) drives TTL expiry so a request set while
 * no dashboard exists doesn't fire minutes later on an unrelated relaunch.
 */
export interface FocusRequest {
  cwd: string;
  sessionId: string;
  askId: string;
  requestedAt: number;
}

/**
 * Typed error kinds. Maps to CLI exit codes via `exitForError` (src/cli/errors.ts):
 *   usage     → 2   (bad args / wrong shape)
 *   not_found → 3   (referenced session/agent/etc. doesn't exist)
 *   ambiguous → 4   (multiple matches — see `candidates`)
 *   conflict  → 5   (state collision: already-exists, wrong-state, lock held)
 *   transient → 60  (retry-safe: daemon-down, timeout, upstream 5xx)
 *   permanent → 1   (everything else, including unmigrated string errors)
 *
 * Agents should branch on `kind` or the exit code, not on `message` prose.
 */
export type ErrorKind = 'usage' | 'not_found' | 'ambiguous' | 'conflict' | 'transient' | 'permanent';

export interface ProtocolError {
  /** Stable enum for the specific failure (e.g. 'unknown_session'). */
  code: string;
  kind: ErrorKind;
  /** Human/agent-readable summary; safe to print verbatim. */
  message: string;
  /** Echo of what the caller sent that was rejected, for self-correction. */
  received?: unknown;
  /** Valid set/shape that would have been accepted. */
  expected?: unknown;
  /** Suggested follow-up command. */
  next?: string;
  /** Disambiguation list for kind:'ambiguous'. */
  candidates?: string[];
}

/**
 * Wire shape: error may be a raw string for unmigrated daemon sites; normalize
 * via `normalizeError()` (src/cli/errors.ts) before consuming.
 */
export type Response =
  | { ok: true; data?: Record<string, unknown> }
  | { ok: false; error: string | ProtocolError };

/* -------------------------------------------------------------------------- */
/* ProtocolError factories — use these in the daemon to emit typed errors.    */
/* -------------------------------------------------------------------------- */

interface ErrFields {
  message: string;
  received?: unknown;
  expected?: unknown;
  next?: string;
  candidates?: string[];
}

export const errUsage = (code: string, f: ErrFields): ProtocolError => ({ kind: 'usage', code, ...f });
export const errNotFound = (code: string, f: ErrFields): ProtocolError => ({ kind: 'not_found', code, ...f });
export const errAmbiguous = (code: string, f: ErrFields): ProtocolError => ({ kind: 'ambiguous', code, ...f });
export const errConflict = (code: string, f: ErrFields): ProtocolError => ({ kind: 'conflict', code, ...f });
export const errTransient = (code: string, f: ErrFields): ProtocolError => ({ kind: 'transient', code, ...f });
export const errPermanent = (code: string, f: ErrFields): ProtocolError => ({ kind: 'permanent', code, ...f });
