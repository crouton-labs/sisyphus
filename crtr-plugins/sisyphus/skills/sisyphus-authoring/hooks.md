# Authoring Hooks

Hooks are shell scripts the daemon registers with Claude Code at agent spawn. They fire on specific lifecycle events (tool calls, prompts, agent stop) and can block, mutate, or annotate the agent's behavior. Sisyphus uses them for the bail-and-report pattern, the SendMessage interception, the bg-task registry, and the plan-validate gates.

## What's manifest-driven, what's script-driven

A hook is two things:

1. **A manifest entry** in `hooks.json` declaring which event/matcher/agent-type to bind to.
2. **A script** the entry's `command` references, copied into the agent's plugin dir at spawn.

The manifest is the wiring. The script is the behavior. **They live in the same layer** — your project-local manifest references your project-local scripts via `${CLAUDE_PLUGIN_ROOT}/hooks/<script>.sh`.

## Manifest schema (`hooks.json`)

```json
{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "<optional tool name or regex>",
        "agentTypes": ["plan", "review", "all"],
        "condition": "non-interactive",
        "hooks": [
          { "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/<script>.sh" }
        ]
      }
    ]
  },
  "disable": ["bundled-script-name.sh"]
}
```

| Field | Purpose |
|---|---|
| `<EventName>` | One of Claude Code's hook events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`. |
| `matcher` | For `Pre*`/`Post*ToolUse`, the tool name (or `Write\|Edit\|MultiEdit` style alternation). Omit for events without matchers (Stop, UserPromptSubmit). |
| `agentTypes` | **Sisyphus-specific.** Names of agent types this hook applies to. `["all"]` means every spawned agent. Omitted = `["all"]`. The daemon strips this field from the merged manifest before sending to Claude. |
| `condition` | Currently only `"non-interactive"` — drop the entry when the agent has `interactive: true` in its frontmatter. Used for the bundled `require-submit.sh` Stop hook. |
| `hooks` | Array of hook commands per the Claude Code schema. Use `${CLAUDE_PLUGIN_ROOT}` to reference scripts inside the agent's plugin dir. |
| `disable` | Top-level array of bundled script *basenames* to suppress. Higher layers can disable lower-layer hooks. |

## Event taxonomy — when each fires

| Event | When | Common uses |
|---|---|---|
| `PreToolUse` | Before Claude invokes a tool. The hook can block by exiting non-zero with stderr. | Validate Bash commands, gate Write paths, intercept `SendMessage`. |
| `PostToolUse` | After a tool succeeds. Output piped to Claude as system feedback. | Register background tasks, log tool usage, record artifacts. |
| `UserPromptSubmit` | Each time the user (or task) sends a prompt to the agent. | Inject reminders, restate constraints, append session-specific context. |
| `Stop` | When the agent is about to exit. Blocks the exit if non-zero. | The bundled `require-submit.sh` enforces a final-report submission before the agent can stop. |

The bundled hooks at `templates/agent-plugin/hooks/` are the canonical examples. Read them before authoring your own — they're short.

## Script conventions

Hook scripts run in the agent's pane shell with `$SISYPHUS_*` env vars exported. They receive Claude Code's hook payload on stdin as JSON. Standard pattern:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Read the hook input from stdin (Claude Code passes a JSON envelope)
INPUT=$(cat)

# Extract what you need with jq (jq is assumed present — bundled hooks rely on it)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Decide
if [[ "$TOOL_NAME" == "Bash" ]]; then
  # ... your gate logic ...
  if violates_policy; then
    echo "[hook] Bash command blocked: ..." >&2
    exit 1   # non-zero blocks the tool call
  fi
fi

exit 0
```

Conventions to match the bundled style:

- Always `set -euo pipefail` at top.
- Read the JSON envelope from stdin once at the top.
- Send human-readable diagnostics to stderr — Claude sees stderr on PreToolUse blocks.
- Exit 0 to allow, non-zero to block (PreToolUse) or annotate (PostToolUse).
- Reference paths via `$SISYPHUS_SESSION_DIR/...` not hardcoded.
- No interactive prompts — hooks run non-interactively.

## How merge works at spawn time

When an agent spawns, the daemon walks layers in priority order (project > user > bundled) and:

1. Reads each layer's `hooks.json`, filters by `agentTypes` and `condition`.
2. Concatenates surviving entries into a single merged `hooks.json` written into the agent's plugin dir.
3. Strips `agentTypes` and `condition` from emitted entries — they're sisyphus-specific filters, Claude Code doesn't know them.
4. Copies hook scripts from each layer's `hooks/` dir; higher layer wins on filename collision.
5. Skips scripts named in any layer's `disable` list.
6. Skips scripts not referenced by any surviving manifest entry — avoids leaking bundled scripts that only applied to other agent types.

Practically: **dropping `hooks.json` and a script in `.sisyphus/agent-plugin/hooks/` is sufficient to extend.** No daemon code changes needed.

## When to add a hook vs change the agent prompt

Hooks are deterministic enforcement; prompts are guidance. Reach for a hook when:

- The agent must *not* do X regardless of what its prompt says (an audit agent must never edit `src/`). A hook gives you certainty.
- A behavior must happen *every* invocation (register every Bash command in a log). Prompts are forgettable; hooks aren't.
- You need to inject text the agent can't ignore (UserPromptSubmit hooks dump system messages into the conversation).

Reach for a prompt change when:

- The behavior is judgment-driven (when to bail, what to prioritize). Hooks can't make those calls.
- You're tuning style or scope. A 200-line script that pattern-matches the agent's intent is a worse design than a 3-line prompt update.

## Common patterns

### Project-wide pre-Bash gate

Block any Bash command that touches `prod` for any agent type:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "agentTypes": ["all"],
        "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/no-prod.sh" }]
      }
    ]
  }
}
```

### Per-type UserPromptSubmit reminder

Inject a reminder every prompt for `review` agents:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "agentTypes": ["review"],
        "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/review-reminder.sh" }]
      }
    ]
  }
}
```

The script writes the reminder to stdout — Claude treats stdout as additional context to feed to the agent.

### Suppress a bundled hook

If the bundled `plan-validate.sh` is too strict for your workflow:

```json
{
  "hooks": { "PreToolUse": [] },
  "disable": ["plan-validate.sh"]
}
```

`disable` suppresses the *script* (so it's not copied) and removes any merged manifest entry whose command references it.

## Common authoring mistakes

- **Hardcoding `/path/to/script.sh` instead of `${CLAUDE_PLUGIN_ROOT}/hooks/script.sh`.** The plugin dir is created fresh each spawn under `.sisyphus/sessions/<id>/prompts/<agent>-plugin/`. Hardcoded absolute paths from your project root won't resolve.
- **Forgetting `set -euo pipefail`.** Hook scripts that silently fail leave the agent running with broken assumptions.
- **Blocking PreToolUse without a stderr diagnostic.** The agent sees stderr on a block — without a clear message, it doesn't know why and may retry the same call.
- **Adding `agentTypes` to a Stop hook for an interactive agent.** Stop hooks need `condition: "non-interactive"` to be filtered out for interactive agents — `agentTypes: ["all"]` alone won't drop them. Without the condition, your interactive `spec` or `problem` agent gets stuck in the require-submit loop.
- **Manifest entries that reference scripts in another layer.** Each layer's manifest should reference its own scripts. Cross-layer references work because all scripts get copied into one plugin dir, but they obscure ownership and break when a layer is removed.
- **Missing `agentTypes` filter on a hook that should be type-specific.** Default is `["all"]` — leaving it off means every agent runs your hook, which is rarely what you want.
