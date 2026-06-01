import type { Session } from './types.js';

export const OBSERVATION_CATEGORIES = ['session-sentiments', 'repo-impressions', 'user-patterns', 'notable-moments'] as const;

export type ObservationCategory = typeof OBSERVATION_CATEGORIES[number];

export type ObservationSource = 'rule' | 'haiku';

export interface ObservationRecord {
  id: string;                    // crypto.randomUUID()
  category: ObservationCategory;
  source: ObservationSource;
  text: string;                  // one-sentence observation; validated per §0.1
  repo: string | null;           // absolute cwd path, or null for cross-repo observations
  sessionId: string;
  timestamp: string;             // ISO 8601
  detectorId?: string;           // rule-only: which detector produced this
}

export interface CompanionMemoryState {
  version: 1;
  observations: ObservationRecord[];          // ordered oldest → newest
  prunedAt: string | null;                    // ISO timestamp of last prune, or null if never
  firedDetectors: Record<string, string>;     // detectorId → lastDedupKey (per §0.1)
}

export interface ObservationContext {
  prevLevel: number;                          // read by: level-up
  prevSessionsCompleted: number;              // read by: session-milestone
  prevConsecutiveEfficientSessions: number;   // read by: efficient-streak (pre-update comparison)
}

export interface ObservationEngineInput {
  companion: CompanionState;
  session: Session;
  prev: ObservationContext;
}

export class MemoryStoreParseError extends Error {
  constructor(public cause: unknown) { super('companion-memory.json is corrupt'); }
}

export type Mood = 'happy' | 'grinding' | 'frustrated' | 'zen' | 'sleepy' | 'excited' | 'existential';

export type CompanionField = 'face' | 'boulder' | 'title' | 'commentary' | 'mood' | 'level' | 'stats' | 'achievements' | 'verb' | 'hobby';

export type FeedbackRating = 'neutral' | 'good' | 'bad' | 'whip' | 'comment';

export interface FeedbackEntry {
  commentaryText: string;
  rating: FeedbackRating;
  comment?: string;
  event: CommentaryEvent;
  timestamp: string; // ISO timestamp
}

export type CommentaryEvent =
  | 'session-start'
  | 'mode-transition'
  | 'session-complete'
  | 'level-up'
  | 'achievement'
  | 'agent-crash'
  | 'idle-wake'
  | 'late-night';

export type TimePersonality = 'chipper' | 'professional' | 'reflective' | 'dry-humor' | 'delirious';

export type IdleAnimation = 'sleeping' | 'pacing' | 'pondering' | 'flexing' | 'deep-sleep';

export type AchievementCategory = 'milestone' | 'session' | 'time' | 'behavioral';

export type AchievementId =
  // Milestone (25)
  | 'first-blood'
  | 'regular'
  | 'centurion'
  | 'veteran'
  | 'thousand-boulder'
  | 'cartographer'
  | 'world-traveler'
  | 'omnipresent'
  | 'swarm-starter'
  | 'hive-mind'
  | 'legion'
  | 'army-of-thousands'
  | 'singularity'
  | 'first-shift'
  | 'workaholic'
  | 'time-lord'
  | 'eternal-grind'
  | 'epoch'
  | 'old-growth'
  | 'seasoned'
  | 'ancient'
  | 'apprentice'
  | 'journeyman'
  | 'master'
  | 'grandmaster'
  // Session (19)
  | 'marathon'
  | 'squad'
  | 'battalion'
  | 'swarm'
  | 'blitz'
  | 'speed-run'
  | 'flash'
  | 'flawless'
  | 'speed-demon'
  | 'iron-will'
  | 'glass-cannon'
  | 'solo'
  | 'one-more-cycle'
  | 'deep-dive'
  | 'abyss'
  | 'eternal-recurrence'
  | 'endurance'
  | 'ultramarathon'
  | 'one-shot'
  | 'quick-draw'
  // Time (6)
  | 'night-owl'
  | 'dawn-patrol'
  | 'early-bird'
  | 'weekend-warrior'
  | 'all-nighter'
  | 'witching-hour'
  // Behavioral (16)
  | 'sisyphean'
  | 'stubborn'
  | 'one-must-imagine'
  | 'creature-of-habit'
  | 'loyal'
  | 'wanderer'
  | 'streak'
  | 'iron-streak'
  | 'hot-streak'
  | 'momentum'
  | 'overdrive'
  | 'patient-one'
  | 'message-in-a-bottle'
  | 'deep-conversation'
  | 'comeback-kid'
  | 'pair-programming';

export interface AchievementDef {
  id: AchievementId;
  name: string;
  category: AchievementCategory;
  description: string;
  badge: string | null;
}

