import type { Command } from 'commander';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { historyBaseDir, historySessionDir, historyEventsPath, historySessionSummaryPath, statePath } from '../../shared/paths.js';
import type { SessionSummary } from '../../shared/history-types.js';
import type { HistoryEvent } from '../../shared/history-types.js';
import type { Session } from '../../shared/types.js';
import { exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function loadAllSummaries(): Array<{ id: string; summary: SessionSummary }> {
  const base = historyBaseDir();
  if (!existsSync(base)) return [];

  const results: Array<{ id: string; summary: SessionSummary }> = [];
  for (const name of readdirSync(base)) {
    const summaryPath = historySessionSummaryPath(name);
    if (existsSync(summaryPath)) {
      try {
        const raw = readFileSync(summaryPath, 'utf-8');
        results.push({ id: name, summary: JSON.parse(raw) as SessionSummary });
        continue;
      } catch { /* fall through to live rebuild */ }
    }
    // No session.json — synthesize from live state if session is still in-flight
    const live = buildLiveSummary(name);
    if (live) results.push({ id: name, summary: live });
  }
  // Newest first
  results.sort((a, b) => new Date(b.summary.startedAt).getTime() - new Date(a.summary.startedAt).getTime());
  return results;
}

/**
 * Synthesize a SessionSummary on demand for an in-flight session (no `session.json` yet).
 * Reads the session's `cwd` from the first `session-start` event, then reads live
 * `state.json` and maps it to the same shape `writeSessionSummary` produces.
 * Fields that are only finalized at completion are marked null/empty.
 * Returns null if events or live state can't be read.
 */
function buildLiveSummary(sessionId: string): SessionSummary | null {
  const eventsPath = historyEventsPath(sessionId);
  if (!existsSync(eventsPath)) return null;

  // Extract cwd from the session-start event (only place it's recorded in the history dir)
  let cwd: string | null = null;
  try {
    const lines = readFileSync(eventsPath, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as HistoryEvent;
        if (ev.event === 'session-start' && typeof ev.data.cwd === 'string') {
          cwd = ev.data.cwd;
          break;
        }
      } catch { continue; }
    }
  } catch { return null; }
  if (!cwd) return null;

  const sPath = statePath(cwd, sessionId);
  if (!existsSync(sPath)) return null;

  let session: Session;
  try {
    session = JSON.parse(readFileSync(sPath, 'utf-8')) as Session;
  } catch { return null; }

  // Live wall clock: created → now. activeMs is already flushed periodically by the daemon;
  // both may lag the true live value by one poll interval (~seconds), acceptable for a read-only view.
  const liveWallClockMs = Date.now() - new Date(session.createdAt).getTime();

  return {
    sessionId: session.id,
    name: session.name ?? null,
    task: session.task,
    cwd: session.cwd,
    model: session.model ?? null,
    status: session.status,
    startedAt: session.createdAt,
    completedAt: session.completedAt ?? null,
    activeMs: session.activeMs,
    wallClockMs: session.wallClockMs ?? liveWallClockMs,
    userBlockedMs: session.userBlockedMs ?? 0,
    agentCount: session.agents.length,
    crashCount: session.agents.filter(a => a.status === 'crashed').length,
    lostCount: session.agents.filter(a => a.status === 'lost').length,
    killedAgentCount: session.agents.filter(a => a.status === 'killed').length,
    rollbackCount: session.rollbackCount ?? 0,
    efficiency: liveWallClockMs > 0
      ? Math.max(0, session.activeMs - (session.userBlockedMs ?? 0))
        / Math.max(1, liveWallClockMs - (session.userBlockedMs ?? 0))
      : null,
    cycleCount: session.orchestratorCycles.length,
    context: session.context ?? null,
    completionReport: session.completionReport ?? null,
    agents: session.agents.map(a => ({
      id: a.id,
      name: a.name,
      nickname: a.nickname ?? null,
      agentType: a.agentType,
      status: a.status,
      activeMs: a.activeMs,
      userBlockedMs: a.userBlockedMs ?? 0,
      spawnedAt: a.spawnedAt,
      completedAt: a.completedAt,
      restartCount: a.restartCount ?? 0,
    })),
    cycles: session.orchestratorCycles.map(c => ({
      cycle: c.cycle,
      mode: c.mode ?? null,
      agentsSpawned: c.agentsSpawned.length,
      activeMs: c.activeMs,
      userBlockedMs: c.userBlockedMs ?? 0,
      startedAt: c.timestamp,
      completedAt: c.completedAt ?? null,
    })),
    messages: session.messages.map(m => ({
      id: m.id,
      source: typeof m.source === 'string' ? m.source : m.source.type,
      content: m.content,
      timestamp: m.timestamp,
    })),
    finalMoodSignals: null,
    achievements: [],
    xpGained: 0,
    sentiment: null,
  };
}

function loadEvents(sessionId: string): HistoryEvent[] {
  const eventsPath = historyEventsPath(sessionId);
  if (!existsSync(eventsPath)) return [];
  const lines = readFileSync(eventsPath, 'utf-8').split('\n').filter(l => l.trim());
  const events: HistoryEvent[] = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line) as HistoryEvent); } catch { continue; }
  }
  return events;
}

