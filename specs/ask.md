# `sis ask` — Spec

Unified ask/present command. Replaces `sis present`. Agents and the orchestrator submit decks of structured questions (validation / choice / freetext) with optional rich termrender bodies. The user triages a queue of asks in the dashboard TUI, optionally pressing space to materialize haiku-generated termrender visuals on demand. Default blocking; `--background` opt-in.

Routes through the humanloop library (refactored to be embeddable) so sisyphus and the standalone `humanloop` CLI share render/input/persistence.

## Goals

- One CLI verb covers both "show the user this content" and "ask the user a structured question."
- Agents write structured JSON, not freeform markdown — discriminated unions force well-shaped questions.
- Multi-agent queue: any number of agents (and the orchestrator) can ask in parallel; user works the queue serially.
- Visuals are lazy and tool-driven: haiku is invoked only when the user asks for a visual, never speculatively.
- No code duplication: humanloop owns the walkthrough TUI; sisyphus mounts it as a panel.

## CLI Surface

### `sis ask <file.json>` (default: blocking)

Reads `file.json`, validates the schema (see below), mints `askId` (ULID), creates `<sessionDir>/context/ask/<askId>/`, copies/inlines `bodyPath` references, writes `decisions.json` + `meta.json`, then watches `output.json` and **blocks** until it appears.

On unblock: prints `output.json` JSON (`{responses: InteractionResponse[], completedAt: string}`, per `src/daemon/ask-store.ts:89`) to stdout, exits 0.

Caller identity from env: `$SISYPHUS_AGENT_ID` if set, else `"orchestrator"`. Stored in `meta.askedBy`. The CLI process pid is recorded in `meta.pid` so daemon restart can detect dead waiters.

### `sis ask <file.json> --background`

Same setup, but prints `askId` to stdout and exits 0 immediately. No watcher.

### `sis ask poll <askId>`

Blocks until `output.json` exists, prints it, exits 0. Same waiter implementation as the blocking form.

### `sis ask peek <askId>`

Non-blocking. Prints JSON: `{askId, status, completedAt?, output?}`. Exits 0 regardless of status.

## Schema (zod-validated)

Extends humanloop's `Deck` (v2 unified `Interaction[]`) with sisyphus-specific submit-time validation:

```ts
// Landed in @crouton-kit/humanloop (humanloop/src/types.ts:14)
export interface Interaction {
  id: string;
  title: string;
  subtitle?: string;
  body?: string;
  bodyPath?: string;
  options: InteractionOption[];
  allowFreetext?: boolean;
  freetextLabel?: string;
  kind?: InteractionKind;  // 'notify' | 'validation' | 'decision' | 'context' | 'error'
}
```

`kind` is optional; sisyphus validates against the closed `InteractionKind` set (`src/shared/ask-schema.ts:26`) but humanloop treats it as opaque presentation metadata. Interaction titles are non-empty (≤4 words is a recipe convention, not a schema constraint).

Zod rules:
- Deck `title` required and non-empty.
- Interaction `title` non-empty.
- `subtitle` non-empty when present.
- `body` and `bodyPath` mutually exclusive.
- `bodyPath` resolves to an existing file; passes `termrender --check` (any non-zero exit = invalid).
- `body` (when present) passes `termrender --check`.
- Interaction ids unique within the file.

`bodyPath` is **inlined into `decisions.json` as `body`** at submit time so the askId dir is self-contained. Caller may delete the source files after `sis ask` returns the askId (or after blocking unblocks).

## Disk Layout

```
<sessionDir>/context/ask/<askId>/
  decisions.json          # input, bodyPath inlined as body
  progress.json           # humanloop's resume state, written during walkthrough
  output.json             # final answers, written only on completion
  meta.json               # sisyphus-side metadata
  visuals/<qid>.md        # haiku's raw termrender output
  visuals/<qid>.ansi      # rendered cache
```

`meta.json`:

```ts
interface AskMeta {
  askId: string;
  askedBy: string;                  // agent id, or "orchestrator"
  askedAt: string;                  // ISO 8601
  status: 'pending' | 'in-progress' | 'answered';
  blocking: boolean;
  pid?: number;                     // CLI waiter pid, if blocking
  completedAt?: string;
  orphaned?: boolean;               // requester died mid-block
}
```

State transitions:
- `pending` → on submit.
- `pending → in-progress` — first time humanloop writes `progress.json` (sisyphus updates via `onProgress` callback).
- `* → answered` — humanloop writes `output.json` (sisyphus updates via `onComplete`).
- `orphaned` is an orthogonal flag, not a status.

