# Multi-Repo Session Support

## Summary

Sisyphus treats single-repo and multi-repo sessions as different cases, producing misleading worktree messaging when run from a parent directory. This feature unifies the model: every session has repos (one or many), worktree config is always keyed by repo, and the orchestrator always gets a consistent Repositories section. A `repos` config field filters which repos are relevant, `--repo` targets agents at specific repos, and a `SISYPHUS_SESSION_DIR` env var decouples session state access from agent CWD.

## Behavior

### Unified Repo Model

Every session has repos. The system auto-detects them:
- If the session root is a git repo, it is a repo (identified as `"."`).
- Child directories that are git repos are also detected.

A `repos` field in `.sisyphus/config.json` filters which repos the orchestrator sees:

```json
{
  "repos": ["frontend", "backend", "shared-lib"]
}
```

- Each entry is a directory name relative to the session root.
- Without `repos` config, auto-detected repos are shown.
- The config is advisory — it filters orchestrator context but does not restrict agent operations.
- `repos` is project-level config only. Multi-repo structure is inherently per-project.

### Orchestrator Context

The orchestrator's per-cycle state prompt always includes a **Repositories** section (replacing the current **Git Worktrees** section). This section shows:

- Each repo with: current branch, clean/dirty status, and whether a worktree config exists for it.
- Agent repo assignments (which agents targeted which repos).
- Worktree status per agent (merged, conflict, pending, no-changes) — same info as today, but organized under the repo it belongs to.
- Spawn syntax for `--repo`.

There is no conditional switching between section types. One repo or five, same format.

### Worktree Configuration

`.sisyphus/worktree.json` is always keyed by repo name. No flat format.

**Single-repo session:**
```json
{
  ".": {
    "symlink": ["node_modules"],
    "init": "npm install"
  }
}
```

**Multi-repo session:**
```json
{
  "frontend": {
    "symlink": ["node_modules"],
    "init": "npm install"
  },
  "backend": {
    "copy": [".env"],
    "init": "go mod download"
  }
}
```

Each value has the same shape: `{ copy?, clone?, symlink?, init? }`.

This is a breaking change — existing flat-format `worktree.json` files must be updated to use `"."` as the key. If a flat-format file is encountered at runtime, it is rejected with an error message directing the user to migrate.

### Agent Repo Targeting

`sis agent spawn` gains a `--repo <name>` option:

```bash
sis agent spawn --name "impl-api" --repo backend "Add REST endpoints"
sis agent spawn --name "impl-api" --repo backend --worktree "Add REST endpoints"
```

**`--repo` behavior:**
- Sets the agent's tmux pane starting directory to `{session_root}/{repo}` (or session root if `"."`).
- Recorded in session state so the orchestrator knows which repo each agent targeted.
- Defaults to `"."` when the session root is a git repo and no `--repo` is specified.
- Required when the session root is not a git repo (the agent needs a git context to work in).

**With `--worktree`:**
- The worktree is created from the targeted repo's git root.
- The worktree config for that repo key is used for bootstrap.
- `--repo` must resolve to a git repo.

**Validation:**
- The directory must exist: `{session_root}/{repo}/`
- With `--worktree`, the target must be a git repo (has `.git`).
- The value is not validated against `repos` config — any valid subdirectory is accepted.
- If `--repo` is omitted and the session root is not a git repo, spawn fails with an error before contacting the daemon.

### Agent State

Each agent records its `repo`. This appears in:
- The orchestrator's Repositories section (agents grouped by repo).
- Worktree merge operations (merges target the correct repo's git root).

### Session Directory Access

Agents and orchestrators receive a `SISYPHUS_SESSION_DIR` environment variable — the absolute path to the session's state directory. Hook scripts and templates reference session files via this variable instead of constructing paths from `SISYPHUS_CWD` + session ID.

### CLI CWD Resolution

CLI commands that read session state (`list`, `resume`, `rollback`) respect the `SISYPHUS_CWD` environment variable (falling back to `process.cwd()`), matching the existing pattern in `start`.

## Constraints

- Breaking change: existing flat-format `worktree.json` files must migrate to keyed format with `"."` as the key.
- Worktree merge operations target the agent's repo git root, not the session root. The `.sisyphus` state snapshot before merge still targets the session root.
- The orchestrator always runs in the session root directory. Only agents get repo targeting.
- Auto-detection scans only immediate children for git repos (not recursive).

## Related Files

- `src/shared/config.ts`
- `src/shared/protocol.ts`
- `src/shared/types.ts`
- `src/shared/paths.ts`
- `src/cli/commands/spawn.ts`
- `src/cli/commands/list.ts`
- `src/cli/commands/resume.ts`
- `src/cli/commands/rollback.ts`
- `src/daemon/agent.ts`
- `src/daemon/orchestrator.ts`
- `src/daemon/worktree.ts`
- `src/daemon/server.ts`
- `src/daemon/session-manager.ts`
- `templates/orchestrator-base.md`
- `templates/orchestrator-planning.md`
- `templates/agent-plugin/hooks/require-submit.sh`
- `templates/agent-plugin/agents/spec-draft.md`
- `templates/agent-plugin/agents/test-spec.md`
