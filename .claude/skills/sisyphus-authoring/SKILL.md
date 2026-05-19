---
name: sisyphus-authoring
description: Author new sisyphus agents, sub-agents, hooks, skills, and orchestrator modes. Use when extending sisyphus runtime behavior — adding a domain-specific agent variant, project-level hook, custom orchestrator phase, or shared skill. Covers what to put in each file, why, and which extension to reach for.
user-invocable: true
paths:
  - "**/.sisyphus/**"
  - "**/templates/agent-plugin/**"
  - "**/templates/orchestrator-plugin/**"
  - "**/.sisyphus/agent-plugin/**"
  - "**/.sisyphus/orchestrator-plugin/**"
---

# Authoring Sisyphus Extensions

Sisyphus is extended via a layered plugin model that mirrors the bundled `templates/` layout. Project (`.sisyphus/`) and user (`~/.sisyphus/`) directories overlay the bundled defaults; higher layers win on collision.

→ Read the [sisyphus](../sisyphus/SKILL.md) skill first if you don't already have a mental model of orchestrator/agents/sub-agents/modes.

## Extend before you create

The single most important decision: **don't make a new agent type or mode unless extending an existing one is genuinely insufficient.** Custom agents are cheap to write and expensive to maintain — they fork the bundled prompt design philosophy, miss future improvements to bundled hooks, and create a parallel taxonomy other contributors have to learn.

Reach for these in order:

1. **Override the prompt of an existing agent**: drop a same-named `.md` in `.sisyphus/agent-plugin/agents/` (project) or `~/.sisyphus/agent-plugin/agents/` (user). Bundled sub-agents and hooks still apply unless you also override them. Best for "the bundled `review` agent is fine but I want it to weigh accessibility heavily."
2. **Add a hook to an existing agent type**: drop a `hooks.json` fragment with `agentTypes: ["review"]`. Best for "every review run should also `grep` for TODOs and call them out."
3. **Add a sub-agent to an existing agent**: drop a `.md` in the matching `agents/<type>/` subdir. Best for "the `review` agent should also have a `compliance` perspective alongside the bundled ones."
4. **Add a skill the agent opts into**: drop a `skills/<name>/SKILL.md` and reference it from the agent's frontmatter. Best for "this agent occasionally needs a regulatory checklist on hand."
5. **Add an orchestrator mode**: drop `orchestrator-<mode>.md`. Best for "the standard validation mode doesn't handle our post-deploy audit cycle — we need a distinct phase with its own selection of agents."
6. **Create a new agent type**: drop a fresh `.md` with frontmatter. Reserved for genuinely novel work patterns the bundled set doesn't approximate.

The user's example: *"if you wanted an agent for auditing runs and making tweaks after runs, you might create a `post-run-audit` mode with a dedicated agent and its own subagents."* — that's option 5+6 together, justified because "audit after run" is a new *phase of thinking* (mode) with novel work (new agent), not a tweak to existing behavior.

## The four extension surfaces

| Surface | Where it goes | What it does | Detailed guide |
|---|---|---|---|
| Agent type | `agent-plugin/agents/<name>.md` | Spawnable role with its own prompt, model, sub-agents, hooks | [agents.md](agents.md) |
| Hook | `agent-plugin/hooks/hooks.json` + `<name>.sh` | Lifecycle gate (PreToolUse, Stop, etc.) bound to one or more agent types | [hooks.md](hooks.md) |
| Skill | `agent-plugin/skills/<name>/SKILL.md` | On-demand reference an agent opts into via frontmatter | [skills.md](skills.md) |
| Orchestrator mode | `orchestrator-<name>.md` | A phase the orchestrator can enter; appended to the base prompt | [modes.md](modes.md) |

Orchestrator-side equivalents (commands, hooks, skills bound to the orchestrator itself) live in `orchestrator-plugin/`. Same shape, different audience — see [modes.md](modes.md).

## Layout cheat sheet

```
.sisyphus/                              # project (cwd) — highest priority
  agent-plugin/
    agents/<type>.md                    # new or override agent type
    agents/<type>.settings.json         # optional Claude Code settings sidecar
    agents/<type>/<sub>.md              # sub-agents auto-bundled at spawn
    hooks/hooks.json                    # manifest declaring extension hooks
    hooks/<name>.sh                     # hook scripts referenced by manifest
    skills/<name>/SKILL.md              # opt-in skills (via frontmatter)
  orchestrator-plugin/
    commands/sisyphus/<cmd>.md          # orchestrator slash commands
    hooks/hooks.json + <name>.sh
    skills/<name>/SKILL.md
  orchestrator-<mode>.md                # orchestrator modes
  orchestrator.md                       # full base-prompt override
  orchestrator-settings.json            # shallow-merge over bundled settings

~/.sisyphus/                            # user — same shape, fills in
templates/                              # bundled — lowest priority, sisyphus repo
```

