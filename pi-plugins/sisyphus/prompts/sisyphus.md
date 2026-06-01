---
description: Hand off a task to sisyphus multi-agent orchestration
argument-hint: "[task description]"
---

You are handing a task to **sisyphus**, a multi-agent orchestration runtime driven by the `sis` CLI.

First, confirm the CLI is available and check current usage:

```bash
sis -h
```

Then start a session with `sis session start`, giving it a concise task/goal and optional background context:

```bash
sis session start "your task description" -c "background context"
```

**Task description** — the goal. Keep it focused: what needs to be built or fixed and what done looks like. This is the persistent objective the orchestrator sees every cycle.

**Context (`-c`)** — background info that informs the work but isn't the goal itself: relevant file paths, constraints, specs, adjacent concerns, prior findings. Rendered separately so the orchestrator can reference it without confusing it with the task.

**Context should be factual, not diagnostic.** Point to relevant files, areas of the codebase, and constraints — don't speculate on root causes or solutions, which can bias the orchestrator down the wrong path.

**Example:**

```bash
sis session start "Fix the JWT refresh bug — app shows blank screen on token expiry instead of redirecting to login" -c "Auth system lives in src/auth/. Key files: interceptor.ts (HTTP interceptor), token-store.ts (token persistence), refresh.ts (refresh flow). Tests in src/auth/__tests__/. Don't break the logout flow."
```

**Long task or context?** Pipe via stdin to avoid shell escaping:

```bash
cat task.md | sis session start --stdin -c "short context here"
cat ctx.md  | sis session start "short task"   --context-stdin
```

The same `--stdin` flag also exists on `sis agent spawn`, `sis orch message`, `sis orch tell`, `sis session resume`, and the agent-side `sis agent submit` / `sis agent report` / `sis orch yield`.

---

The user's task (if provided): $ARGUMENTS

If a task was provided above, draft a focused `sis session start` invocation for it — distilling a crisp goal and factual `-c` context from the conversation — show it to the user, and run it once they confirm. If no task was provided, ask the user what they want to hand to sisyphus.
