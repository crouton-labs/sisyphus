---
kind: knowledge
when-and-why-to-read: When you need to know which sisyphus extension layer wins for a given surface, this reference should be read because it is the lookup table for layer resolution order and the override-vs-additive merge semantics per surface (agents, hooks, skills, modes, commands, settings).
short-form: Layer resolution order and per-surface merge semantics for sisyphus extensions.
system-prompt-visibility: none
file-read-visibility: none
---
# Layer Resolution & Layout Reference

Sisyphus loads extensions from three layers, in priority order. Each surface (agents, hooks, skills, modes, commands, settings) follows specific merge semantics. This file is the lookup table for "what wins when."

## Layer priority

```
project (.sisyphus/) > user (~/.sisyphus/) > bundled (templates/)
```

- **Project** is the cwd's `.sisyphus/` dir. Wins everywhere on collision.
- **User** is `~/.sisyphus/`. Fills in when project doesn't define.
- **Bundled** ships with the sisyphus npm package at `templates/`. Lowest priority. Always present.

## Per-surface merge semantics

| Surface | Resolution | Notes |
|---|---|---|
| Agent type body | First match wins | Higher layer fully replaces lower. Sub-agent subdirectory follows the *winning* layer. |
| Sub-agents | First match wins | Whole subdirectory is taken from the winning layer's parent agent. Override one → override all sub-agents for that parent. |
| Hooks (manifest entries) | Additive across layers | All layers' surviving entries (post agent-type / condition filtering) are concatenated into the merged manifest. |
| Hooks (script files) | Higher layer wins on basename | Same filename in two layers → higher's content. Different filenames → both copied. |
| Skills (named directory) | First match wins | A `skills/audit/` in project shadows `skills/audit/` in bundled. Different names coexist. |
| Orchestrator commands | First match wins (per relative path) | `commands/sisyphus/foo.md` resolves layer by layer. |
| Orchestrator modes | First match by mode name | `orchestrator-foo.md` in project shadows the same in bundled. |
| Orchestrator base prompt | `.sisyphus/orchestrator.md` > `~/.sisyphus/orchestrator.md` > `templates/orchestrator-base.md` | Single-file replacement of the entire base. |
| Orchestrator settings JSON | Shallow merge | Top-level keys from project overlay user overlay bundled. Nested objects are *replaced*, not deep-merged. |

## Disable list (hooks-only)

Higher layers can suppress lower-layer hook *scripts* by basename:

```json
{
  "disable": ["plan-validate.sh", "review-user-prompt.sh"]
}
```

Effects at spawn:
- The script file is not copied into the agent's plugin dir from any layer.
- Any merged hook-manifest entry whose `command` references that filename is removed.

`disable` is the explicit escape hatch when you want a bundled hook turned off without authoring a replacement script.

## What goes where — quick reference

```
.sisyphus/
├── config.json                            # already existed; loaded on every command
├── orchestrator.md                        # full base-prompt override (already existed)
├── orchestrator-<mode>.md                 # custom orchestrator modes
├── orchestrator-settings.json             # shallow-merge over bundled settings
├── agent-plugin/
│   ├── .claude-plugin/plugin.json         # optional metadata (the daemon doesn't require this)
│   ├── agents/
│   │   ├── <type>.md                      # new or override agent type
│   │   ├── <type>.settings.json           # optional Claude Code settings sidecar
│   │   └── <type>/                        # sub-agent subdirectory
│   │       └── <sub>.md
│   ├── hooks/
│   │   ├── hooks.json                     # manifest declaring this layer's hooks
│   │   └── <name>.sh                      # hook scripts referenced by manifest
│   └── skills/
│       └── <name>/SKILL.md                # opt-in via agent frontmatter
└── orchestrator-plugin/
    ├── .claude-plugin/plugin.json
    ├── commands/sisyphus/<cmd>.md
    ├── hooks/{hooks.json, <name>.sh}
    └── skills/<name>/SKILL.md             # available to orchestrator without opt-in
```

`~/.sisyphus/` mirrors this structure exactly.

## Discovery cache & daemon restart

The daemon does not poll the layer dirs continuously — it scans them at well-defined points:

| When the daemon scans | What's re-resolved |
|---|---|
| Agent spawn | Agent body, sub-agents, hooks, skills (per-spawn fresh composition) |
| Orchestrator spawn (each cycle) | Orchestrator plugin tree, modes, settings, base prompt |

So edits to bundled or layered files **take effect on the next spawn** — no daemon restart strictly required for agent edits. **But:** if your edit changes how the orchestrator should pick agents/modes (e.g., you added a new mode), restart the orchestrator (`sis orch yield` to kill + respawn) so the new system prompt is built. A full daemon restart (`sis admin daemon restart`) is overkill for most edits.

## Extending an existing agent — the override-vs-fresh decision

You're modifying `review` for this project. Three options:

| Option | Files | Trade-offs |
|---|---|---|
| Replace the body | `.sisyphus/agent-plugin/agents/review.md` | Bundled hooks, sub-agents, settings still apply. Easy to revert (delete the file). Best for prompt tweaks. |
| Replace body + sub-agents | `.sisyphus/agent-plugin/agents/review.md` AND `.sisyphus/agent-plugin/agents/review/<sub>.md` | The whole `review/` subdir replaces bundled. You re-author the sub-agent set. Best when you want a different fan-out. |
| Add a hook or skill, keep body | `.sisyphus/agent-plugin/hooks/hooks.json` with `agentTypes: ["review"]` | Doesn't touch the body. Stacks atop bundled behavior. Best for guards and reminders. |

## Verification commands

```bash
# Show all available agent types and their layer source
sis admin doctor                              # confirms paths resolve

# Inspect what was actually composed for a spawned agent
ls .sisyphus/sessions/<id>/prompts/<agent>-plugin/
cat .sisyphus/sessions/<id>/prompts/<agent>-plugin/hooks/hooks.json
ls .sisyphus/sessions/<id>/prompts/<agent>-plugin/skills/

# Inspect the orchestrator's rendered plugin
ls .sisyphus/sessions/<id>/.orchestrator-plugin/
cat .sisyphus/sessions/<id>/prompts/orchestrator-system-1.md   # full system prompt
```

## Common layout mistakes

- **Project hooks `hooks.json` referencing `${CLAUDE_PLUGIN_ROOT}/hooks/foo.sh` without the script.** The manifest entry survives the merge but the script doesn't exist in the layer; spawn fails or the hook silently no-ops. Always ship script + manifest entry together in the same layer.
- **Same skill name as a bundled one without intending to override.** `agent-plugin/skills/orchestration/` in project would shadow the bundled orchestration skill — but only for agents that opt in via frontmatter. Pick a distinct name unless override is the goal.
- **`.sisyphus/orchestrator-plugin/.claude-plugin/plugin.json` with the same `name` as bundled.** Cosmetic; the daemon reads from the directory, not the manifest. Still, distinct names help when reading log output.
- **Mixing `.claude/agents/` and `.sisyphus/agent-plugin/agents/`.** Both work for the agent body. But `.claude/` won't pick up co-located hooks or skills — those need `agent-plugin/` for the layered composer to find them. For sisyphus-flavored extensions, prefer `agent-plugin/`.
- **Editing `templates/` in the installed sisyphus package directly.** Edits there are bundled-layer changes that get blown away on the next `npm i` or `npm update`. Always extend via `.sisyphus/` or `~/.sisyphus/`.