export interface CompanionStats {
  strength: number;    // lifetime completed sessions
  endurance: number;   // lifetime active ms
  wisdom: number;      // efficient orchestration count
  patience: number;    // persistence score (cycles + lifecycle bonuses)
}

// Welford's online algorithm — tracks running mean + variance in O(1) space
export interface RunningStats {
  count: number;
  mean: number;
  m2: number;  // sum of squared deviations from mean
}

export interface CompanionBaselines {
  sessionMs: RunningStats;                // active time per completed session
  cycleCount: RunningStats;               // cycles per completed session
  agentCount: RunningStats;               // total agents per completed session
  sessionsPerDay: RunningStats;           // sessions completed per active day
  recentAgentThroughput: RunningStats;    // agents active in last 2h across all sessions at completion time
  lastCountedDay: string | null;          // YYYY-MM-DD for day-boundary tracking
  pendingDayCount: number;                // current day's running total (finalized tomorrow)
}

export interface UnlockedAchievement {
  id: AchievementId;
  unlockedAt: string;  // ISO timestamp
}

export interface RepoMemory {
  visits: number;
  completions: number;
  crashes: number;
  totalActiveMs: number;
  moodAvg: number;     // running average (0-1 scale)
  nickname: string | null;
  firstSeen: string;   // ISO timestamp
  lastSeen: string;    // ISO timestamp
}

export interface LastCommentary {
  text: string;
  event: CommentaryEvent;
  timestamp: string;   // ISO timestamp
}

export interface CompanionState {
  version: 1;
  name: string | null;
  createdAt: string;   // ISO timestamp
  stats: CompanionStats;
  xp: number;
  level: number;
  title: string;
  mood: Mood;
  moodUpdatedAt: string; // ISO timestamp
  achievements: UnlockedAchievement[];
  repos: Record<string, RepoMemory>;  // keyed by absolute cwd path
  lastCommentary: LastCommentary | null;
  commentaryHistory: LastCommentary[];  // ring buffer of last 30 commentaries for anti-repetition
  feedbackHistory: FeedbackEntry[];    // ring buffer of last 30 user feedback entries
  // Lifetime counters (redundant with derivable stats but kept for fast achievement checks)
  sessionsCompleted: number;
  sessionsCrashed: number;
  totalActiveMs: number;
  lifetimeAgentsSpawned: number;
  // Achievement tracking counters
  consecutiveCleanSessions: number;
  consecutiveEfficientSessions: number;
  consecutiveHighCycleSessions: number;
  consecutiveDaysActive: number;
  lastActiveDate: string | null;       // ISO date string YYYY-MM-DD
  taskHistory: Record<string, number>; // normalized task hash → attempt count
  dailyRepos: Record<string, string[]>; // ISO date → array of repo paths
  recentCompletions: string[];          // last 3 ISO timestamps for momentum check
  spinnerVerbIndex: number;
  // Deviation-based mood scoring: running statistics for personal baselines
  baselines?: CompanionBaselines;
  // Agents active in last 2h across all sessions/dirs (written by pane-monitor, read at session completion for baseline)
  lastRecentAgentCount?: number;
  // Sum of agents in sessions with 2h-recent activity (boulder size, mood signal source)
  recentActiveAgents?: number;
  // Debug: last mood signals and scores (written by pane-monitor, read by TUI debug overlay)
  debugMood?: {
    signals: MoodSignals;
    scores: Record<Mood, number>;
    winner: Mood;
  };
}

export interface IdleState {
  animation: IdleAnimation;
  frame: number;       // current frame index in the animation cycle
  idleSince: string;   // ISO timestamp of last session event
}

export interface CompanionRenderOpts {
  maxWidth?: number;
  color?: boolean;
  tmuxFormat?: boolean;
  repoPath?: string;
  agentCount?: number;
  verbIndex?: number;
}

export interface MoodSignals {
  recentCrashes: number;      // crashes in last 30 minutes
  idleDurationMs: number;     // ms since last session activity
  sessionLengthMs: number;    // current session running time
  cleanStreak: number;        // consecutive clean completions
  justCompleted: boolean;     // session just completed successfully
  justCrashed: boolean;       // agent just crashed
  justLeveledUp: boolean;     // level up just happened
  hourOfDay: number;          // 0-23
  activeAgentCount?: number;  // agents currently with status === 'running'
  totalAgentCount?: number;   // max total agents (agents.length) across tracked active sessions (for z-score baselines)
  recentAgentCount?: number;  // agents active in last 2h across all sessions/dirs (for grind z-score)
  cycleCount?: number;              // current session orchestrator cycle count
  sessionsCompletedToday?: number;  // sessions completed today
  // Frustration signals — actual negative events
  rollbackCount?: number;           // max rollbacks across tracked active sessions
  restartedAgentCount?: number;     // total agents restarted across tracked active sessions
  lostAgentCount?: number;          // total agents with status 'lost' across tracked active sessions
  killedAgentCount?: number;        // total agents explicitly killed across tracked active sessions
  // User feedback signals (counts from last 5 feedbackHistory entries)
  recentFeedbackGood?: number;      // good ratings in last 5
  recentFeedbackBad?: number;       // bad ratings in last 5
  recentFeedbackWhip?: number;      // whip ratings in last 5
}

