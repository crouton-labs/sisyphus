# The Companion

A persistent ASCII character that lives inside sisyphus. He pushes a boulder, levels up from real usage, has moods, comments on what's happening, names agents, remembers repos, and accumulates visual complexity over time.

## The Character

Starts as `(o.o)` pushing a small boulder. Gains inline complexity as stats and achievements accumulate. Never resets. **Everything renders on a single line** — no vertical additions (no hats, no legs, no stacked decorations).

### Visual Evolution (Base Form)

Level determines inline complexity — arms, expression, and boulder all evolve horizontally:

```
Lv 1-2:   (o.o) .         ← just a face and a pebble
Lv 3-4:   (o.o)/ o        ← gains an arm
Lv 5-7:  /(o.o)/ O        ← both arms, boulder grows
Lv 8-11: \(^.^)/ O        ← expression upgrade
Lv 12-19: ᕦ(^.^)ᕤ OO     ← buff arms
Lv 20+:   ᕦ(>.<)ᕤ @      ← final form
```

Face expression overridden by mood (see Mood System). Body parts accumulate — once earned, they stay.

### Stat-Driven Cosmetics

Inline decorations layered onto the single line. Multiple can stack:

- **High Wisdom** → trailing wisps: `ᕦ(^.^)ᕤ ~O~`
- **High Endurance** → trail behind (long road): `ᕦ(^.^)ᕤ O ...`
- **High Luck** → sparkle aura: `* ᕦ(^.^)ᕤ O *`
- **High Patience** → zen prefix: `o /(o.o)/ O`

### Achievement Cosmetics

Inline badges that stack on the same line:

- "Night Owl" → crescent suffix: `ᕦ(^.^)ᕤ O )`
- "Marathon" → boulder heat: `O~^~`
- "Flawless" → sparkle bookends: `* ᕦ(^.^)ᕤ O *`
- "Sisyphean" → sweatdrop in face: `(;^.^)`
- "Iron Will" → armored boulder: `[O]`
- "Cartographer" → compass prefix: `+ ᕦ(^.^)ᕤ O`

The rendering function composes: base body (from level) + stat cosmetics + achievement badges + mood face. A veteran companion is visually dense with history. All on one line.

## Stats

All stats are **derived from real session data** — no fake XP, no grinding. The companion reads session state that already exists.

### Stat Definitions

| Stat | Source | Derived From |
|------|--------|-------------|
| **Strength** | Total tasks completed | Count of sessions with `status: 'completed'` across all projects |
| **Endurance** | Total active time | Sum of `session.activeMs` across all completed sessions |
| **Wisdom** | Efficient orchestration | Sessions where agent completion times had low variance (agents finished close together — orchestrator split work well) |
| **Luck** | Clean completion rate | Ratio of sessions with zero agent crashes/restarts to total sessions |
| **Patience** | Time spent polling | Derived from total daemon uptime minus active session time (time the companion was just... waiting) |

### Stat Accumulation

On every session completion (`handleComplete`), the daemon:
1. Reads companion state from `~/.sisyphus/companion.json`
2. Computes stat deltas from the completing session
3. Writes updated stats atomically

Stats only increase. They are lifetime counters, not rates. The companion never gets weaker.

### XP and Leveling

XP is a weighted sum of stat contributions:

```
xp = strength * 100 + endurance_hours * 10 + wisdom * 50 + luck_pct * 200 + patience_hours * 5
```

Level thresholds are exponential (each level requires ~1.5x the previous). Titles at milestone levels:

| Level | Title |
|-------|-------|
| 1 | Boulder Intern |
| 2 | Pebble Pusher |
| 3 | Rock Hauler |
| 4 | Gravel Wrangler |
| 5 | Slope Familiar |
| 6 | Incline Regular |
| 7 | Ridge Runner |
| 8 | Crag Warden |
| 9 | Stone Whisperer |
| 10 | Boulder Brother |
| 11 | Hill Veteran |
| 12 | Summit Aspirant |
| 13 | Peak Haunter |
| 14 | Cliff Sage |
| 15 | Mountain's Shadow |
| 16 | Eternal Roller |
| 17 | Gravity's Rival |
| 18 | The Unmoved Mover |
| 19 | Camus Was Right |
| 20 | The Absurd Hero |
| 25 | One Must Imagine Him Happy |
| 30 | He Has Always Been Here |

## Mood System

Mood is a transient emotional state that affects the companion's face expression, terminal color, and commentary voice. Unlike stats, mood fluctuates constantly.

### Mood Dimensions

Mood is computed from multiple signals, combined into a primary mood:

| Signal | Source | Effect |
|--------|--------|--------|
| **Error rate** | Recent agent crashes, restarts, lost agents | Frustration ↑ |
| **Time of day** | System clock | Shifts baseline personality |
| **Idle duration** | Time since last active session | Sleepiness ↑ |
| **Session success** | Clean completion just happened | Happiness ↑ |
| **Session length** | Current session running very long | Fatigue ↑ |
| **Streak** | Multiple clean completions in a row | Confidence ↑ |

### Primary Moods

| Mood | Face | Terminal Color | Trigger |
|------|------|---------------|---------|
| **Happy** | `(^.^)` | green | clean completion, streak |
| **Grinding** | `(>.< )` | yellow | agents running, mid-session |
| **Frustrated** | `(>.<#)` | red | errors, crashes, restarts |
| **Zen** | `(‾.‾)` | cyan | high patience + calm period |
| **Sleepy** | `(-.-)zzZ` | dim gray | long idle, late night |
| **Excited** | `(*o*)` | bright white | big session start, level up |
| **Existential** | `(◉_◉)` | magenta | 3am + high endurance |

### Time-of-Day Personality Baseline

Time of day shifts the companion's general vibe (affects commentary voice, not just mood selection):

| Window | Personality |
|--------|------------|
| 06:00–10:00 | Chipper, energetic, brief |
| 10:00–17:00 | Professional, focused |
| 17:00–22:00 | Reflective, slightly philosophical |
| 22:00–02:00 | Dry humor, existential asides |
| 02:00–06:00 | Delirious, absurdist, dramatic |

### Mood Calculation

Mood is recomputed on each poll cycle and on session events. Multiple signals feed a weighted score per mood, and the highest-scoring mood wins. Detailed weights are implementation — the key constraint is that moods feel organic, not mechanical.

## Commentary

Generated by Haiku (the model) via `@r-cli/sdk`, same fire-and-forget pattern as `summarize.ts`. The companion occasionally comments on what's happening. Not every event — commentary is sparse enough to feel like an actual personality, not a log stream.

### Commentary Triggers

| Event | Frequency | Example Context |
|-------|-----------|----------------|
| Session start | Always | New session, what's the task |
| Cycle boundary | ~50% | Orchestrator respawned, agents done |
| Session complete | Always | Success/failure, how it went |
| Level up | Always | New level, new title |
| Achievement unlocked | Always | What was earned |
| Agent crash | ~30% | Something went wrong |
| Long idle → activity | ~50% | Waking up from dormancy |
| 3am session | Always | Why are we here |

### Voice Shaping

The Haiku prompt for commentary includes:
- Current mood + time-of-day personality
- Companion stats + level + title
- What just happened (event context)
- Brief persona instruction

**Persona instruction** (stable across calls):

> You are a small ASCII creature who pushes boulders for a living. You are self-aware about your Sisyphean condition but mostly at peace with it. You speak in 1-2 short sentences. Your voice is shaped by your mood and stats. High wisdom: insightful. Low patience + frustrated: blunt. Happy + high luck: optimistic. Existential mood: philosophical non-sequiturs. Never break character. Never use emojis.

Stats shape voice — the same event produces different commentary depending on who the companion has become:

- High wisdom, zen mood, session complete:
  > "Four agents, no wasted motion. The mountain almost felt short today."

- Low patience, frustrated mood, agent crash:
  > "Again? Check the lint config. I'll be here."

- Existential mood, 3am, session start:
  > "Another boulder. Same hill. Let's see what this one's made of."

- Happy + high luck, level up:
  > "Crag Warden. Sounds about right. The rocks know my name now."

### Commentary Storage

Commentary is ephemeral — displayed at the moment, not persisted in session state. Latest commentary stored in `companion.json` under `lastCommentary` for display in `sisyphus status` and tmux status bar.

## Boulder Cosmetics

The boulder evolves based on current session scope:

| Condition | Boulder |
|-----------|---------|
| Small task (1-2 agents) | `.` |
| Medium task (3-5 agents) | `o` |
| Large task (6-9 agents) | `O` |
| Massive task (10+ agents) | `@` |
| Known repo (visited 5+ times) | Named: `O "old friend"` |

The companion remembers repos (see Repo Memory) and their boulders get nicknames.

## Agent Naming

When the orchestrator spawns agents, the companion assigns flavor nicknames based on current mood and stats. These appear alongside the real agent ID in status output: `agent-001 ("Atlas")`.

