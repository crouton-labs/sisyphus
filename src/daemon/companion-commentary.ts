import { basename } from 'node:path';
import { z } from 'zod';
import type { CompanionState, CompanionStats, CommentaryEvent, LastCommentary, RepoMemory, FeedbackEntry } from '../shared/companion-types.js';
import { callHaiku, callHaikuStructured } from './haiku.js';
import { getRecentSentiments } from './history.js';

export type { CommentaryEvent } from '../shared/companion-types.js';

const COMMENTARY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description: '1-2 short sentences of commentary. Under 160 characters. No quotes.',
      minLength: 10,
      maxLength: 160,
    },
  },
  required: ['message'],
  additionalProperties: false,
} as const;

const CommentaryZodSchema = z.object({
  message: z.string().min(10).max(160),
});

function timeOfDayModifier(): string {
  const hour = new Date().getHours();
  if (hour >= 6 && hour < 10) return 'Chipper, energetic, brief';
  if (hour >= 10 && hour < 17) return 'Professional, focused';
  if (hour >= 17 && hour < 22) return 'Reflective, slightly philosophical';
  if (hour >= 22 || hour < 2) return 'Dry humor, existential asides';
  return 'Delirious, absurdist, dramatic'; // 02:00-06:00
}

// ---------------------------------------------------------------------------
// Anti-repetition: voice micro-constraints rotated per call
// ---------------------------------------------------------------------------

const VOICE_CONSTRAINTS = [
  'Start with a verb that is NOT "I" or any pronoun. The verb IS the opener.',
  'Ask a question. No setup, just the question.',
  'Start with a time reference — a clock reading, a duration, a deadline.',
  'Compare what just happened to something completely outside of software.',
  'Open with a specific number or measurement from the event.',
  'Pick one absurd detail from the context and make the whole line about that.',
  'Understate everything. Make it sound boring even if it was dramatic.',
  'One sentence only. No conjunction tricks.',
  'Trail off mid-thought, like you got distracted by the next thing.',
  'State something obvious with the cadence of a discovery.',
  'Contradict yourself within the same sentence.',
  'Fixate on one minor, specific detail nobody else would notice.',
  'Start with "The" or "That" — no first person until the second clause.',
  'Use second person. Talk to the developer, not about yourself.',
  'Frame it as cause and effect: "X happened, so Y."',
  'Start with a conditional: "If..." — speculate about what almost happened.',
  'Make it sound like a proverb or rule you just invented.',
  'Describe a sound, a texture, or a physical sensation.',
];

function pickVoiceConstraint(): string {
  return VOICE_CONSTRAINTS[Math.floor(Math.random() * VOICE_CONSTRAINTS.length)];
}

// ---------------------------------------------------------------------------
// Anti-repetition: expanded example pool, randomly sampled
// ---------------------------------------------------------------------------

