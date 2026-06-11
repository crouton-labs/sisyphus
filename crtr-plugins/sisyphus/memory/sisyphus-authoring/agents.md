---
kind: knowledge
when-and-why-to-read: When you are authoring or overriding a sisyphus agent type, this reference should be read because it details the agent .md frontmatter (model, color, hooks, sub-agents, settings), the prompt structure, and when to make a new type versus override a bundled one.
short-form: Agent-type frontmatter, prompt structure, and new-type-vs-override guidance.
system-prompt-visibility: none
file-read-visibility: none
---
# Authoring Agent Types

An agent type is a `.md` file the orchestrator can spawn as `sisyphus:<name>`. The frontmatter configures the spawn (model, color, hooks behavior, sub-agents, settings); the body becomes the agent's system prompt.

## When to author a new type vs override

Override the bundled prompt (drop a same-named `.md` in `.sisyphus/agent-plugin/agents/<type>.md`) when:
- You like the bundled scope but want to weight priorities differently for this project (the bundled `review` agent should emphasize accessibility here).
- You want to inject project-specific conventions or vocabulary into the agent's reasoning.
- Bundled hooks and sub-agents still apply — only the prompt body changes.

Author a new type when:
- The work pattern is genuinely novel and the bundled types would be misused if pressed into service.
- You need a distinct agent name in the orchestrator's vocabulary (e.g., `post-run-audit` vs `review`).
- The new type has its own sub-agents and its own hook configuration that wouldn't make sense bound to a bundled type.

## File path

```
.sisyphus/agent-plugin/agents/<type>.md            # project-local
~/.sisyphus/agent-plugin/agents/<type>.md          # user-global
```

Resolution priority: `.sisyphus/` (project) > `~/.sisyphus/` (user) > `~/.claude/agents/` (Claude convention) > bundled. Sisyphus-flavored extensions should live under `agent-plugin/agents/`, not `.claude/agents/`, so co-located hooks and skills are discovered by the same layered composer.

## Frontmatter

Every field is optional except `description`. Each field maps directly to a runtime decision the daemon makes at spawn time.

```yaml
---
name: post-run-audit
description: Audit a finished session for missed cleanup, drift, untracked TODOs.
model: claude-opus-4-8
fallbackModel: claude-sonnet-4-6
color: yellow
effort: high
permissionMode: default
interactive: false
systemPrompt: append
skills:
  - audit-checklist
plugins:
  - some-plugin@marketplace
---
```

| Field | Why it exists |
|---|---|
| `name` | Display name in tmux pane title and orchestrator listings. Defaults to filename. |
| `description` | Surfaces in the orchestrator's `{{AGENT_TYPES}}` injection. **Front-load the trigger keywords.** This is the orchestrator's only signal for when to spawn this type. |
| `model` | Maps to Claude `--model`. Use `opus` (alias for `claude-opus-4-8[1m]`) for plan/review/debug-style work that benefits from 1M context. |
| `fallbackModel` | If the primary CLI/model isn't available, the daemon transparently falls back. Set this for OS portability (codex → claude). |
| `color` | tmux pane border color — fast visual signal in multi-pane workflows. |
| `effort` | Doubles as Claude `--effort` flag *and* the prompt-tier override for `<!--EFFORT:high-->` blocks in the body. Choose one of `low`, `medium`, `high`, `xhigh`, `max`. |
| `permissionMode` | Defaults to `--dangerously-skip-permissions`. Set to `default`, `plan`, `acceptEdits` for permission-gated agents. |
| `interactive` | When `true`, the daemon **drops the `Stop` hook** so the agent can pause for user input. Use for agents like `spec` or `problem` that talk to the user directly. |
| `systemPrompt` | `append` (default) prepends the body to Claude's standard system prompt. `replace` substitutes — use only when you need a fully custom persona (rare). |
| `skills` | Names of skill directories from `agent-plugin/skills/` to copy into the agent's plugin at spawn. **The agent only sees skills it explicitly opts into.** |
| `plugins` | External Claude Code plugins to auto-install and pass via `--plugin-dir`. Format: `name@marketplace`. |

## Body — the agent prompt

The body is the agent's system prompt. Sisyphus agent prompts have a distinct shape:

1. **Identity (one paragraph).** "You are X. Your one job is Y." Don't expand the scope here — narrowing is the whole point.
2. **Inputs.** What the agent receives in its task instruction (which files to read, what context dir, what artifacts the orchestrator will have produced).
3. **Outputs.** What `sis agent submit` should contain. Be specific — "summary of findings" is too loose; "a markdown table of issues with file:line references and severity" is right.
4. **Hard rules.** Things the agent must not do (write outside the context dir, edit production code, exceed N files). Use imperative voice for non-negotiables.
5. **Bail-and-report cues.** When to stop and report unexpected complexity rather than power through. This is load-bearing — without it, agents over-extend silently.
6. **Tools available, briefly.** Don't recapitulate the Claude Code tool docs — the agent already has them. Mention only sisyphus-specific commands (`sis agent spawn`, `sis ask`).

### Tone register

| Section | Voice | Example |
|---|---|---|
| Identity | "You are X" | "You are a post-run audit agent." |
| Traits | Third person | "The agent prefers concrete findings over speculation." |
| Operations | Second person | "When you find a TODO, file:line it in your report." |
| Hard rules | Imperative | "NEVER edit files in `src/` — your job is observation." |

→ For the full prompt architecture (zones, escalation ladder, when to use procedures vs constraints), read `crtr memory read ai/prompting/prompting-effectively` and `crtr memory read claude-authoring/skills` for general prompt and skill conventions.

### Effort markers

Bracket sections by reasoning tier so the daemon can render different prompts at different effort levels:

```markdown
<!--EFFORT:high-->
Spend 5–10 minutes mapping the audit surface before producing findings.
Run `git log --since=2.weeks` to ground the cycle window.
<!--/EFFORT-->
```

Sections without markers always render. The runtime selects the highest tier ≤ the agent's `effort` value. Use this to calibrate expectations — a `low`-effort run gets a leaner prompt that targets fewer activities.

### `$SISYPHUS_*` substitutions

The daemon substitutes these literals before the prompt reaches Claude:

| Token | Resolves to |
|---|---|
| `$SISYPHUS_SESSION_ID` | The session UUID |
| `$SISYPHUS_SESSION_DIR` | Absolute path to `.sisyphus/sessions/<uuid>/` |
| `$SISYPHUS_AGENT_ID` | The agent's `agent-NNN` ID |

Use these for hardcoded paths in the prompt: `Write your report to $SISYPHUS_SESSION_DIR/context/$SISYPHUS_AGENT_ID/findings.md`. The shell exports them as real env vars too, so bash within the agent sees the same values.

## Sub-agents

Sub-agents are `.md` files in a subdirectory matching the parent's name:

```
agent-plugin/agents/
  post-run-audit.md
  post-run-audit/
    drift-checker.md
    todo-collector.md
    completion-verifier.md
    CLAUDE.md          # optional — guidance for editors of these sub-agents
```

The daemon copies these into the parent's plugin dir at spawn so the parent can dispatch them via the Agent tool. Crucially:

- **Sub-agents are invisible to the orchestrator.** Only the parent agent decides when to spawn them.
- **The parent agent's own `.md` is never copied as a sub-agent** — that would let it dispatch itself recursively.
- **`CLAUDE.md` in a sub-agent dir is excluded from the copy** — it's documentation for human editors.
- **Sub-agent frontmatter follows Claude Code's subagent shape** (name, description, tools, model). Keep it concise; a good sub-agent description fits in two lines.

### When to add a sub-agent vs grow the parent

Add a sub-agent when:
- The work is a **distinct perspective** the parent should consult (e.g., security review, code-smell scan, requirements coverage).
- The work could be **parallelized** with other sub-agents (the parent fans out, then synthesizes).
- The skill/voice differs from the parent's (a `critic` sub-agent should be skeptical; the parent shouldn't impersonate that voice when synthesizing).

Don't add a sub-agent when:
- It's a single one-off Bash command — just have the parent run it.
- The output is too small to justify a context fork — a paragraph of text is cheaper to inline.

## Settings sidecar (`.settings.json`)

Drop `<type>.settings.json` next to `<type>.md` to pass Claude Code settings to the spawned session:

```json
{
  "spinnerVerbs": ["auditing", "checking", "verifying"]
}
```

The daemon passes this via `--settings`. Use for spinner customization, output style, or any field Claude Code's settings.json supports. Settings sidecars layer normally — a project-level sidecar overrides a bundled one of the same name.

## Worked example — `post-run-audit`

```markdown
---
name: post-run-audit
description: Audit a finished session for missed cleanup and untracked TODOs. Use after validation when investigating "did anything fall through the cracks?"
model: claude-opus-4-8
color: yellow
effort: high
interactive: false
systemPrompt: append
skills:
  - audit-checklist
---

# Post-Run Audit Agent

You are a post-run audit agent. Your one job is to surface things the implementation cycle missed — TODOs that didn't make it into the roadmap, drift between the spec and the merged code, leftover scaffolding, undocumented behavior changes.

## Inputs

You receive:
- The path to the session directory in `$SISYPHUS_SESSION_DIR`.
- The completed cycle logs in `$SISYPHUS_SESSION_DIR/logs/`.
- The agent reports in `$SISYPHUS_SESSION_DIR/reports/`.
- The repo HEAD as it stands at audit time.

## Outputs

`sis agent submit` a markdown report with three sections:

1. **Drift** — places where merged code diverges from the spec or roadmap, with `file:line` references.
2. **Untracked TODOs** — `TODO`/`FIXME`/`XXX` comments added during the cycle that weren't captured in the roadmap.
3. **Recommendations** — concrete follow-up tasks. Each item is either "ship-blocking", "next-cycle", or "later".

## Hard rules

- NEVER edit files in `src/`. Your role is observation only.
- NEVER fabricate findings. If a section is empty, write "No issues found."
- ALWAYS cite `file:line` for code references — unverifiable findings have no value.

## Bail and report

If the session has no merged code (e.g., a discovery-only run), submit a one-line report explaining nothing was changed and stop. Don't manufacture audit findings to justify the cycle.

If you find evidence of an incomplete implementation (half-finished functions, stubbed tests), bail with a "BLOCKED: implementation incomplete" report rather than auditing further — the cycle isn't done.

## Tools

- `git log`, `git diff` — your primary lens.
- `rg "TODO|FIXME|XXX"` — TODO collection.
- `sis agent spawn --type=drift-checker` — fan-out for the parent's sub-agents.
```

## Common authoring mistakes

- **Setting `interactive: true` on a non-interactive agent.** This drops the Stop hook, which means the agent can exit without calling `sis agent submit` and the orchestrator never sees a final report.
- **Specifying tools the agent already has.** Claude Code's standard tool docs are loaded automatically — listing Read/Write/Bash in the body wastes tokens.
- **Restating sisyphus runtime context.** The bundled `agent-suffix.md` already tells the agent how to submit reports, where the context dir is, etc. Don't duplicate.
- **Hardcoding paths instead of using `$SISYPHUS_*`.** A hardcoded path will silently work for one session and break for the next.
- **`description` that doesn't help the orchestrator decide.** "An agent" is useless. "Audit a finished session for missed cleanup and untracked TODOs" tells the orchestrator exactly when to reach for it.