export const ACHIEVEMENTS: AchievementDef[] = [
  // Milestone (25)
  { id: 'first-blood', name: 'First Blood', category: 'milestone', description: 'Complete your first session.', badge: null },
  { id: 'regular', name: 'Regular', category: 'milestone', description: 'Complete 10 sessions.', badge: null },
  { id: 'centurion', name: 'Centurion', category: 'milestone', description: 'Complete 100 sessions.', badge: null },
  { id: 'veteran', name: 'Veteran', category: 'milestone', description: 'Complete 500 sessions.', badge: null },
  { id: 'thousand-boulder', name: 'Thousand Boulder', category: 'milestone', description: 'Complete 1,000 sessions.', badge: null },
  { id: 'cartographer', name: 'Cartographer', category: 'milestone', description: 'Work in 5 different repos.', badge: '+' },
  { id: 'world-traveler', name: 'World Traveler', category: 'milestone', description: 'Work in 15 different repos.', badge: null },
  { id: 'omnipresent', name: 'Omnipresent', category: 'milestone', description: 'Work in 30 different repos.', badge: null },
  { id: 'swarm-starter', name: 'Swarm Starter', category: 'milestone', description: 'Spawn 50 agents over a lifetime.', badge: null },
  { id: 'hive-mind', name: 'Hive Mind', category: 'milestone', description: 'Spawn 500 agents over a lifetime.', badge: null },
  { id: 'legion', name: 'Legion', category: 'milestone', description: 'Spawn 2,000 agents over a lifetime.', badge: null },
  { id: 'army-of-thousands', name: 'Army of Thousands', category: 'milestone', description: 'Spawn 5,000 agents over a lifetime.', badge: null },
  { id: 'singularity', name: 'Singularity', category: 'milestone', description: 'Spawn 10,000 agents over a lifetime.', badge: null },
  { id: 'first-shift', name: 'First Shift', category: 'milestone', description: '10 hours of total agent active time.', badge: null },
  { id: 'workaholic', name: 'Workaholic', category: 'milestone', description: '100 hours of total agent active time.', badge: null },
  { id: 'time-lord', name: 'Time Lord', category: 'milestone', description: '500 hours of total agent active time.', badge: null },
  { id: 'eternal-grind', name: 'Eternal Grind', category: 'milestone', description: '2,000 hours of total agent active time.', badge: null },
  { id: 'epoch', name: 'Epoch', category: 'milestone', description: '5,000 hours of total agent active time.', badge: null },
  { id: 'old-growth', name: 'Old Growth', category: 'milestone', description: 'Companion is 14 days old.', badge: null },
  { id: 'seasoned', name: 'Seasoned', category: 'milestone', description: 'Companion is 90 days old.', badge: null },
  { id: 'ancient', name: 'Ancient', category: 'milestone', description: 'Companion is 365 days old.', badge: null },
  { id: 'apprentice', name: 'Apprentice', category: 'milestone', description: 'Reach level 5.', badge: null },
  { id: 'journeyman', name: 'Journeyman', category: 'milestone', description: 'Reach level 15.', badge: null },
  { id: 'master', name: 'Master', category: 'milestone', description: 'Reach level 30.', badge: null },
  { id: 'grandmaster', name: 'Grandmaster', category: 'milestone', description: 'Reach level 50.', badge: null },
  // Session (19)
  { id: 'marathon', name: 'Marathon', category: 'session', description: 'Complete a session with 15+ agents.', badge: '~^~' },
  { id: 'squad', name: 'Squad Up', category: 'session', description: 'Complete a session with 10+ agents.', badge: null },
  { id: 'battalion', name: 'Battalion', category: 'session', description: 'Complete a session with 25+ agents.', badge: null },
  { id: 'swarm', name: 'The Swarm', category: 'session', description: 'Complete a session with 50+ agents.', badge: null },
  { id: 'blitz', name: 'Blitz', category: 'session', description: 'Complete a session in under 5 minutes.', badge: null },
  { id: 'speed-run', name: 'Speed Run', category: 'session', description: 'Complete a session in under 15 minutes.', badge: null },
  { id: 'flash', name: 'Flash', category: 'session', description: 'Complete a session in under 2 minutes.', badge: null },
  { id: 'flawless', name: 'Flawless', category: 'session', description: 'Complete a session with 10+ agents and zero crashes.', badge: '*' },
  { id: 'speed-demon', name: 'Speed Demon', category: 'session', description: '10 consecutive sessions completing in 3 or fewer cycles.', badge: '⚡' },
  { id: 'iron-will', name: 'Iron Will', category: 'session', description: '5 consecutive sessions each with 8+ orchestrator cycles.', badge: '[]' },
  { id: 'glass-cannon', name: 'Glass Cannon', category: 'session', description: '5+ agents, all crashed, but session completed anyway.', badge: null },
  { id: 'solo', name: 'Solo', category: 'session', description: 'Complete a session with exactly one agent.', badge: null },
  { id: 'one-more-cycle', name: 'One More Cycle', category: 'session', description: 'A session with 10+ orchestrator cycles.', badge: null },
  { id: 'deep-dive', name: 'Deep Dive', category: 'session', description: 'A session with 15+ orchestrator cycles.', badge: null },
  { id: 'abyss', name: 'Into the Abyss', category: 'session', description: 'A session with 25+ orchestrator cycles.', badge: null },
  { id: 'eternal-recurrence', name: 'Eternal Recurrence', category: 'session', description: 'A session with 40+ orchestrator cycles.', badge: null },
  { id: 'endurance', name: 'Endurance', category: 'session', description: 'A single session running 4+ hours.', badge: null },
  { id: 'ultramarathon', name: 'Ultramarathon', category: 'session', description: 'A single session running 6+ hours.', badge: null },
  { id: 'one-shot', name: 'One Shot', category: 'session', description: 'Complete with 5+ agents in exactly 1 orchestrator cycle.', badge: null },
  { id: 'quick-draw', name: 'Quick Draw', category: 'session', description: 'First agent spawned within 20s of session start.', badge: null },
  // Time (6)
  { id: 'night-owl', name: 'Night Owl', category: 'time', description: 'Complete a session started between 1am and 5am.', badge: ')' },
  { id: 'dawn-patrol', name: 'Dawn Patrol', category: 'time', description: 'Session running 3+ hours that spans midnight to 6am.', badge: null },
  { id: 'early-bird', name: 'Early Bird', category: 'time', description: 'Start a session before 6am.', badge: null },
  { id: 'weekend-warrior', name: 'Weekend Warrior', category: 'time', description: 'Complete a session on a Saturday or Sunday.', badge: null },
  { id: 'all-nighter', name: 'All-Nighter', category: 'time', description: 'Single session running 5+ hours.', badge: null },
  { id: 'witching-hour', name: 'Witching Hour', category: 'time', description: 'Start a session between 3am and 4am.', badge: null },
  // Behavioral (16)
  { id: 'sisyphean', name: 'Sisyphean', category: 'behavioral', description: 'Restart the same task 3+ times.', badge: ';' },
  { id: 'stubborn', name: 'Stubborn', category: 'behavioral', description: 'Restart the same task 5+ times and eventually complete it.', badge: null },
  { id: 'one-must-imagine', name: 'One Must Imagine', category: 'behavioral', description: 'Restart the same task 10+ times.', badge: null },
  { id: 'creature-of-habit', name: 'Creature of Habit', category: 'behavioral', description: 'Visit the same repo 10 times.', badge: null },
  { id: 'loyal', name: 'Loyal', category: 'behavioral', description: 'Visit the same repo 30 times.', badge: null },
  { id: 'wanderer', name: 'Wanderer', category: 'behavioral', description: '3+ different repos in a single calendar day.', badge: null },
  { id: 'streak', name: 'Streak', category: 'behavioral', description: '7 consecutive days with at least one session.', badge: null },
  { id: 'iron-streak', name: 'Iron Streak', category: 'behavioral', description: '14 consecutive days with at least one session.', badge: null },
  { id: 'hot-streak', name: 'Hot Streak', category: 'behavioral', description: '15 consecutive clean sessions.', badge: null },
  { id: 'momentum', name: 'Momentum', category: 'behavioral', description: '5 sessions completed within 4 hours.', badge: null },
  { id: 'overdrive', name: 'Overdrive', category: 'behavioral', description: 'Complete 6+ sessions in a single calendar day.', badge: null },
  { id: 'patient-one', name: 'Patient One', category: 'behavioral', description: 'Idle 30+ minutes between cycles in a session.', badge: null },
  { id: 'message-in-a-bottle', name: 'Message in a Bottle', category: 'behavioral', description: '10+ messages sent to a single session.', badge: null },
  { id: 'deep-conversation', name: 'Deep Conversation', category: 'behavioral', description: 'Send 20+ messages to a single session.', badge: null },
  { id: 'comeback-kid', name: 'Comeback Kid', category: 'behavioral', description: 'Resume a paused/killed session and complete it.', badge: null },
  { id: 'pair-programming', name: 'Pair Programming', category: 'behavioral', description: '8+ user messages during a single active session.', badge: null },
];