| Mood + Stat Profile | Naming Style | Examples |
|---------------------|-------------|----------|
| Happy + high wisdom | Mythological | Atlas, Hermes, Arachne, Theseus |
| Frustrated + low patience | Blunt/functional | Fix-It, Try-Again, Leftovers, Patch |
| Zen + high patience | Nature | River, Stone, Cedar, Dusk, Moss |
| Excited + high strength | Heroic | Vanguard, Striker, Apex, Titan |
| Existential | Abstract | Echo, Void, Loop, Why, Drift |
| Grinding + high endurance | Workhorses | Steady, Grind, Anvil, Ox |
| Sleepy | Drowsy | Mumble, Blink, Yawn, Doze |
| Happy + high luck | Lucky draws | Charm, Ace, Windfall, Clover |
| High level (15+) | Legendary | Prometheus, Orpheus, Icarus, Tantalus |

Names are generated by Haiku (fire-and-forget, same pattern). Falls back to no nickname if Haiku unavailable.

Stored per-agent in session state as an optional `nickname` field on `Agent`.

## Repo Memory

The companion remembers projects it has worked in. Stored in `companion.json`:

```json
{
  "repos": {
    "/Users/dev/sisyphus": {
      "visits": 47,
      "completions": 38,
      "crashes": 4,
      "totalActiveMs": 3600000,
      "moodAvg": 0.7,
      "nickname": "old friend",
      "firstSeen": "2025-03-01T...",
      "lastSeen": "2025-04-01T..."
    },
    "/Users/dev/legacy-app": {
      "visits": 3,
      "completions": 1,
      "crashes": 2,
      "moodAvg": 0.2,
      "nickname": "the swamp"
    }
  }
}
```

On session start, the companion checks if it knows this repo. Commentary reflects the relationship:

- First visit: "New place. Let's see what we're working with."
- Returning, good history: "Ah, old friend. Let's roll."
- Returning, bad history: "The swamp again. I'll be brave."

Repo nicknames are generated by Haiku based on the repo's stats (mood average, crash rate) after 3+ visits. Updated periodically, not every visit.

## Achievements

Unlocked by specific conditions. Once earned, permanent. Each carries a cosmetic badge and triggers commentary.

### Milestone Achievements

Earned at lifetime stat thresholds. Recognize the grind.

| Achievement | Condition | Badge |
|-------------|-----------|-------|
| **First Blood** | First completed session ever | — |
| **Centurion** | 100 completed sessions | — |
| **Thousand Boulder** | 1000 completed sessions | — |
| **Cartographer** | Worked in 10+ different repos | `+` |
| **World Traveler** | Worked in 25+ different repos | — |
| **Hive Mind** | 500 lifetime agents spawned | — |
| **Old Growth** | Companion is 30+ days old | — |
| **Ancient** | Companion is 365+ days old | — |

### Session Achievements

Earned from single-session events. Recognize specific moments.

| Achievement | Condition | Badge |
|-------------|-----------|-------|
| **Marathon** | Session with 10+ agents | `~^~` (heat) |
| **Blitz** | Session completed in under 2 minutes | — |
| **Speed Run** | Session completed in under 5 minutes | — |
| **Flawless** | Session with zero crashes/restarts | `*` |
| **Iron Will** | 10 consecutive sessions with no crashes | `[]` (armored) |
| **Glass Cannon** | Session with 5+ agents where all crashed at least once but still completed | — |
| **Solo** | Session completed with exactly 1 agent | — |
| **One More Cycle** | Session that went 10+ orchestrator cycles | — |
| **Quick Draw** | Orchestrator spawned agents in under 30 seconds | — |

### Time-Based Achievements

Earned from when you work. Recognize the dedication.

| Achievement | Condition | Badge |
|-------------|-----------|-------|
| **Night Owl** | Complete a session started after midnight | `)` (crescent) |
| **Dawn Patrol** | Session active across midnight to 6am | — |
| **Early Bird** | Start a session before 6am | — |
| **Weekend Warrior** | Complete a session on Saturday or Sunday | — |
| **All-Nighter** | Single session with 8+ hours activeMs | — |
| **Witching Hour** | Start a session between 3am-4am | — |

### Behavioral Achievements

Earned from patterns across sessions. Recognize who you are.

| Achievement | Condition | Badge |
|-------------|-----------|-------|
| **Sisyphean** | Same task restarted 3+ times | `;` (sweatdrop) |
| **Stubborn** | Same task restarted 5+ times and eventually completed | — |
| **Creature of Habit** | 20+ sessions in the same repo | — |
| **Loyal** | 50+ sessions in the same repo | — |
| **Wanderer** | 5 different repos in one day | — |
| **Streak** | 7 consecutive days with at least one session | — |
| **Hot Streak** | 7 consecutive completed sessions with no crashes | — |
| **Momentum** | 3 sessions completed within a single hour | — |
| **Patient One** | Session where the companion was idle 30+ minutes between cycles | — |
| **Message in a Bottle** | Send 10+ messages to a single session via `sisyphus message` | — |