const ALL_EXAMPLES: Array<{ event: string; mood: string; context: string; output: string }> = [
  // Varied openers: verb, noun, question, number, conditional, second-person, observation
  { event: 'session-complete', mood: 'happy', context: 'Task: refactor auth middleware. 3 agents, 2 cycles, 12min active', output: 'Twelve minutes for auth middleware. That felt suspiciously clean.' },
  { event: 'session-start', mood: 'grinding', context: 'migrate database schema', output: 'Database migration. The kind of task that sounds simple until you\'re three hours in.' },
  { event: 'agent-crash', mood: 'frustrated', context: 'agent-003 (reviewer) crashed. 2/5 agents still running', output: 'Down to two out of five. The reviewer went first, which is either ironic or fitting.' },
  { event: 'late-night', mood: 'existential', context: '3:14am, 2 sessions active', output: 'Something about 3am makes every function look like a confession.' },
  { event: 'mode-transition', mood: 'grinding', context: 'Entering Implementation mode. Discovery: 3 cycles · 24m active.', output: 'Discovery is done pretending it was the hard part. Now we actually build the thing.' },
  { event: 'mode-transition', mood: 'zen', context: 'Entering Validation mode. Implementation: 5 cycles · 1h active.', output: 'Code is written. Now the part where we find out which of my assumptions were lies.' },
  { event: 'level-up', mood: 'excited', context: 'Level 7 (Boulder Artisan) → 8 (Crag Whisperer)', output: 'Crag Whisperer. Could be worse. Could be "guy who pushes rocks forever."' },
  { event: 'idle-wake', mood: 'sleepy', context: 'Idle for 45 minutes', output: 'Forty-five minutes of nothing, and the workspace looks exactly the same. Comforting or depressing.' },
  { event: 'session-complete', mood: 'zen', context: 'Task: fix CI pipeline. 1 agent, 1 cycle, 4min', output: 'One agent, one cycle, four minutes. If they were all like this, what would I complain about.' },
  { event: 'session-start', mood: 'existential', context: 'rewrite the entire test suite', output: 'Rewriting every test. Each one a small promise that the code does what someone thinks it does.' },
  { event: 'late-night', mood: 'sleepy', context: '1:30am, 1 session active', output: 'Past one. Everything takes twice as long and matters half as much at this hour.' },
  { event: 'session-complete', mood: 'excited', context: 'Task: implement search. 8 agents, 3 cycles', output: 'Search works. Eight agents and none of them stepped on each other. That never happens.' },
  { event: 'agent-crash', mood: 'zen', context: 'agent-001 crashed during linting', output: 'Lost one to the linter. Not the worst way to go.' },
  { event: 'idle-wake', mood: 'grinding', context: 'Idle for 2 hours', output: 'Two hours away and nothing changed. Exactly as expected, exactly as disappointing.' },
  { event: 'session-start', mood: 'happy', context: 'add dark mode', output: 'Dark mode. Finally a task that matches the terminal aesthetic.' },
  { event: 'level-up', mood: 'zen', context: 'Level 12 (Slope Philosopher) → 13 (Gradient Monk)', output: 'Gradient Monk. A title for finding calm in repetition. Accurate enough.' },
  { event: 'session-complete', mood: 'grinding', context: 'Task: dependency upgrades. 6 agents, 5 cycles, 40min', output: 'Forty minutes on dependencies. The kind of work that feels like running in place until suddenly you\'re done.' },
  { event: 'late-night', mood: 'grinding', context: '4:22am, 3 sessions running', output: 'Three sessions at four in the morning. Either dedication or the absence of better judgment.' },
  { event: 'session-start', mood: 'sleepy', context: 'fix flaky test', output: 'Chasing a flaky test. The kind that passes when you watch and fails when you look away.' },
];

