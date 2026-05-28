# Authoring Skills for Sisyphus Agents

Skills here are *agent-side reference material* — on-demand documentation an agent can pull into context when its work intersects with the skill's domain. They're distinct from user-invocable skills and from the runtime-model `sisyphus` skill (`crtr skill read sisyphus`).

## Two layers of skills

Sisyphus has two parallel skill surfaces, each serving a different audience:

| Layer | Audience | Where it goes | When to use |
|---|---|---|---|
| Agent-plugin skills | Spawned agents (one at a time) | `agent-plugin/skills/<name>/SKILL.md` | Reference the agent opts into per its frontmatter |
| Orchestrator-plugin skills | The orchestrator only | `orchestrator-plugin/skills/<name>/SKILL.md` | Always available to the orchestrator across all cycles |

Bundled examples:
- `orchestrator-plugin/skills/orchestration/SKILL.md` — strategy and task patterns the orchestrator references when planning cycles.

## When a skill is the right shape

Skills are the right shape when **the same content would be useful across multiple agent types or sessions**. The litmus test: if you'd copy-paste the same paragraphs into two different agent bodies, extract them into a skill instead.

Reach for a skill when:
- Domain knowledge is reusable (regulatory checklist, security taxonomy, code-style guide).
- The reference is too long for an agent body but too narrow for the always-on `sisyphus` skill.
- Multiple agent types benefit, and inlining duplicates content.
- The reference changes independently of any single agent's prompt.

Don't make a skill for:
- One-off agent-specific instructions — those belong in the agent's `.md` body.
- Project-wide context every agent needs — that's `CLAUDE.md` territory at the project root.
- Step-by-step procedures — those belong in command/skill files at the user level, not bundled with sisyphus extensions.

## File structure

```
agent-plugin/skills/<skill-name>/
  SKILL.md              # required, on-demand entry point
  reference.md          # optional, deeper reference
  examples.md           # optional
  scripts/              # optional bundled utilities
```

The skill's directory **name is its identifier** — `agent-plugin/skills/audit-checklist/` is referenced as `audit-checklist` in agent frontmatter.

## Wiring an agent-plugin skill in

**Agents must explicitly opt in** via the `skills:` field in frontmatter:

```yaml
---
name: post-run-audit
description: Audit a finished session for missed cleanup
skills:
  - audit-checklist
  - drift-taxonomy
---
```

At spawn, the daemon copies each named skill directory into the agent's plugin dir under `skills/`. The agent then sees them via Claude Code's skill discovery mechanism (loaded on demand based on the SKILL.md description and any `paths:` field).

**This is least-privilege by default**: an agent only sees skills it lists. A skill in `agent-plugin/skills/foo/` is invisible to any agent that doesn't request it.

Layer resolution: the daemon walks project > user > bundled looking for the skill name. Higher layer wins. So `.sisyphus/agent-plugin/skills/audit-checklist/` shadows a bundled skill of the same name.

## Wiring an orchestrator-plugin skill in

Orchestrator-plugin skills are **automatically available** to the orchestrator — no opt-in required. Drop a `SKILL.md` at `orchestrator-plugin/skills/<name>/SKILL.md` and the orchestrator can invoke it via `/skill:<name>` (Claude Code's standard skill syntax).

Use orchestrator-plugin skills for:
- Cross-cycle reference the orchestrator routinely needs.
- Decision frameworks the orchestrator should consult before delegating.
- Strategy patterns and task templates.

## SKILL.md content

Sisyphus skills follow the standard skill-authoring conventions. The most important rules:

- **Lead with the decision, not the mechanism.** "When you see X, do Y" before "how X works."
- **Budget ~150 lines for SKILL.md.** Push depth to `reference.md`.
- **Frontmatter `description` drives discovery.** Front-load the trigger keywords. The orchestrator's `{{AGENT_TYPES}}` listing and Claude's skill matcher both lean on it.
- **Skill markers vs reference markers.** A skill teaches judgment ("when to use," "when not to use"). A reference describes an API. If your SKILL.md reads like a man page, you've written a reference doc.

→ Full guide: read `crtr skill read claude-authoring/skills` for the general skill-authoring conventions (frontmatter fields, progressive disclosure, skill vs reference distinction).

## Frontmatter for sisyphus skills

```yaml
---
name: audit-checklist
description: Reference checklist for post-run audits — drift, TODOs, scaffolding, behavior changes. Use when auditing whether a session left residue.
paths:
  - "**/.sisyphus/sessions/**"
---
```

| Field | Why |
|---|---|
| `name` | Match the directory name. Used in the agent's `skills:` list and in Claude's `/skill:<name>` syntax. |
| `description` | The matcher signal. The agent reads this to decide whether to load the skill. |
| `paths` | Optional glob. Restricts when the skill auto-suggests itself based on files in scope. |
| `user-invocable: false` | If the skill is for agent reference only, hide it from the user's `/skill:` autocomplete. Agent-plugin skills are usually `false`. |

## When the skill should be `paths`-scoped

If a skill applies only when the agent works within a particular subsystem (`packages/api/**`, `terraform/**`, `.sisyphus/sessions/**`), set `paths` so it only auto-suggests in that scope. Skills without paths are always candidates — fine for general references, noisy for narrow ones.

## Common authoring mistakes

- **Inlining skill content in `agents/<type>.md`.** Now no other agent type can use it, and updating it requires editing the agent body. Extract.
- **Mixing agent-side and orchestrator-side skills.** `agent-plugin/skills/foo/` and `orchestrator-plugin/skills/foo/` serve different audiences. Decide which audience needs it; don't put it in both.
- **Skipping the `skills:` opt-in in agent frontmatter.** Even if the skill exists in `agent-plugin/skills/`, the agent only sees it if its frontmatter lists it. The opt-in is least-privilege by design.
- **A SKILL.md that's actually a reference.** If it has no decision framework and no "when to use," it belongs in `reference.md` and SKILL.md should be the judgment layer pointing at it.
- **Forgetting that skills compose with effort markers.** Use `<!--EFFORT:high-->` in skill bodies to scale depth — low-effort agents get a leaner skill on the same disk file.