## TUI Integration

### Outer poll loop

`pollAllSessions` (or a sibling) scans `<sessionDir>/context/ask/*/meta.json` every 500ms. Builds the queue: items where `status !== 'answered'`. Sort by `askedAt` ascending. Cache in `AppState.askQueue` keyed by sessionId.

Optional optimization: `fs.watch` on `<sessionDir>/context/ask/` to drop poll latency to near-zero while the inbox is open. Fall back to polling for cross-platform reliability.

### Tree (sectioned by attention)

The dashboard tree is sectioned by state: `Needs You` (sessions with pending asks), `Running`, `Done`. The fleet-level virtual node `Needs You` aggregates pending asks across all sessions; cursor on it switches the detail zone to a flat cross-session inbox view (`src/tui/state.ts:172` — `detailMode: 'cross-session-inbox'`). Per-session asks also surface inside their session subtree.

### Resolution mode (full-screen takeover)

Selecting an ask transitions sisyphus from dashboard mode to **resolution mode**: a full-screen humanloop walkthrough rendered below sisyphus's source-context header strip (queue position + source + blocked-time). Sisyphus's tree input is suspended; key events route to `humanloop.handleKey()` except for layered keys.

Layered keys (sisyphus handles, gated by `mountedPanel.canAcceptHostKeys()`):
- `esc` — exit resolution mode, return to dashboard
- `Shift+J` / `Shift+K` — walk the queue without resolving (preview next/prev)
- `space` — toggle visual visibility for current interaction; first press fires haiku generation if `visuals/<qid>.md` doesn't exist
- `R` — force-regenerate the current interaction's visual (deletes cache, re-fires haiku)

Auto-chain: after `onComplete`, sisyphus calls `mountedPanel.loadDeck(nextDeck)` for the next pending ask in the cross-session queue (oldest blocked-time first); when the queue is empty, sisyphus unmounts and returns to dashboard at the `Needs You` cursor.

Exit paths:
- humanloop calls `onComplete(responses)` → sisyphus writes `output.json` (`{responses, completedAt}`), sets `meta.status = 'answered'`, then auto-chains or unmounts.
- humanloop calls `onExit()` → sisyphus unmounts to dashboard. `progress.json` already written via `onProgress`. `meta.status` stays `'in-progress'`.

## Humanloop Library API

`humanloop` package exposes a public mount entry point:

```ts
// Landed in @crouton-kit/humanloop (src/types.ts)
export interface Deck {
  title: string;                 // non-empty deck-level inbox topic
  source?: { sessionName?: string; askedBy?: string; blockedSince?: string };
  interactions: Interaction[];
}

export interface MountedPanelOpts {
  deck: Deck;
  progressPath?: string;
  generateVisual?: GenerateVisual;
  cols: number;
  rows: number;
  onProgress?: (responses: InteractionResponse[]) => void;
  onComplete?: (responses: InteractionResponse[]) => void;
  onExit?: () => void;
}

export interface MountedPanel {
  handleKey(input: string, key: Key): void;
  render(): string[];
  handleResize(cols: number, rows: number): string[];
  unmount(): void;
  loadDeck(deck: Deck, opts?: { progressPath?: string }): void;
  canAcceptHostKeys(): boolean;
}

export function mountPanel(opts: MountedPanelOpts): MountedPanel;
```

All v1 discriminated-union types (the `Question`/`Answer` union, the v1 input/output wrappers, and the v1→v2 conversion helpers) are dropped per the stage-3 schema collapse — humanloop is v2-only on disk and in the public API.

Standalone `hl` CLI accepts v2 `Deck` JSON and emits `InteractionResponse[]`; see humanloop repo CHANGELOG.

## Termrender `--check`

Sisyphus calls `termrender --check` directly (already exists in termrender; exit 0 = valid, exit non-zero = invalid). No new termrender flag is required; the original `--validate` proposal was dropped per session goal.md "Decisions taken". Used by:

- Sisyphus zod validation on `body` and inlined `bodyPath` content (`src/shared/ask-schema.ts:64`).
- `attach_visual` tool handler in haiku visual generation (`src/daemon/ask-visual.ts`).

## Visual Generation Pipeline

Triggered by `space` on a question. Sisyphus's haiku adapter (extending `daemon/haiku.ts` to support tool-use loops):