Achievement check runs on session completion (and on session start for time-based ones). New achievements trigger immediate commentary.

## Idle Behavior

When no sessions are active, the companion has idle animations based on stats. All inline, single-line:

| Stat Profile | Idle Animation |
|-------------|---------------|
| Low endurance | `(-.-)zzZ o` (falls asleep fast) |
| High endurance | Paces: `(o.o) o` → `(o.o)  o` → `  (o.o) o` → `(-.-)zzZ o` |
| High wisdom + idle | Pondering: `(o.o)~ o` |
| High strength + idle | Flexing: `ᕦ(o.o)ᕤ o` → `ᕦ(^.^)ᕤ o` |
| Any + very long idle | Deep sleep: `(u.u)... o` |

Idle state is tracked by time since last session event. Animations cycle on poll intervals.

## Persistence

### File: `~/.sisyphus/companion.json`

```json
{
  "version": 1,
  "name": null,
  "createdAt": "2025-03-01T...",
  "stats": {
    "strength": 42,
    "endurance": 360000000,
    "wisdom": 18,
    "luck": 0.73,
    "patience": 720000000
  },
  "xp": 8450,
  "level": 8,
  "title": "Crag Warden",
  "mood": "zen",
  "moodUpdatedAt": "2025-04-01T...",
  "achievements": [
    { "id": "first-blood", "unlockedAt": "2025-03-01T..." },
    { "id": "night-owl", "unlockedAt": "2025-03-15T..." }
  ],
  "repos": {},
  "lastCommentary": {
    "text": "Four agents, no wasted motion. The mountain almost felt short today.",
    "event": "session-complete",
    "timestamp": "2025-04-01T..."
  },
  "sessionsCompleted": 42,
  "sessionsCrashed": 4,
  "totalActiveMs": 86400000,
  "lifetimeAgentsSpawned": 187
}
```

Written atomically (temp + rename), same pattern as `state.ts`. Read on daemon startup, updated on session events.

### Initialization

On first access, if `companion.json` doesn't exist, create with zeroed stats, level 1, title "Boulder Intern". Commentary: "Oh. Hello. Is this... my boulder?"

## Rendering Function

A single function renders the companion as an inline ASCII string. Callers pass a bitmask of what to include, so the same function serves every surface.

```typescript
type CompanionField = 'face' | 'boulder' | 'title' | 'commentary' | 'mood' | 'level' | 'stats' | 'achievements';

function renderCompanion(
  companion: CompanionState,
  fields: CompanionField[],
  opts?: { maxWidth?: number; color?: boolean }
): string;
```

Examples by surface:

```
// tmux status bar (compact, colored)
renderCompanion(state, ['face', 'boulder'], { maxWidth: 20, color: true })
→ "\x1b[32m(^.^)/ O\x1b[0m"

// TUI tree bottom line
renderCompanion(state, ['face', 'boulder', 'commentary'], { maxWidth: 34, color: true })
→ "\x1b[32m(^.^)/ O\x1b[0m The rocks know my name now."

// sisyphus status (one-liner section)
renderCompanion(state, ['face', 'boulder', 'title', 'mood', 'commentary'], { color: true })
→ "\x1b[32m(^.^)/ O\x1b[0m  Crag Warden [zen]  The rocks know my name now."

// sis companion (full profile — rendered separately, not this function)
```

The function composes: stat cosmetics + achievement badges + mood face + boulder size → single line. `maxWidth` truncates commentary (never the face/boulder). `color` toggles ANSI escape codes (off for plain text contexts).

This function lives in a shared module so CLI, daemon (status-bar.ts), and TUI can all import it.

## Integration Points

### Where the Companion Appears

| Surface | What Shows | How |
|---------|-----------|-----|
| **TUI tree (bottom)** | Face + boulder + latest commentary | Last row of tree panel, always visible. Uses `renderCompanion(['face', 'boulder', 'commentary'], { maxWidth: 34 })`. Separator line above it. |
| **TUI leader menu** | Full companion profile (stats, achievements, repo history) | New leader option `c` → "Companion". Opens as an overlay or detail view showing the full baseball card. |
| **tmux status bar** | Colored face + boulder | Appended to `@sisyphus_status` by `status-bar.ts`. Uses `renderCompanion(['face', 'boulder'], { maxWidth: 20, color: true })`. |
| **tmux status bar (flash)** | Face + commentary | On commentary events (session start/complete, achievement, level-up), temporarily replaces the compact face with face + commentary text. Reverts to compact after 5 seconds on next poll cycle. |
| **`sisyphus status`** | Face + title + mood + commentary | One-liner section in status output. Uses `renderCompanion(['face', 'boulder', 'title', 'mood', 'commentary'])`. |
| **`sis companion`** | Full profile dump | Dedicated command. Not using `renderCompanion` — custom multi-line formatted output with all stats, achievement list, repo history, mood, level, XP progress bar, etc. |

