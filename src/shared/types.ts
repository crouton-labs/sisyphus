export type Provider = 'anthropic' | 'openai';

export interface StatusBarColors {
  processing?: string;
  stopped?: string;
  idle?: string;
  activeBg?: string;
  activeText?: string;
  inactiveText?: string;
}

export interface SegmentConfig {
  bg?: string;
  activeBg?: string;
  [key: string]: unknown;
}

export interface StatusBarConfig {
  enabled?: boolean;
  colors?: StatusBarColors;
  left?: string[];
  right?: string[];
  segments?: Record<string, SegmentConfig>;
}

export type SessionStatus = 'active' | 'paused' | 'completed';

export type UploadStatus = 'pending' | 'uploaded' | 'failed';

/**
 * Records intent to move a session to a cloud box (or pause for reclaim).
 * - `target` omitted ⇒ quiesce-only (used by reclaim's box-side pause step).
 * - `target` present ⇒ at next quiesce, daemon syncs state + working tree to
 *   the box and respawns the orchestrator there via `sis resume`.
 */
export interface HandoffState {
  /** Cloud destination. Omitted means "pause at next quiesce; do not push." */
  target?: { provider: string; repo: string };
  /** ISO timestamp when the RPC was received. */
  queuedAt: string;
  /** Set after a successful push to the box. */
  sentAt?: string;
  /** Set after a successful pull back to local. */
  reclaimedAt?: string;
  /** True when --force was passed; daemon interrupts in-flight work. */
  force: boolean;
  /**
   * Resume message injected on the box. Computed at queue time for --force
   * (since we know which agents/orchestrator are being interrupted), empty
   * for natural quiesce.
   */
  message?: string;
  /** Most recent failure during push; set so the user can retry from `sis session inspect list`. */
  lastError?: string;
}

export type MessageSource =
  | { type: 'agent'; agentId: string }
  | { type: 'user' }
  | { type: 'system'; detail?: string };

export interface Message {
  id: string;
  source: MessageSource;
  content: string;
  summary: string;
  filePath?: string;
  timestamp: string;
}

export type AgentStatus = 'running' | 'completed' | 'killed' | 'crashed' | 'lost';

export interface AgentReport {
  type: 'update' | 'final';
  filePath: string;
  summary: string;
  timestamp: string;
}

export interface Session {
  id: string;
  name?: string;
  task: string;
  context?: string;
  cwd: string;
  status: SessionStatus;
  createdAt: string;
  completedAt?: string;
  activeMs: number;
  /** Set true when the orchestrator pane vanished unexpectedly or daemon-startup found a stuck session. */
  orphaned?: boolean;
  /** Reason string passed to markSessionOrphan — mirrors agent.killedReason. */
  orphanReason?: string;
  /** Cumulative time blocked on `sis ask` (blocking asks only). Subtracted from wallClockMs to compute efficiency. */
  userBlockedMs?: number;
  agents: Agent[];
  orchestratorCycles: OrchestratorCycle[];
  messages: Message[];
  completionReport?: string;
  parentSessionId?: string;
  tmuxSessionName?: string;
  tmuxSessionId?: string;       // tmux $N session ID — stable across renames, exact-match targeting
  tmuxWindowId?: string;
  model?: string;
  wallClockMs?: number;
  startHour?: number;
  startDayOfWeek?: number;
  launchConfig?: { model?: string; context?: string; orchestratorPrompt?: string; };
  /** Cycles already credited to companion stats (prevents double-counting on continue→re-complete) */
  companionCreditedCycles?: number;
  /** activeMs already credited to companion stats */
  companionCreditedActiveMs?: number;
  /** Strength already credited to companion stats */
  companionCreditedStrength?: number;
  rollbackCount?: number;
  resumeCount?: number;
  continueCount?: number;
  companionCreditedWisdom?: number;
  /** Lifecycle of the upload to the Worker proxy. `undefined` means upload was never attempted. */
  uploadStatus?: UploadStatus;
  /** R2 storage key returned by the Worker, e.g. `users/silas/<sessionId>.zip`. Bucket is private; this is NOT a fetch-able URL. */
  uploadKey?: string;
  /** Clean error message extracted from the Worker's JSON response when `uploadStatus === 'failed'`. */
  uploadError?: string;
  /** Daemon-local `new Date().toISOString()` at the moment the success was persisted. */
  uploadCompletedAt?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  /**
   * When true, the daemon auto-resolves every new ask in this session by
   * picking the first option of each interaction. Toggleable per-session
   * from the dashboard via the `D` key.
   */
  dangerousMode?: boolean;
  /**
   * Cloud-handoff lifecycle marker. Set by `sis cloud handoff push` (push to box)
   * or `sis session recover quiesce` (pause-only). Presence with `sentAt` unset blocks
   * local respawn at the next quiesce point; presence with `sentAt` set means
   * the session lives on the box and can be `sis cloud handoff pull`-ed.
   */
  handoff?: HandoffState;
}