→ Full layer resolution rules (override vs additive, disable lists, JSON merge semantics) in [layout.md](layout.md).

## Authoring style

Sisyphus agent prompts follow a distinct philosophy — **narrow scope, defensive posture, bail-and-report**. Agents own discipline; the orchestrator owns ambition. New agent prompts that ape the orchestrator's "ship it" voice break the contract.

- An agent prompt opens with the *one job* the agent has, then the constraints under which it does that job.
- It explicitly tells the agent when to **stop and report unexpected complexity** rather than push through.
- It doesn't try to give the agent enough context to make whole-product decisions — that's the orchestrator's role.

→ For the prompt-architecture principles (zones, tone registers, escalation ladder, decision frameworks, positive framing), invoke `/prompting-effectively` (user-level skill). The crucial sisyphus-specific applications:

- Agent `.md` body → behavior zone, "You are X" identity, third-person traits, second-person operations.
- Sub-agent `.md` body → behavior zone, but inherits the parent's identity — describe the *perspective*, not the whole role.
- Orchestrator mode body → behavior zone with `systemPrompt: append` semantics — your text is *added to* the base, not replacing it. Don't restate the orchestrator's identity.
- Hook scripts → no prompting; they're shell. They inject text via stdout that the agent sees as a system message.

## Common pitfalls

- **Reinventing `plan` or `review`.** Override the prompt or add a sub-agent before forking the type.
- **Hooks that depend on bundled scripts by name.** The script name `plan-validate.sh` is a bundled implementation detail — if your hook needs to run *alongside* it, register your own script; don't assume the bundled one will exist forever.
- **Skill content in `agents/<type>.md`.** If guidance is reusable across agent types or sessions, extract it to `skills/<name>/` and have agents opt in. Skill content baked into an agent body is invisible to other agents that could have used it.
- **Orchestrator modes that duplicate `discovery` or `planning`.** Read [modes.md](modes.md) for what makes a mode genuinely distinct vs. a tweak that should live in the base prompt.
- **Project-local hooks that override bundled scripts silently.** Use the `disable: ["script.sh"]` escape hatch in your manifest if you mean to suppress. A same-named script in the higher layer wins, but reviewers won't know it's a deliberate replacement without the explicit disable.
- **`.claude/agents/` for sisyphus extensions.** That works for the agent body but won't pick up co-located hooks or skills. For sisyphus-flavored extensions with hooks/skills, use `.sisyphus/agent-plugin/agents/`.

## Verifying an extension works

After dropping a new file:

1. Restart the daemon: `sis admin daemon restart` (the daemon caches plugin layers per session).
2. Spawn an affected agent (or open the orchestrator) and inspect the rendered plugin in the session prompts dir: `cat .sisyphus/sessions/<id>/prompts/<agent>-plugin/hooks/hooks.json` shows the merged hook manifest, and `ls` of the same dir shows which scripts/skills got copied.
3. For agent types: `sis agent spawn --type=<your-type> ...` will fail loudly if discovery missed your file.
4. For modes: the orchestrator's system prompt lists available modes under `{{ORCHESTRATOR_MODES}}` — if your mode isn't there, check the filename pattern (`orchestrator-<name>.md`, no underscores, lowercase) and `description` frontmatter.

## Reference files

- [agents.md](agents.md) — agent type frontmatter, sub-agents, prompt structure, when to make a new type vs override
- [hooks.md](hooks.md) — `hooks.json` schema, event taxonomy, `agentTypes` filter, `condition: non-interactive`, `disable` list, script conventions
- [skills.md](skills.md) — what an agent-side skill is, how the `skills:` frontmatter field wires it in, when a skill belongs in `agent-plugin/` vs `orchestrator-plugin/`
- [modes.md](modes.md) — orchestrator modes vs agents, mode discovery, mode-specific content builders, when to author commands instead
- [layout.md](layout.md) — layer resolution order, override vs additive merge per surface, hooks `disable`, settings shallow-merge, daemon caching
