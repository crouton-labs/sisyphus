---
kind: knowledge
when-and-why-to-read: When you are working inside or around a sisyphus multi-agent session — orchestrating a run, authoring an extension, drafting a problem document, or debugging a past session — this index should be read because it routes you to the right sisyphus skill for the phase you are in.
short-form: Index of the sisyphus orchestration & agent-authoring skill set.
system-prompt-visibility: name
file-read-visibility: none
---

# Sisyphus skills

Skills for the sisyphus multi-agent orchestration system — the stateless orchestrator, the agents it spawns in tmux panes, and the on-disk session state that ties them together. Start with `sisyphus` for the mental model, then reach for the skill matching your phase.

## Mental model
- **sisyphus** — runtime mental model, agent/sub-agent boundaries, the daemon, cycles, and workflow patterns. Read this before reasoning about any session.

## Running a session
- **orchestration** — task-breakdown patterns for structuring tasks, sequencing agents, and managing cycles. Sub-references cover per-workflow `roadmap.md` patterns, `strategy.md` authoring, end-to-end examples, and the `sis orch yield --mode` gotcha.
- **perspective-fanout** — protocol for fanning out eight parallel perspective sub-agents and synthesizing them (MEDIUM effort and above).

## Shaping the problem
- **problem-document** — drafting `context/problem.md`, the artifact that orients downstream spec/plan/implement agents.
- **problem-plateau-breakers** — four breaker-deck shapes for restarting a stalled problem-agent dialogue.

## Authoring & extending
- **sisyphus-authoring** — author agents, sub-agents, hooks, skills, and orchestrator modes. Sub-references: `agents`, `hooks`, `skills`, `modes`, `layout`.
- **operator-memory** — updating project-local operator memory right before the operator's final report.

## Debugging
- **sisyphus-autopsy** — forensic reconstruction and judgment of a past session, including from outside the project directory.