```
1. Build Anthropic API call:
   - model: claude-haiku-4-5-20251001
   - system: <contents of templates/termrender-haiku-system.md>
   - messages: [{
       role: 'user',
       content: `Generate a visual for this question:

Title: ${q.title}
Subtitle: ${q.subtitle}
${q.statement ?? q.question}
Rationale: ${q.rationale}

Recent transcript from ${meta.askedBy}:
${tail(~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl, ~8KB)}`  // src/daemon/transcript-digest.ts
     }]
   - tools: [
       {
         name: 'read_file',
         description: 'Read a file from the session cwd',
         input_schema: { path: string }
       },
       {
         name: 'attach_visual',
         description: 'Submit the termrender markdown for this visual',
         input_schema: { content: string }
       }
     ]
2. Tool-use loop, capped at 5 turns:
   - read_file: resolve `path` against session.cwd (the repo). Reject paths
     escaping the repo. Truncate >50KB. Return contents or error.
   - attach_visual: run `termrender --check` on `content`. On 0:
     write `visuals/<qid>.md` (raw) and `visuals/<qid>.ansi` (rendered).
     Return `{ok: true}`. On nonzero: return `{ok: false, error: stderr}`
     and let haiku iterate.
3. Loop exit:
   - attach_visual succeeded → visual.status = 'ready', UI renders cached .ansi.
   - 5 turns elapsed without success → visual.status = 'error', UI shows last error message inline.
```

System prompt template lives in sisyphus: `templates/termrender-haiku-system.md`. Contains termrender directive cheatsheet (`:::panel`, `:::columns`, `:::tree`, `:::mermaid`, etc.) and tone instructions (terminal-width, dense, no prose, prefer structure over text).

Conversation context = `~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl` byte-capped at ~8KB (`src/daemon/transcript-digest.ts`). For orchestrator-asked items, `claudeSessionId` is the current cycle's session ID.

`read_file` is scoped to `session.cwd` (the repo). Paths normalized; any resolution that escapes returns an error to haiku.

## Orphan Handling

Triggered from existing kill/complete code paths:
- `session-manager.ts` `handleKill()` agent path
- `session-manager.ts` `handleComplete()`
- `pane-monitor.ts` `handleAgentKilled()`
- Orchestrator pane death without yield (existing crash-detection branches in `orchestrator.ts`)

In each path, after the existing kill/complete logic:

```ts
const askDir = `${sessionDir}/context/ask`;
for (const askId of fs.readdirSync(askDir)) {
  const meta = readMeta(askId);
  if (meta.askedBy === killedId && meta.status !== 'answered') {
    writeMeta(askId, { ...meta, orphaned: true });
  }
}
```

Daemon restart recovery: on startup, walk all sessions' `context/ask/*` and mark `orphaned = true` where `meta.blocking && meta.pid && !pidAlive(meta.pid) && !exists(output.json)`. Cheap; runs once.

UI: orphaned items render dimmed in inbox list with `⚠ orphan` tag. User can still walk them through — answers persist in `output.json` and are available as context for the next agent / cycle. No waiter unblocks.

## Implementation Phases

Ordered to keep each phase shippable:

1. **Humanloop library refactor** (humanloop repo) — extract `mountPanel` with v2 `Deck`/`Interaction[]` shapes, add `generateVisual` injection. (Termrender `--validate` proposal dropped; `--check` already exists.)
2. **Sisyphus `ask.ts` command** (`src/cli/commands/ask.ts`) — replaces `present.ts`. Subcommands: blocking submit, `poll`, `peek`. Disk layout helpers in new `ask-store.ts`.
3. **Sisyphus haiku adapter** (`daemon/haiku.ts`) — tool-use loop, `attach_visual` and `read_file` handlers, system prompt template.
4. **Sisyphus TUI integration** (`src/tui/`) — `Needs You` virtual node, cross-session inbox detail mode, full-screen resolution mode, `space`/`R`/`Shift+J`/`Shift+K` layered keys.
5. **Orphan handling** — wire into kill/complete paths + daemon startup scan.
6. **Templates** — `termrender-haiku-system.md`.
7. **Migration** — drop `sis present`. Update agent prompt templates to teach `sis ask` with v2 `Deck`/`InteractionResponse[]`.

## Out of Scope (Explicit)

- Multiple visuals per question.
- Cost reporting in TUI.
- Dismiss-without-answering (`d` key).
- Visual urgency signaling on inbox counter.
- Roadmap composability (future, separate effort using same primitives).
- Agent-to-agent asks — the user is the only answerer.
- Concurrent users on the same session.
