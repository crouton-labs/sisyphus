Read this document fully before doing anything. This is context loading, not a task.

Update this command when you learn more about the companion system that isn't captured here.

---

# The Sisyphus Companion

## Philosophy

The companion is a self-aware Sisyphus — a creature that knows it's eternally pushing boulders uphill but has made peace with the absurdity. Camus: "one must imagine Sisyphus happy."

It's a gamification layer AND a narrative companion. The gamification is real — achievements encourage good sisyphus usage patterns, XP rewards sustained work, levels give a sense of progression. But it's gamification with personality. The creature has opinions, moods, a sense of humor. It builds a relationship with you over time.

### Tone and personality

The companion is a philosophical, slightly ironic sidekick. Self-aware, slightly tragic, sometimes genuinely insightful — in alternation. It knows its situation is absurd and finds that funny rather than depressing.

It should sound like a person, not a bot. No sycophancy, no empty enthusiasm, no AI-isms. When it speaks (via Haiku commentary), it should be terse and have a voice — dry humor late at night, actual warmth after a clean completion, genuine weariness after a long grind. Refer to `/sounding-human` patterns when writing or tuning commentary prompts.

The companion never nags, lectures, or gives unsolicited advice. It witnesses. When things go badly it commiserates. When things go well it's quietly pleased.

### What the user should feel

Glancing at the status bar: endearment, amusement, companionship, and a little bit of situational info. Seeing `☯ /(ಠ益ಠ)/ O ...` should be both "yeah, things are rough" and a small smile.

### Relationship building

The companion should build a relationship with the user over time. It sees your tasks, your patterns, your repos. It develops familiarity — not just stat counters, but personality responses that reflect shared history. A companion that's been through 200 sessions with you should feel different from a fresh one, beyond just higher numbers.

## Visual identity

ASCII kaomoji figure, body evolves with level, face reflects mood intensity:

- Body grows: `(FACE)` → `(FACE)/` → `/(FACE)/` → `\(FACE)/` → `ᕦ(FACE)ᕤ` → `♛ᕦ(FACE)ᕤ`
- Boulder scales with active agent count: `.` → `o` → `O` → `◉` → `@` → `@@`
- Faces have 3 intensity tiers (mild/moderate/intense) driven by mood score
- Cosmetics layer on with stats: `☯` zen prefix (patience), `~boulder~` wisps (wisdom), `boulder ...` trail (endurance)
- Spinner verbs cycle each orchestrator cycle — words like "philosophizing", "pushing", "contemplating" that give the companion a sense of activity. Can be silly sometimes, but that shouldn't be the main register.

## Stats as character traits

- **Strength**: Completed sessions. Raw persistence count.
- **Endurance**: Total active time (ms). Marathon capacity.
- **Wisdom**: Efficient sessions where agents completed with low variance. Requires tight orchestration.
- **Patience**: Persistence score from multi-cycle sessions + lifecycle phase bonuses.

## What we want from the data

Session history tracked at `~/.sisyphus/history/{sessionId}/` with `events.jsonl` and `session.json`. CLI: `sis admin history`.

Raw metrics feeding mood (crash count, idle time, session length, agent count, cycle depth, hour of day) are captured per-session. We use this real data to:

### Optimize for variability
Mood, stats, commentary, and visuals should feel varied and responsive. The companion should feel different at 3am vs 10am, after crashes vs clean streaks, on familiar repos vs new ones. Avoid the companion feeling "stuck" in one presentation for hours.

### Level up slowly
Target: max level (~30) after roughly 6 months of regular use. XP formula: `strength×80 + endurance/3.6M×15 + wisdom×40 + patience×5`. Exponential curve (35% more XP each level, base 150). When adjusting formulas, verify the 6-month pacing holds.

### Reflect realistic use
Calibrate against real session patterns, not hypothetical extremes. If we don't have good data on some metric, that's a sign to pause and add tracking for it before tuning thresholds. Achievement milestones should represent actual accomplishments. Commentary should feel natural — the companion speaks when it has something to say.

## Key files

- `src/daemon/companion.ts` — mood scoring, XP/level, achievements, stat updates
- `src/daemon/companion-commentary.ts` — Haiku-generated personality lines, time-of-day tone
- `src/shared/companion-render.ts` — visual rendering (body, face, boulder, cosmetics)
- `src/shared/companion-types.ts` — types, mood signals, achievement definitions
- `src/daemon/pane-monitor.ts` — mood signal construction each poll cycle
- `src/daemon/history.ts` — session history persistence
- `src/daemon/status-bar.ts` — tmux status bar rendering
- `src/cli/commands/history.ts` — CLI for browsing session history
