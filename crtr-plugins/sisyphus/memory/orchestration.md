---
kind: skill
when-and-why-to-read: When you are planning orchestration strategy or structuring a multi-agent sisyphus session, this skill should be read because it supplies the task-breakdown patterns for structuring tasks, sequencing agents, and managing cycles across debugging, feature builds, and refactors.
short-form: Task-breakdown patterns for structuring sisyphus orchestrator sessions.
system-prompt-visibility: name
file-read-visibility: none
---
# Orchestration Patterns

How to structure sisyphus sessions for common task types. This skill helps the orchestrator break work into tasks, choose agent types, sequence cycles, and handle failures.

## Core Principles

1. **roadmap.md is the orchestrator's memory.** roadmap.md and agent reports persist across cycles — they're all you have. Keep roadmap.md current and specific enough that a fresh orchestrator can pick up where you left off.

2. **Agents are disposable.** Each agent gets one focused instruction. If it fails or the scope changes, spawn a new one — don't try to redirect a running agent.

3. **Parallelize when independent.** If two tasks don't share files or depend on each other's output, spawn agents for both in the same cycle.

4. **Interleave verification.** Don't batch all implementation and defer review to the end. Embed critique and validation checkpoints between stages based on risk — the more subsequent work depends on a stage being correct, the more it needs verification before you build on it.

5. **Reports are handoffs.** Agent reports should contain everything the next cycle's orchestrator needs — what was done, what was found, what's unresolved, where artifacts were saved.

## Agent Types

Available agent types are listed under **Available Agent Types** in your prompt. Use `--agent-type` with `sis agent spawn`.

For task breakdown patterns per workflow type, see [task-patterns.md](orchestration/task-patterns.md).
For end-to-end workflow examples, see [workflow-examples.md](orchestration/workflow-examples.md).
For strategy.md authoring — stage patterns, process shapes, format — see [strategy.md](orchestration/strategy.md).