export interface StatusDigest {
  recentWork: string;
  unusualEvents: string[];
  currentActivity: string;
  whatsNext: string;
  effort?: string;
}

export interface Agent {
  id: string;
  name: string;
  nickname?: string;
  agentType: string;
  provider?: Provider;
  claudeSessionId?: string;
  color: string;
  instruction: string;
  status: AgentStatus;
  spawnedAt: string;
  completedAt: string | null;
  activeMs: number;
  /** Cumulative time this agent was blocked on its own `sis ask` calls (blocking only). Subset of activeMs. */
  userBlockedMs?: number;
  reports: AgentReport[];
  paneId: string;
  repo: string;
  killedReason?: string;
  restartCount?: number;
  originalSpawnedAt?: string;
  resumeEnv?: string;
  resumeArgs?: string;
  /** Set true when the agent's pane vanished unexpectedly or pid+lstart no longer match. Orthogonal to status. */
  orphaned?: boolean;
  /** Captured at spawn time by `setupAgentPane` → first `tmux display-message #{pane_pid}`. */
  pid?: number;
  /** `ps -o lstart=` output captured at spawn. Compared during pid-sweep to detect PID recycling. */
  pidLstart?: string;
  /** Set true when `sis agent await` consumed this agent's report inline. Suppresses it from the next-cycle orchestrator prompt; one-way. */
  consumedInline?: boolean;
}

export interface OrchestratorCycle {
  cycle: number;
  timestamp: string;
  completedAt?: string;
  activeMs: number;
  /** Cumulative time blocked on `sis ask` during this cycle (blocking asks only). */
  userBlockedMs?: number;
  interCycleGapMs?: number;
  agentsSpawned: string[];
  paneId?: string;
  claudeSessionId?: string;
  nextPrompt?: string;
  mode?: string;
  resumeEnv?: string;
  resumeArgs?: string;
}

// ── sisyphus ask: interaction / deck types — canonical shapes from humanloop ──

export type { Deck, Interaction, InteractionOption, InteractionKind, InteractionResponse, FeedbackResult, FeedbackComment } from '@crouton-kit/humanloop';

// Sisyphus-only extension: modeChain on DeckSource
import type { DeckSource as HumanloopDeckSource, FeedbackResult, InteractionKind, InteractionResponse } from '@crouton-kit/humanloop';

export interface ModeChainEntry {
  mode: string;
  /** Cycles spent in this segment. Absent for the trailing (current) entry. */
  cycles?: number;
  /** Active ms accumulated in this segment. Absent for the trailing entry. */
  activeMs?: number;
}

/** Sisyphus DeckSource extends humanloop's with orchestrator mode-chain. */
export type DeckSource = HumanloopDeckSource & {
  /** For orchestrator mode-transition notify decks: ordered chain of modes visited. Trailing entry is the current mode. */
  modeChain?: ModeChainEntry[];
};

export interface DeckAskOutput {
  kind?: 'deck';
  responses: InteractionResponse[];
  completedAt: string;
}

export interface ReviewAskOutput {
  kind: 'review';
  feedback: FeedbackResult;
  completedAt: string;
}

export type AskOutput = DeckAskOutput | ReviewAskOutput;

export interface VisualBlock {
  questionId: string;
  content: string;
  status: 'loading' | 'ready' | 'error';
}

export const ORCHESTRATOR_ASKED_BY = 'orchestrator' as const;

export type AskStatus = 'pending' | 'in-progress' | 'answered' | 'not-found';

export interface AskMeta {
  askId: string;
  askedBy: string;
  askedAt: string;
  status: AskStatus;
  blocking: boolean;
  pid?: number;
  startedAt?: string;
  completedAt?: string;
  orphaned?: boolean;
  /** ISO timestamp set by the heartbeat scanner when a stale-question notify ask is emitted; dedup key. */
  heartbeatNotifiedAt?: string;
  claudeSessionId?: string;
  cwd: string;
  title?: string;
  subtitle?: string;
  kind?: InteractionKind;
  /** Set on system-emitted error-kind asks; carries the takeover-dispatch context. */
  orphanTarget?: { kind: 'agent'; agentId: string; paneId?: string } | { kind: 'orchestrator' };
  /** Set on orchestrator mode-transition notify asks; aggregation key for rolling mode-change notifications. */
  modeTransition?: true;
  /** Set on the original ask when a heartbeat reminder ask has been emitted for it; holds the heartbeat askId for cascade-resolve. */
  heartbeatAskId?: string;
}