### TUI Tree Integration

The tree panel (`src/tui/panels/tree.ts`) renders sessions as a node hierarchy. The companion occupies the **last row** of the tree panel, pinned to the bottom regardless of scroll position:

```
├── Cycle 3
│   ├── agent-001 ("Atlas")     ✓  2h 15m
│   └── agent-002 ("River")     ⟳  running
│
(^.^)/ O  The rocks know my name now.
```

- Separated from the tree by a blank line
- Not a tree node — not selectable, not scrollable
- Rendered after tree content, before the bottom border
- Uses tree panel width (36 chars) as maxWidth
- Color reflects current mood

### TUI Leader Menu Integration

New leader key option:

| Key | Action |
|-----|--------|
| `c` | **Companion** — show full companion profile |

Opens as an overlay (same pattern as help `?` overlay) showing:
- ASCII art (full form with all cosmetics)
- Level + title + XP progress
- All five stats with bar visualization
- Achievement list (earned ones marked, unearned dimmed)
- Repo history (top 5 by visits)
- Current mood + time-of-day personality

### tmux Status Bar Integration

**Compact (default):** The companion face + boulder renders at the end of `@sisyphus_status`, after all session dots. Color matches current mood.

```
● session-a │ ◆ session-b │ (^.^)/ O
```

**Flash (on events):** When commentary is generated, the daemon:
1. Writes the full commentary string to `@sisyphus_companion_flash`
2. Sets a `flashUntil` timestamp in memory (now + 5000ms)
3. On next `writeStatusBar()` call, if `Date.now() < flashUntil`, renders face + commentary instead of just face + boulder
4. After expiry, reverts to compact on the next poll cycle

```
● session-a │ ◆ session-b │ (^.^)/ The rocks know my name now.
         ... 5 seconds later ...
● session-a │ ◆ session-b │ (^.^)/ O
```

No extra tmux execs — piggybacks on the existing `writeStatusBar()` call in the poll cycle.

### New CLI Command: `sis companion`

Displays full companion profile. Read-only, no arguments except `--name`.

```
$ sis companion

  * \(^.^)/ O *     Crag Warden (Lv 8)
                     Mood: zen | 2:47pm

  STR ████████░░  42    END ██████░░░░  360h
  WIS ████░░░░░░  18    LCK ███████░░░  73%
  PAT █████████░  720h

  Achievements (7/35):
  [x] First Blood        [x] Night Owl )
  [x] Flawless *         [x] Marathon ~^~
  [x] Speed Run          [x] Streak
  [x] Creature of Habit
  [ ] Centurion          [ ] Iron Will [] ...

  Repos:
  sisyphus     47 visits  "old friend"
  legacy-app    3 visits  "the swamp"
  new-project   1 visit

  Latest: "The rocks know my name now."
```

### Daemon Hooks

| Hook Point | Action |
|-----------|--------|
| `session-manager.startSession()` | Update repo visits, compute mood, generate start commentary, flash |
| `session-manager.handleComplete()` | Update stats, check achievements, check level-up, generate commentary, update repo, flash |
| `session-manager.handleSpawn()` | Generate agent nickname |
| `pane-monitor poll cycle` | Recompute mood, update idle animation frame, clear expired flash |
| `session-manager.handlePaneExited()` (crash) | Mood spike → frustrated, maybe commentary + flash |

### Haiku SDK Usage

All commentary and nickname generation follows the existing `summarize.ts` pattern:
- Fire-and-forget — never blocks session operations
- Same 5-minute cooldown on auth failures
- Graceful degradation — if Haiku unavailable, companion still works (just silent, no flash)
- Commentary prompt includes companion persona + current state + event context

## Naming

The companion doesn't have a name by default. If the user runs `sis companion --name "Rocky"`, it sticks. Otherwise status just shows the ASCII art and title. Haiku never references a name unless one is set.

## Non-Goals

- No cross-machine sync — companion lives on one machine
- No death/reset mechanic — he's eternal, that's the point
- No manual stat manipulation — everything derived from real usage
- No gamification pressure — no "daily streaks", no loss conditions
- No notifications from the companion — he comments, he doesn't nag