function findSession(idOrName: string): { id: string; summary: SessionSummary } | null {
  // Try exact ID match first
  const summaryPath = historySessionSummaryPath(idOrName);
  if (existsSync(summaryPath)) {
    try {
      return { id: idOrName, summary: JSON.parse(readFileSync(summaryPath, 'utf-8')) as SessionSummary };
    } catch { /* fall through */ }
  }
  // Exact-ID path with no session.json — try live rebuild before falling back to search
  if (existsSync(historySessionDir(idOrName))) {
    const live = buildLiveSummary(idOrName);
    if (live) return { id: idOrName, summary: live };
  }
  // Search by name or partial ID (loadAllSummaries handles live rebuild for in-flight sessions)
  const all = loadAllSummaries();
  return all.find(s =>
    s.id.startsWith(idOrName) ||
    s.summary.name === idOrName ||
    s.summary.name?.includes(idOrName),
  ) ?? null;
}

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------

function parseSince(since: string): number {
  const match = since.match(/^(\d+)\s*(d|h|m|w)$/);
  if (!match) {
    exitUsage('invalid-since', `invalid --since format "${since}"`, {
      received: since,
      expected: 'duration like 7d, 24h, 30m, or 2w',
    });
  }
  const n = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const ms = { d: 86400000, h: 3600000, m: 60000, w: 604800000 }[unit]!;
  return Date.now() - n * ms;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function listSessions(opts: {
  cwd?: string; status?: string; since?: string; search?: string;
  limit: number;
}): void {
  let sessions = loadAllSummaries();

  if (opts.cwd) {
    const abs = resolve(opts.cwd);
    sessions = sessions.filter(s => s.summary.cwd === abs);
  }
  if (opts.status) {
    sessions = sessions.filter(s => s.summary.status === opts.status);
  }
  if (opts.since) {
    const cutoff = parseSince(opts.since);
    sessions = sessions.filter(s => new Date(s.summary.startedAt).getTime() >= cutoff);
  }
  if (opts.search) {
    const q = opts.search.toLowerCase();
    sessions = sessions.filter(s =>
      s.summary.task.toLowerCase().includes(q) ||
      (s.summary.name ?? '').toLowerCase().includes(q) ||
      s.summary.messages.some(m => m.content.toLowerCase().includes(q)),
    );
  }

  sessions = sessions.slice(0, opts.limit);

  emitJsonOk({ sessions: sessions.map(s => s.summary) });
}

function showSession(idOrName: string, opts: { events: boolean }): void {
  const found = findSession(idOrName);
  if (!found) {
    exitUsage('not-found', `session "${idOrName}" not found`, {
      received: idOrName,
      next: 'sis history  # list available sessions',
    });
  }

  const { id, summary: s } = found;

  if (opts.events) {
    const events = loadEvents(id);
    emitJsonOk({ events });
    return;
  }

  emitJsonOk({ session: s });
}


function showStats(opts: { cwd?: string; since?: string }): void {
  // Exclude in-flight sessions — their activeMs/wallClockMs are live snapshots that
  // would skew aggregate averages, efficiency, and percentiles.
  let sessions = loadAllSummaries().filter(s => s.summary.completedAt != null);

  if (opts.cwd) {
    const abs = resolve(opts.cwd);
    sessions = sessions.filter(s => s.summary.cwd === abs);
  }
  if (opts.since) {
    const cutoff = parseSince(opts.since);
    sessions = sessions.filter(s => new Date(s.summary.startedAt).getTime() >= cutoff);
  }

  const completed = sessions.filter(s => s.summary.status === 'completed');
  const killed = sessions.filter(s => s.summary.status === 'killed');
  const totalActiveMs = sessions.reduce((sum, s) => sum + s.summary.activeMs, 0);
  const totalAgents = sessions.reduce((sum, s) => sum + s.summary.agentCount, 0);
  const totalCycles = sessions.reduce((sum, s) => sum + s.summary.cycleCount, 0);
  const totalMessages = sessions.reduce((sum, s) => sum + s.summary.messages.length, 0);

  // Per-project breakdown
  const byProject = new Map<string, { count: number; activeMs: number; agents: number }>();
  for (const { summary: s } of sessions) {
    const proj = s.cwd;
    const entry = byProject.get(proj) ?? { count: 0, activeMs: 0, agents: 0 };
    entry.count++;
    entry.activeMs += s.activeMs;
    entry.agents += s.agentCount;
    byProject.set(proj, entry);
  }

  // Avg session duration
  const avgMs = totalActiveMs / sessions.length;

  // Efficiency
  const efficiencyValues: number[] = [];
  for (const { summary: s } of sessions) {
    const eff = s.efficiency ?? (s.wallClockMs
      ? Math.max(0, s.activeMs - (s.userBlockedMs ?? 0))
        / Math.max(1, s.wallClockMs - (s.userBlockedMs ?? 0))
      : null);
    if (eff != null) efficiencyValues.push(eff);
  }
  const avgEfficiency = efficiencyValues.length > 0
    ? efficiencyValues.reduce((a, b) => a + b, 0) / efficiencyValues.length
    : null;

  // Duration distributions (p50/p90)
  const sortedActiveMs = sessions.map(s => s.summary.activeMs).sort((a, b) => a - b);
  const n = sortedActiveMs.length;
  const p50Ms = n >= 3 ? sortedActiveMs[Math.ceil(50 / 100 * n) - 1]! : null;
  const p90Ms = n >= 3 ? sortedActiveMs[Math.ceil(90 / 100 * n) - 1]! : null;

  // Per-agent-type performance
  const agentTypeMap = new Map<string, { count: number; totalMs: number; crashed: number; completed: number }>();
  for (const { summary: s } of sessions) {
    for (const a of s.agents) {
      const type = a.agentType ?? 'untyped';
      const entry = agentTypeMap.get(type) ?? { count: 0, totalMs: 0, crashed: 0, completed: 0 };
      entry.count++;
      entry.totalMs += a.activeMs;
      if (a.status === 'crashed') entry.crashed++;
      if (a.status === 'completed') entry.completed++;
      agentTypeMap.set(type, entry);
    }
  }

  // Temporal patterns
  const hourBlocks = new Map<string, number>();
  const dayCounts = new Map<string, number>();
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const { summary: s } of sessions) {
    const d = new Date(s.startedAt);
    const hour = d.getHours();
    const blockStart = hour - (hour % 2);
    const blockLabel = `${String(blockStart).padStart(2, '0')}:00–${String(blockStart + 2).padStart(2, '0')}:00`;
    hourBlocks.set(blockLabel, (hourBlocks.get(blockLabel) ?? 0) + 1);
    const day = dayNames[d.getDay()]!;
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
  }

  emitJsonOk({
    total: sessions.length,
    completed: completed.length,
    killed: killed.length,
    totalActiveMs,
    avgActiveMs: Math.round(avgMs),
    avgEfficiency,
    p50Ms,
    p90Ms,
    totalAgents,
    totalCycles,
    totalMessages,
    byProject: Object.fromEntries([...byProject.entries()].map(([k, v]) => [k, v])),
    agentTypes: Object.fromEntries([...agentTypeMap.entries()].map(([k, v]) => [k, {
      ...v,
      avgMs: Math.round(v.totalMs / v.count),
      crashRate: v.count > 0 ? v.crashed / v.count : 0,
      completionRate: v.count > 0 ? v.completed / v.count : 0,
    }])),
    temporalPatterns: sessions.length >= 5 ? {
      hourBlocks: Object.fromEntries(hourBlocks),
      dayOfWeek: Object.fromEntries(dayCounts),
    } : null,
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerHistory(program: Command): void {
  program
    .command('history')
    .description('Browse session history and metrics')
    .argument('[session]', 'Session ID or name to inspect')
    .option('--cwd <path>', 'Filter by project directory')
    .option('--status <status>', 'Filter by status (completed, killed)')
    .option('--since <duration>', 'Filter by recency (e.g. 7d, 24h, 2w)')
    .option('--search <query>', 'Search task text and messages')
    .option('--events', 'Show raw event timeline')
    .option('--stats', 'Show aggregate statistics')
    .option('--limit <n>', 'Max sessions to show', '20')
    .addHelpText('after', `
session inspect history: browse past sessions, session detail, events, and aggregate stats.

Input
  [session]           optional — session ID (exact or prefix) or name; omit to list
  --cwd <path>        optional — filter list to sessions started in this project directory
  --status <status>   optional — filter by status: completed | killed
  --since <duration>  optional — filter by recency: 7d | 24h | 30m | 2w
  --search <query>    optional — substring search across task text and messages
  --events            optional — with [session]: emit raw event timeline instead of summary
  --stats             optional — emit aggregate statistics across all matched sessions
  --limit <n>         optional — max sessions returned in list mode; default 20

Output (stdout, JSON)
  list mode:   { ok, schema_version: 1, data: { sessions: [SessionSummary, ...] } }
  detail mode: { ok, schema_version: 1, data: { session: SessionSummary } }
  events mode: { ok, schema_version: 1, data: { events: [HistoryEvent, ...] } }
  stats mode:  { ok, schema_version: 1, data: { total, completed, killed, avgActiveMs, avgEfficiency, ... } }
  on error:    { ok: false, schema_version: 1, error: { code, message } }
  All responses carry schema_version: 1.

Effects
  None. Read-only.

Exit codes: 0 ok | 2 usage.`)
    .action(async (session: string | undefined, opts: {
      cwd?: string; status?: string; since?: string; search?: string;
      events?: boolean; stats?: boolean; limit: string;
    }) => {
      const limit = parseInt(opts.limit, 10) || 20;

      if (opts.stats) {
        showStats({ cwd: opts.cwd, since: opts.since });
        return;
      }

      if (session) {
        showSession(session, { events: opts.events ?? false });
        return;
      }

      listSessions({
        cwd: opts.cwd,
        status: opts.status,
        since: opts.since,
        search: opts.search,
        limit,
      });
    });
}
