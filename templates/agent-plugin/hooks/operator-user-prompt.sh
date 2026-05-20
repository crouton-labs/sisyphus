#!/bin/bash
# UserPromptSubmit hook: scaffold project-local operator memory on first run,
# then reinforce paranoid testing.
if [ -z "$SISYPHUS_SESSION_ID" ]; then exit 0; fi

# ── Scaffold project-local operator memory ──────────────────────────────────
# On first run in a project, .sisyphus/agent-plugin/skills/operator/ doesn't
# exist. The bundled seed has already been copied into this agent's per-spawn
# plugin dir by the daemon (operator.md frontmatter lists skills: [operator]),
# so it's reachable via $CLAUDE_PLUGIN_ROOT — copy it from there to the
# project layer so future operator runs pick up the project-layer overlay.
SCAFFOLDED=0
if [ -n "$SISYPHUS_CWD" ] && [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
  PROJECT_MEMORY_DIR="$SISYPHUS_CWD/.sisyphus/agent-plugin/skills/operator"
  BUNDLED_SEED_DIR="$CLAUDE_PLUGIN_ROOT/skills/operator"
  if [ ! -f "$PROJECT_MEMORY_DIR/SKILL.md" ] && [ -d "$BUNDLED_SEED_DIR" ]; then
    mkdir -p "$PROJECT_MEMORY_DIR"
    cp -R "$BUNDLED_SEED_DIR/." "$PROJECT_MEMORY_DIR/"
    SCAFFOLDED=1
  fi
fi

if [ "$SCAFFOLDED" = "1" ]; then
  cat <<'HINT'
<operator-memory-scaffolded>
Project-local operator memory was just scaffolded at .sisyphus/agent-plugin/skills/operator/ — read it now (it's a stub; you're the first operator in this project). Before submitting your final report, run `crtr skill read sisyphus/operator-memory` (`.content`) and update the memory with whatever future operators should not have to rediscover.
</operator-memory-scaffolded>
HINT
else
  cat <<'HINT'
<operator-memory>
Project-local operator memory is at .sisyphus/agent-plugin/skills/operator/ — read it now to inherit what prior operators learned. Before submitting your final report, run `crtr skill read sisyphus/operator-memory` (`.content`) and update the memory with anything new you discovered.
</operator-memory>
HINT
fi

cat <<'HINT'
<operator-reminder>
Click EVERYTHING — assume something is broken and prove it:

- Every link, button, nav item, dropdown, toggle, accordion, interactive element on the page
- Edge cases: empty forms, duplicate submissions, back-button mid-flow, double-clicks, rapid navigation, browser refresh mid-action
- Check ALL sources: DOM, console errors, network failures, logs — not just what's visually obvious
- Spawn subagents to parallelize when scope is broad (one per page/flow/feature area) — the cost of missing a broken button is higher than an extra agent
</operator-reminder>
HINT
