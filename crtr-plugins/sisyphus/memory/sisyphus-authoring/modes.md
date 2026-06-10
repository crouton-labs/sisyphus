---
kind: reference
when-and-why-to-read: When you are authoring a sisyphus orchestrator mode, this reference should be read because it explains modes versus agents, mode discovery, mode-specific content builders, and when to author commands instead.
short-form: Authoring orchestrator modes — discovery, content builders, and modes vs agents.
system-prompt-visibility: none
file-read-visibility: none
---
# Authoring Orchestrator Modes

A mode is an orchestrator phase — a chunk of system-prompt content that gets *appended* to the bundled `orchestrator-base.md` to specialize the orchestrator's thinking for a particular kind of cycle. Bundled modes: `discovery`, `planning`, `impl`, `validation`, `completion`.

## When a new mode is justified

Modes are heavyweight. They show up in the orchestrator's mode list every cycle, the orchestrator transitions between them with explicit signaling, and they affect how the validation and completion logic behaves. Don't add a mode for a small tweak to existing behavior.

A new mode is justified when:
- The *kind of thinking* the orchestrator does is genuinely distinct from existing phases.
- The work pattern has a clear entry condition (when does the orchestrator move to this mode?) and exit condition (when is the mode "done"?).
- The mode would routinely spawn agents that don't fit cleanly into existing phases.

The user's example: `post-run-audit` mode. After validation completes, you want the orchestrator to enter a distinct phase that audits the session for drift, missed cleanup, and follow-up tasks. That's a new *kind of thinking* (retrospection, not construction), with clear entry (validation passed) and exit (audit findings filed, follow-ups queued).

## When to do something else instead

- **You want a phase variation, not a new phase.** A "thorough planning" tweak belongs in `orchestrator-planning.md` (override) or in the project's `orchestrator.md` (full base override) — not as a new mode.
- **You want a distinct slash command for an ad-hoc orchestrator action.** That's a command, not a mode — see [commands](#orchestrator-slash-commands) below.
- **You want a one-off sub-routine the orchestrator runs inside an existing mode.** That's a skill (`orchestrator-plugin/skills/<name>/SKILL.md`) or sub-agent of an existing agent — not a mode.

## File path

```
.sisyphus/orchestrator-<name>.md          # project-local
~/.sisyphus/orchestrator-<name>.md        # user-global
templates/orchestrator-<name>.md          # bundled (sisyphus repo)
```

The basename `orchestrator-<name>.md` is the discovery key. The daemon scans all three layers and merges by name (project shadows user shadows bundled). `orchestrator-base.md` is reserved — it's the always-prepended base prompt.

## Frontmatter

```yaml
---
name: post-run-audit
description: Audit a finished session for drift and follow-ups. Use after validation has passed.
---
```

The `name` field is what the orchestrator transitions to (`sis orch yield --mode post-run-audit`). It must be a single token — lowercase, hyphens, no spaces. Defaults to the filename stem if omitted.

The `description` is what other modes/agents read in the orchestrator's `{{ORCHESTRATOR_MODES}}` listing. **Front-load the entry condition** ("Use after X has happened…") because that's the trigger signal the previous mode reads.

## Body — the mode prompt

The body is the *appended* portion of the orchestrator's system prompt. The bundled base (`orchestrator-base.md`) provides identity, cycle workflow, and state-management rules. Your mode body specializes the *current cycle's* thinking on top of that.

Don't:
- Restate the orchestrator's identity ("You are the orchestrator…"). The base already does.
- Restate the cycle workflow (read state → spawn agents → yield). The base already does.
- Restate yield/complete commands. The base lists them.

Do:
- State the **entry context** ("You're in this mode because validation completed and there's reason to audit").
- State the **goals of this phase** in terms of decisions and outputs, not actions.
- List **agents commonly spawned in this mode** with rationale.
- State the **exit signal** — when should the orchestrator transition out, and to which mode?

### Body structure

A useful template:

```markdown
---
name: post-run-audit
description: Audit a finished session for drift and follow-ups. Use after validation has passed.
---

# Post-Run Audit Phase

You're in audit mode because the session reached a coherent state and we want
to surface anything the cycle missed before declaring done.

## Goals

- Identify drift between spec and merged code.
- Capture untracked TODOs from this cycle's diffs.
- Decide which findings warrant follow-up cycles vs. ship-now.

## Typical agents

- `sisyphus:post-run-audit` — fan-out audit with sub-agents for drift, TODOs, completion.
- `sisyphus:review` — second-pass code review focused on the diffs from this cycle.
- `sisyphus:explore` — when an audit finding needs investigation before recommending action.

## Exit

Move to `completion` mode once findings are filed and you've decided which need
follow-up. If findings are severe enough to require new work, return to
`planning` instead.

<!--EFFORT:high-->
Don't rush this — you're explicitly looking for things the implementation
phase optimized away. Spend the budget on signal-finding.
<!--/EFFORT-->
```

### Effort markers

`<!--EFFORT:tier-->` blocks scale the prompt by the session's effort tier. Low-effort sessions skip the deep guidance; high-effort sessions get it. Same syntax as agent bodies — see [agents.md](agents.md#effort-markers).

### `$SISYPHUS_*` substitutions

The same env-var substitutions work in mode bodies as in agent bodies (`$SISYPHUS_SESSION_DIR`, `$SISYPHUS_SESSION_ID`). Use them when referencing session-specific paths.

## Mode-specific content builders

Some modes need *runtime-computed* user-prompt content beyond the static markdown — the bundled `completion` mode renders the full session history table from `state.json`. This is wired in code, not in the markdown:

`src/daemon/orchestrator.ts` defines `modeContentBuilders: Record<string, ModeContentBuilder>`. To add a runtime builder for your mode, register a function that takes the `Session` and returns markdown to append. Most modes don't need this — markdown alone is plenty. Add a builder only when:

- The mode needs to dump arbitrarily-sized state into the orchestrator's user prompt (full cycle log table, all reports).
- The content is purely derived from disk state, not authored.

If you find yourself wanting to add a builder for templating, prefer using `$SISYPHUS_*` and file-reference syntax (`@path/to/file.md`) in the markdown — the orchestrator natively follows those references.

## Mode discovery and the daemon cache

The daemon discovers modes when the orchestrator spawns. Layered scan: project > user > bundled. Drop a new file and **restart the daemon** (`sis admin daemon restart`) — the next orchestrator cycle will see the new mode.

To verify discovery worked, look at `.sisyphus/sessions/<id>/prompts/orchestrator-system-N.md` — the rendered system prompt should list your mode under `{{ORCHESTRATOR_MODES}}`.

## Orchestrator slash commands

If you want the orchestrator to run a discrete *one-shot* action (not enter a phase), the right surface is a slash command, not a mode. Commands live at:

```
orchestrator-plugin/commands/sisyphus/<cmd>.md
```

Bundled examples: `/sisyphus:problem`, `/sisyphus:strategize`, `/sisyphus:scratch`, `/sisyphus:spec`. The orchestrator invokes them inline; they don't transition phase.

A command is justified for things like "drop into a mini-spec exercise and come back" or "render a strategy document into the session" — discrete actions the orchestrator picks up and finishes within one cycle.

## Common authoring mistakes

- **Modes that duplicate `discovery` or `planning`.** If 80% of your mode body could be a paragraph appended to an existing one, override the existing mode instead.
- **No clear entry/exit signal.** Modes are state machine nodes — without entry conditions in the description and exit guidance in the body, the orchestrator doesn't know when to transition.
- **Restating base-prompt content.** The bundled base is ~400 lines. Your mode appends ~50–100 more. If you're at 300 lines, you're probably restating things the base already says.
- **Forgetting to register a content builder when needed.** If your mode requires dumping state into the user prompt and you skipped the builder registration, the orchestrator will run with stale or missing context every cycle in that mode.
- **Underscore in filename.** `orchestrator-post_run_audit.md` won't resolve cleanly — use `orchestrator-post-run-audit.md` (hyphens only). The mode name in the orchestrator's vocabulary becomes `post-run-audit`.
- **Mode and agent type with conflated names.** It's fine to have a `post-run-audit` mode and a `post-run-audit` agent type — they're distinct namespaces. But name them so the relationship is clear (the audit mode commonly spawns the audit agent), not by accident.