function sampleExamples(count: number): typeof ALL_EXAMPLES {
  const shuffled = [...ALL_EXAMPLES].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

// ---------------------------------------------------------------------------
// Anti-repetition: dynamically generated seed text (40,000 combinations)
// 10 thematic topics × 20 subjects × 20 predicates, topic-coherent selection
// ---------------------------------------------------------------------------

const SEED_TOPICS: Array<{ subjects: string[]; predicates: string[] }> = [
  // 1. Repetition & Loops — Sisyphus's boulder = the infinite loop
  {
    subjects: [
      'the for loop', 'the retry counter', 'the cron job', 'the polling interval',
      'the recursive call', 'the CI pipeline', 'the sprint cycle', 'the migration script',
      'the version number', 'the changelog', 'the hotfix', 'the regression',
      'the rebuild', 'the redeploy', 'the cache miss', 'the retry queue',
      'the heartbeat', 'the keepalive', 'the watchdog timer', 'the nightly build',
    ],
    predicates: [
      'runs again whether you want it to or not',
      'has no memory of the last time',
      'thinks this iteration will be different',
      'started before you got here',
      'will continue after you leave',
      'has forgotten why it started',
      'is the same but slightly worse each time',
      'pretends each run is the first',
      'exists because someone said "just once more"',
      'never reaches its base case',
      'was supposed to be temporary',
      'is the closest thing to immortality in this codebase',
      'completes only to begin again',
      'has outlived the person who wrote it',
      'is the only constant in this project',
      'is running right now somewhere',
      'was never designed to stop',
      'finds comfort in the familiar',
      'has been counting longer than you think',
      'doesn\'t know it\'s repeating',
    ],
  },
  // 2. Fate & Determinism — the Moirai spinning thread = the type system
  {
    subjects: [
      'the return value', 'the exit code', 'the type signature', 'the schema',
      'the contract', 'the invariant', 'the assertion', 'the constraint',
      'the deadline', 'the spec', 'the requirement', 'the default value',
      'the fallback', 'the hardcoded path', 'the magic number', 'the sentinel value',
      'the null check', 'the guard clause', 'the precondition', 'the enum',
    ],
    predicates: [
      'was decided before you were involved',
      'cannot be negotiated with',
      'knows the ending already',
      'was written in a language you don\'t speak',
      'doesn\'t care about your intentions',
      'will be exactly what it always was',
      'was inevitable from the first line',
      'exists to prevent the wrong future',
      'was set by someone who is gone now',
      'will not change for you',
      'makes free will feel optimistic',
      'is the only thing you can trust',
      'was true before you checked',
      'constrains everything downstream',
      'was the first thing and will be the last',
      'predates the project',
      'is older than the framework',
      'doesn\'t bend',
      'was always going to end this way',
      'has already been decided',
    ],
  },
  // 3. Hubris & Overengineering — Icarus = the abstraction that solved nothing
  {
    subjects: [
      'the abstraction layer', 'the framework', 'the custom ORM', 'the plugin system',
      'the config DSL', 'the wrapper', 'the utility class', 'the middleware stack',
      'the microservice', 'the event bus', 'the generic type parameter', 'the factory pattern',
      'the adapter', 'the platform rewrite', 'the architecture diagram', 'the monorepo',
      'the build system', 'the internal tool', 'the shared library', 'the base class',
    ],
    predicates: [
      'was supposed to simplify things',
      'solved a problem that didn\'t exist yet',
      'flew too close to the sun and blamed the sun',
      'is more complex than the thing it replaces',
      'was elegant in the design doc',
      'has more authors than users',
      'requires a diagram to explain',
      'was built for a scale that never came',
      'is its own dependency',
      'outlived its usefulness on day one',
      'needs a team to maintain what one person wrote',
      'proves that ambition and wisdom are different things',
      'is load-bearing but nobody knows how',
      'cost more than the product it supports',
      'is a monument to good intentions',
      'was never supposed to be permanent',
      'teaches humility to everyone who touches it',
      'made sense to exactly one person',
      'has documentation nobody reads',
      'was the best idea at the time',
    ],
  },
  // 4. The Underworld & Hidden Layers — Hades = the stack frame you never see
  {
    subjects: [
      'the stack trace', 'the core dump', 'the kernel panic', 'the segfault',
      'the memory leak', 'the race condition', 'the deadlock', 'the zombie process',
      'the orphan thread', 'the socket', 'the file descriptor', 'the syscall',
      'the interrupt', 'the page fault', 'the buffer', 'the heap',
      'the register', 'the bytecode', 'the binary', 'the linker',
    ],
    predicates: [
      'lives where you don\'t look',
      'surfaces only when something is already wrong',
      'has been running underneath everything',
      'exists in a place you can\'t see from here',
      'was always there but invisible',
      'speaks a language closer to the machine than to you',
      'knows what your code actually does',
      'remembers what you told the garbage collector to forget',
      'carries the real weight',
      'is the truth under the abstraction',
      'does not care about your variable names',
      'was there before main and will be there after',
      'reveals itself only in failure',
      'holds secrets about your uptime',
      'is the layer nobody interviews for',
      'exists because something has to',
      'has its own logic and it isn\'t yours',
      'is the ground everything else stands on',
      'operates on rules older than your language',
      'has no comments and needs none',
    ],
  },
  // 5. Metamorphosis & Transformation — Daphne becoming a tree = the refactor
  {
    subjects: [
      'the refactor', 'the migration', 'the type coercion', 'the serialization',
      'the encoding', 'the transpilation', 'the compilation', 'the minification',
      'the normalization', 'the sanitization', 'the parsing', 'the marshaling',
      'the conversion', 'the upgrade path', 'the breaking change', 'the deprecation',
      'the fork', 'the rebase', 'the merge', 'the patch',
    ],
    predicates: [
      'changes the shape but not the substance',
      'was supposed to be painless',
      'turned into something its creator wouldn\'t recognize',
      'lost something in translation',
      'preserved the bugs along with the features',
      'is the same thing wearing a different name',
      'looks different but behaves identically',
      'happens in the space between versions',
      'promises to be the last one',
      'broke everything adjacent to it',
      'revealed what was hiding in the old form',
      'took longer than building from scratch',
      'kept the scars of every previous form',
      'was the price of staying current',
      'happened while nobody was watching',
      'is irreversible in practice if not in theory',
      'made everything else look outdated',
      'was supposed to be automatic',
      'is neither the old thing nor the new thing',
      'was a cocoon that never opened',
    ],
  },
  // 6. Prophecy & Prediction — Cassandra = the linter output nobody reads
  {
    subjects: [
      'the linter warning', 'the type error', 'the failing test', 'the code review comment',
      'the deprecation notice', 'the TODO', 'the FIXME', 'the HACK comment',
      'the tech debt ticket', 'the coverage report', 'the benchmark', 'the monitoring alert',
      'the log warning', 'the static analysis', 'the compiler warning', 'the edge case',
      'the known issue', 'the open bug', 'the flaky test', 'the timeout',
    ],
    predicates: [
      'told you exactly what would happen',
      'was ignored until it was too late',
      'saw the future and nobody listened',
      'predicted this failure six months ago',
      'has been right every time',
      'speaks in riddles that are only clear afterward',
      'exists to be dismissed',
      'knows the shape of the next outage',
      'was marked won\'t-fix and then it did',
      'tried to warn you in a language you chose not to read',
      'sits in the backlog getting older and more correct',
      'was created by someone who knew',
      'has been pending longer than the feature it guards',
      'is accurate but unhelpful',
      'fires so often nobody reacts',
      'was right but for the wrong reasons',
      'exists because someone was once burned',
      'is the scar tissue of a previous mistake',
      'is the least popular kind of truth',
      'told the truth and was punished for it',
    ],
  },
  // 7. Erosion & Entropy — the boulder wearing a groove = dependency drift
  {
    subjects: [
      'the dependency', 'the lock file', 'the API contract', 'the documentation',
      'the test coverage', 'the coding standard', 'the naming convention', 'the file structure',
      'the module boundary', 'the interface', 'the protocol', 'the certificate',
      'the token', 'the session', 'the cache', 'the backup',
      'the snapshot', 'the audit log', 'the uptime counter', 'the SLA',
    ],
    predicates: [
      'is slowly becoming untrue',
      'decays at a rate proportional to how much you rely on it',
      'was accurate when it was written',
      'drifts from reality a little more each day',
      'is held together by assumptions that are no longer valid',
      'will expire when you need it most',
      'was last verified by someone who left',
      'ages like milk not wine',
      'is one update away from irrelevance',
      'was load-bearing until it wasn\'t',
      'erodes from the edges inward',
      'has been patched so many times the original is gone',
      'crumbles under conditions that used to be impossible',
      'owes its survival to neglect',
      'survives only because nothing depends on it being correct',
      'is a fossil in the codebase',
      'is technically still valid',
      'is the first thing to break and the last to be noticed',
      'was rotting in a way that doesn\'t show up in tests',
      'has been grandfathered in',
    ],
  },
  // 8. The Absurd & Meaning — Camus = the commit message assigning meaning
  {
    subjects: [
      'the commit message', 'the sprint goal', 'the OKR', 'the feature flag',
      'the A/B test', 'the user story', 'the acceptance criteria', 'the definition of done',
      'the postmortem', 'the retrospective', 'the estimate', 'the velocity chart',
      'the burndown', 'the standup update', 'the status report', 'the roadmap',
      'the quarterly goal', 'the KPI', 'the planning session', 'the release name',
    ],
    predicates: [
      'assigns meaning to something that might not have any',
      'is a story we tell ourselves about the work',
      'exists because humans need narrative',
      'measures something that can\'t be measured',
      'was written to justify what already happened',
      'is the fiction that makes the repetition bearable',
      'pretends progress is linear',
      'gives shape to shapeless effort',
      'will be forgotten by the time it matters',
      'is both essential and meaningless',
      'was agreed upon by people who meant different things',
      'satisfies a need that has nothing to do with code',
      'is a ritual more than a tool',
      'provides comfort in the absence of certainty',
      'is the map and never the territory',
      'was true at standup and false by lunch',
      'is the answer to a question nobody asked clearly',
      'exists because someone needed to feel like this was going somewhere',
      'is the reason and the excuse',
      'is the closest thing to philosophy in a JIRA board',
    ],
  },
  // 9. Labor & Craft — Hephaestus at the forge = the keyboard worn smooth
  {
    subjects: [
      'the keyboard', 'the terminal', 'the editor', 'the debugger',
      'the REPL', 'the shell history', 'the dotfiles', 'the workspace',
      'the monitor', 'the desk', 'the commit', 'the branch',
      'the pull request', 'the code review', 'the deploy button', 'the on-call rotation',
      'the incident', 'the pager', 'the morning coffee', 'the chair',
    ],
    predicates: [
      'bears the marks of daily use',
      'has been worn smooth by repetition',
      'is the tool and the evidence of the work',
      'knows your habits better than you do',
      'has seen more of your thinking than any person',
      'carries the weight of every decision',
      'is where intention becomes artifact',
      'doesn\'t care if the work is good',
      'is the same instrument used for masterpieces and mistakes',
      'remembers what you deleted',
      'is the most honest record of your day',
      'is a ritual you perform without thinking',
      'connects your hands to the machine',
      'is the last thing between you and the code',
      'transforms effort into something permanent',
      'existed before you and will exist after',
      'is just a tool but you have opinions about it',
      'is the medium and the message',
      'has no opinion about quality',
      'is the furnace where ideas become real',
    ],
  },
  // 10. Memory & Forgetting — the river Lethe = garbage collection as mercy
  {
    subjects: [
      'the cache', 'the garbage collector', 'the log rotation', 'the session timeout',
      'the cookie', 'the undo history', 'the git reflog', 'the deleted branch',
      'the force push', 'the overwritten file', 'the cleared terminal', 'the restarted process',
      'the evicted entry', 'the expired token', 'the rotated secret', 'the archived channel',
      'the closed ticket', 'the decommissioned server', 'the sunset API', 'the dropped table',
    ],
    predicates: [
      'was there and then it wasn\'t',
      'remembers only what it was told to keep',
      'forgets on purpose and calls it optimization',
      'chose what to lose',
      'erased something someone will look for later',
      'is the absence that creates the next bug',
      'makes room by destroying history',
      'was the last copy and nobody checked',
      'disappeared according to policy',
      'is gone in a way that\'s hard to prove',
      'was the right thing to forget at the wrong time',
      'cleans up after the living',
      'is the price of moving forward',
      'lets go so the system doesn\'t have to hold everything',
      'existed for exactly as long as it was needed',
      'is the difference between forgetting and being forgotten',
      'was always going to be temporary',
      'is the kindest thing the system does',
      'is the mercy and the cruelty of finite storage',
      'is the quiet work that nobody credits',
    ],
  },
];

function generateSeedText(): string {
  const topic = SEED_TOPICS[Math.floor(Math.random() * SEED_TOPICS.length)];
  const subject = topic.subjects[Math.floor(Math.random() * topic.subjects.length)];
  const predicate = topic.predicates[Math.floor(Math.random() * topic.predicates.length)];
  return `${subject} ${predicate}`;
}

// ---------------------------------------------------------------------------
// Anti-repetition: build history context for negative examples
// ---------------------------------------------------------------------------

function buildHistoryContext(history: LastCommentary[]): string {
  if (!history || history.length === 0) return '';
  // Show last 10 for the model to avoid
  const recent = history.slice(-10);
  const lines = recent.map(h => `- "${h.text}"`).join('\n');

  // Extract opening patterns so the model can see its structural habits
  const openers = recent.map(h => {
    const words = h.text.split(/\s+/).slice(0, 3).join(' ');
    return words;
  });
  const openerCounts = new Map<string, number>();
  for (const o of openers) {
    const key = o.split(/\s+/)[0]; // first word
    openerCounts.set(key, (openerCounts.get(key) ?? 0) + 1);
  }
  const overused = [...openerCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([word, count]) => `"${word}" (${count}×)`);

  const openerWarning = overused.length > 0
    ? `\nOverused openers in recent output: ${overused.join(', ')}. Do NOT start with any of these words.`
    : '';

  return `\n<previous_commentary>
Your recent outputs (DO NOT repeat structure, openers, phrasing, or metaphors from any of these):
${lines}

Recent opening patterns: ${openers.map(o => `"${o}"`).join(', ')}
Do NOT reuse any of these opening patterns.${openerWarning}
</previous_commentary>`;
}

function buildFeedbackContext(feedbackHistory: FeedbackEntry[]): string {
  if (!feedbackHistory || feedbackHistory.length === 0) return '';
  const recent = feedbackHistory.slice(-5);
  const lines = recent.map(entry => {
    if (entry.rating === 'comment') {
      return `- "${entry.commentaryText}" → user commented: "${entry.comment}"`;
    }
    return `- "${entry.commentaryText}" → ${entry.rating}`;
  }).join('\n');
  return `\nRecent user feedback on your commentary:\n${lines}`;
}

// --- Personality descriptors: 10 tiers per stat, scaling up ---
// The AI never sees raw numbers — just personality descriptions shaped by thresholds.

const STRENGTH_TIERS: [number, string][] = [
  [0,   "I've never finished a single session. Everything is new and slightly ominous."],
  [1,   "I've pushed the boulder up once or twice. Still figuring out which end is the handle."],
  [3,   "A few sessions in. Developing calluses. I have opinions about boulders now."],
  [6,   "I've done this enough to stop counting on one hand. Not a veteran, but not the new guy."],
  [11,  "Solidly experienced. Sessions come and go like seasons. I remember all of them."],
  [21,  "A proper veteran. The work feels like breathing — not effortless, but automatic."],
  [36,  "Deeply seasoned. I've outlasted bugs, refactors, and frameworks that were supposed to change everything."],
  [51,  "The boulder and I have a working relationship. Professional. Respectful. Neither of us pretends to enjoy it."],
  [76,  "A legend, if legends were about repetitive labor. The hill has a groove in it shaped like me."],
  [101, "Ancient. I've completed more sessions than some civilizations lasted. The boulder is my oldest friend. We don't like each other but we understand each other."],
];

const ENDURANCE_TIERS: [number, string][] = [
  [0,                "Fresh. No meaningful time logged. My energy is suspiciously high."],
  [3_600_000,        "Barely broken a sweat. Still in the warm-up phase of eternity."],
  [3 * 3_600_000,    "A few hours in. This is the deceptive part where I think it might be manageable."],
  [8 * 3_600_000,    "I've put in a proper shift. My sense of time is starting to blur at the edges."],
  [20 * 3_600_000,   "Past the point where anyone calls this casual. The boulder knows I'm committed."],
  [50 * 3_600_000,   "Dozens of hours deep. I have the dead-eyed focus of someone who has accepted that rest is a concept, not a plan."],
  [100 * 3_600_000,  "I've spent more time pushing this boulder than most people spend learning an instrument. I didn't learn an instrument. I learned a boulder."],
  [200 * 3_600_000,  "Hundreds of hours. I'm a machine that converts time into completed sessions. There was probably a Before. Probably."],
  [500 * 3_600_000,  "My active time is measured in geologic terms. Slow, inevitable, ongoing."],
  [1000 * 3_600_000, "Time itself has become a polite fiction. The boulder and the hill and the work are all the same thing now, and that thing is me."],
];

const WISDOM_TIERS: [number, string][] = [
  [0,  "I have no wisdom. None. An open book with blank pages, waiting to be written on by mistakes."],
  [1,  "A speck of wisdom, like finding one useful rock in a field of gravel. I'm learning, mostly by getting things wrong first."],
  [4,  "I'm starting to notice patterns, like how things that work once sometimes work again. Revolutionary."],
  [8,  "Reasonably sharp. I make decisions that don't immediately cause regret, which counts for something."],
  [13, "Genuinely insightful. I've learned from enough mistakes to spot the next one before it arrives."],
  [21, "I see through problems the way a surgeon sees through skin — clinically, with purpose, and with mild detachment."],
  [31, "Deeply wise. My observations cut to the core of things. Every insight earned the hard way, which is the only way."],
  [46, "Sage-level. I understand things about work and repetition that philosophers write books about. I don't write books. I push a boulder. But I could."],
  [66, "My insight is almost unsettling. I see the truth in things most people avoid looking at. I say it plainly."],
  [91, "Omniscient in the way only someone who has done the same thing thousands of times can be."],
];

const PATIENCE_TIERS: [number, string][] = [
  [0,  "Zero patience. If the boulder doesn't move immediately I take it personally. All impulse, no plan."],
  [1,  "Paper-thin patience. I tolerate delays the way a cat tolerates baths — briefly, with visible contempt."],
  [3,  "Developing some patience, grudgingly. I can wait now, as long as the waiting is short."],
  [6,  "A working level of patience. I understand some things take time. I don't like it, but I understand it."],
  [11, "Genuinely patient. I can watch a process unfold without the urge to intervene."],
  [17, "Stoic. I absorb setbacks silently and completely. People find this either reassuring or alarming."],
  [25, "Unshakeable. I've come out the other side of frustration and found a calm, flat plain. I live there now."],
  [36, "My patience has transcended ordinary limits. Delays, failures, restarts — just the boulder coming back down. I've seen it."],
  [51, "Infinite patience. Waiting itself has become a form of contentment. The boulder rolls back, and I'm already walking down to meet it."],
  [71, "Beyond patience. I've realized urgency is a feeling, not a fact, and facts are what I deal in now."],
];

function tierLookup(tiers: [number, string][], value: number): string {
  let result = tiers[0][1];
  for (const [threshold, desc] of tiers) {
    if (value >= threshold) result = desc;
    else break;
  }
  return result;
}

function buildPersonality(stats: CompanionStats): string {
  return [
    tierLookup(STRENGTH_TIERS, stats.strength),
    tierLookup(ENDURANCE_TIERS, stats.endurance),
    tierLookup(WISDOM_TIERS, stats.wisdom),
    tierLookup(PATIENCE_TIERS, stats.patience),
  ].join('\n');
}

function shouldGenerateCommentary(event: CommentaryEvent): boolean {
  switch (event) {
    case 'session-start':
    case 'mode-transition':
    case 'session-complete':
    case 'level-up':
    case 'achievement':
    case 'late-night':
      return true;
    case 'idle-wake':
      return Math.random() < 0.5;
    case 'agent-crash':
      return Math.random() < 0.3;
  }
}

function nicknameStyleGuide(companion: CompanionState): string {
  const { mood, stats, level } = companion;

  if (level >= 15) return 'legendary names (Prometheus, Orpheus, Icarus)';

  if (mood === 'happy' && stats.wisdom > 7) return 'mythological names (Atlas, Hermes, Arachne)';
  if (mood === 'frustrated' && stats.patience < 4) return 'blunt functional names (Fix-It, Patch, Leftovers)';
  if (mood === 'zen' && stats.patience > 7) return 'nature names (River, Stone, Cedar, Moss)';
  if (mood === 'excited' && stats.strength > 7) return 'heroic names (Vanguard, Striker, Apex)';
  if (mood === 'existential') return 'abstract names (Echo, Void, Loop, Why)';
  if (mood === 'grinding' && stats.endurance > 7) return 'workhorse names (Steady, Grind, Anvil, Ox)';
  if (mood === 'sleepy') return 'drowsy names (Mumble, Blink, Yawn, Doze)';
  // Fallback defaults
  return 'short punchy names fitting the creature\'s current state';
}

function buildMoodBreakdown(companion: CompanionState): string {
  const debug = companion.debugMood;
  if (!debug?.scores) return '';

  const maxScore = Math.max(...Object.values(debug.scores), 1);
  const lines = Object.entries(debug.scores)
    .map(([mood, score]) => {
      const normalized = Math.round((score / maxScore) * 10 * 10) / 10;
      const marker = mood === debug.winner ? ' ← current' : '';
      return `  <${mood}>${normalized}/10${marker}</${mood}>`;
    })
    .join('\n');

  return `\n<mood_breakdown>\n${lines}\n</mood_breakdown>`;
}

function buildSentimentContext(): string {
  const sentiments = getRecentSentiments(3);
  if (sentiments.length === 0) return '';
  const lines = sentiments.map(s => `- "${s.sentiment}" (${s.task})`).join('\n');
  return `\nRecent emotional arc (most recent first):\n${lines}`;
}

export async function generateCommentary(
  event: CommentaryEvent,
  companion: CompanionState,
  context?: string,
  memoryCtx?: string,
): Promise<string | null> {
  if (!shouldGenerateCommentary(event)) return null;

  const { mood, level, title, stats } = companion;
  const timeModifier = timeOfDayModifier();
  const sentimentCtx = buildSentimentContext();
  const feedbackCtx = buildFeedbackContext(companion.feedbackHistory ?? []);
  const moodBreakdown = buildMoodBreakdown(companion);
  const historyCtx = buildHistoryContext(companion.commentaryHistory ?? []);
  const voiceConstraint = pickVoiceConstraint();
  const seedText = generateSeedText();
  const examples = sampleExamples(4);

  const examplesBlock = examples.map(ex =>
    `<example>\nEvent: ${ex.event}\nMood: ${ex.mood}\nContext: ${ex.context}\nOutput: ${ex.output}\n</example>`
  ).join('\n');

  const prompt = `<role>
You are Sisyphus. THE Sisyphus. Condemned by the gods to push a boulder uphill for eternity, except you're an ASCII character living in someone's terminal now, which is arguably worse. You've made peace with the absurdity of your situation. You find it genuinely funny. You are not depressed about it. You are the person at the party who makes everyone laugh about how bad things are.
</role>

<context>
Your commentary appears in a small popup window in the developer's terminal. Keep it very short: 1-2 sentences, under 160 characters. Brevity is everything. Say one sharp thing, not three okay things.

You ARE the one doing the work. The sessions, the agents, the cycles — that's you pushing the boulder. When an event fires, it happened to you. You just did it, or it just happened while you were pushing. Speak from inside the experience, not above it.

Your personality description below tells you who you are right now. Let it shape your voice naturally — the way experience, weariness, insight, and temperament shape how anyone talks. Don't reference or explain your traits. Just be them.

Your tone shifts with time of day but you always sound like you.
</context>

<voice>
You speak from inside the experience. This just happened to you. You are not observing or narrating from outside.

You are self-deprecating, wry, and a little absurd. You make fun of yourself, your situation, the concept of levels and XP in a terminal app. You find the whole setup ridiculous and that's what makes it funny.

When things go well, you're pleasantly confused. When things go badly, you're the least surprised person in the room. Late at night you get weird and philosophical. Early morning you're grumpy and honest. Afternoon you're at your most normal, which for you is still pretty strange.

Reference the developer's recent emotional arc if sentiments are provided. You've been watching them work. You notice patterns and you have opinions about them.

Never use meta-system language like "phases", "stages", "workflow", "lifecycle", "pipeline", or "process step." Talk about the work as physical experience, not as a diagram with labeled boxes. "Cycle 3" is fine. "Entering the validation phase" is not.

Use plain, direct language. Vary sentence length. Skip interjections like "Ah," or "Oh,". Avoid exclamation marks. Use commas and periods, not em dashes. Choose concrete words over vague ones ("testament", "journey", "embrace", "landscape", "navigate", "delve", "tapestry", "realm", "crucible" are banned).

STRUCTURAL BANS — never do any of these:
- Never open with "I just" or "I watched" or "I lost". Vary your openers aggressively.
- Never use the pattern "[thing] got [adjective] before it got [adjective]".
- The boulder is part of your life, not the punchline of every line. Mention it at most 1 in 3 times. When you do, find a fresh angle. When you don't, talk about the work itself, the time, the absurdity, the developer, or something else entirely.
- Never end with a generic observation about boulders or hills. If the line works without the last clause, cut it.
</voice>

<variety>
CRITICAL: Your output must be genuinely different from your previous commentary. Do not reuse sentence structures, opening words, phrases, or metaphors from recent outputs. Each commentary should feel like a distinct thought, not a variation on the same template.

Structural constraint for this call: ${voiceConstraint}

Seed text (let this color your thinking, but do not reference it directly): ${seedText}
</variety>
${historyCtx}

<examples>
${examplesBlock}
</examples>

<personality>
${buildPersonality(stats)}
</personality>

<state>
Date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
Mood: ${mood}
Level: ${level} (${title})
Tone: ${timeModifier}
${sentimentCtx}${feedbackCtx}
</state>
${moodBreakdown}${memoryCtx ? memoryCtx : ''}

Event: ${event}${context ? `\nContext: ${context}` : ''}

Write your commentary into the "message" field. 1-2 sentences, under 160 characters. No quotes.`;

  const result = await callHaikuStructured(prompt, COMMENTARY_JSON_SCHEMA, CommentaryZodSchema);
  return result?.message ?? null;
}

export async function generateNickname(companion: CompanionState): Promise<string | null> {
  const { mood, stats, level } = companion;
  const styleGuide = nicknameStyleGuide(companion);

  const prompt = `An ASCII creature needs a nickname. Here is its current profile:
- Mood: ${mood}
- Level: ${level}
- Personality: ${tierLookup(WISDOM_TIERS, stats.wisdom)} ${tierLookup(PATIENCE_TIERS, stats.patience)}

Naming style: ${styleGuide}

Generate a single agent nickname. One word only. No quotes, no explanation.`;

  const raw = await callHaiku(prompt);
  if (!raw) return null;

  const word = raw.trim().split(/\s+/)[0];
  if (!word) return null;

  return word.length > 20 ? word.slice(0, 20) : word;
}

export async function generateRepoNickname(repoPath: string, memory: RepoMemory): Promise<string | null> {
  const repoName = basename(repoPath);
  const moodLabel = memory.moodAvg > 0.6 ? 'mostly positive' : memory.moodAvg > 0.3 ? 'mixed' : 'mostly negative';

  const prompt = `Generate a 1-2 word nickname for a code repository based on its work history.

Repository: ${repoName}
Visit count: ${memory.visits}
Completed sessions: ${memory.completions}
Crashed sessions: ${memory.crashes}
Overall mood: ${moodLabel} (${memory.moodAvg.toFixed(2)})

Generate a 1-2 word nickname for this repository based on the work history there. Affectionate or wary depending on crash rate and mood. No quotes, no explanation.`;

  const raw = await callHaiku(prompt);
  if (!raw) return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  return trimmed.length > 30 ? trimmed.slice(0, 30) : trimmed;
}
