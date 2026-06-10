---
kind: skill
when-and-why-to-read: When you are ready to draft context/problem.md — the thinking artifact that orients downstream spec/plan/implement agents to why the work exists — this skill should be read because it supplies the design principles, the section vocabulary to pick from, and an anchor example of the target style.
short-form: Drafting context/problem.md — the artifact that orients downstream agents to why the work exists.
system-prompt-visibility: name
file-read-visibility: none
---
# Designing the problem document

The problem document is a **thinking artifact**, not a spec. Its job is to orient downstream agents (spec, plan, implement) to *why* the work exists — what hurts, what's the non-obvious trick, what matters, what's risky — tightly enough that they can read the whole thing in under thirty seconds.

## Design principles

- **Scannable, not exhaustive.** A downstream agent reads this once before doing real work. It needs to walk away with the right mental model, not every detail of the conversation that produced it.
- **Sections are a vocabulary, not a checklist.** Use the sections that earn their place for *this* problem. Skip ones that don't. Add ones that do. Different problems need different shapes.
- **Each section answers a question a downstream agent would ask:** "What hurts? What's the trick? What are we building? Why is it tricky? What does done look like? What can't we do? What's still up in the air?" If a section doesn't answer one of those, cut it.
- **Tables and bullets do the structural work; prose fills gaps where tables would feel forced.** A central decision shown as a 2-row table is worth ten sentences of paragraph.
- **No alternatives section.** The forks you considered and rejected lived in the conversation — they don't need to live in the artifact. Downstream agents care about the path forward, not the paths not taken.
- **Length follows from clarity, not from rules.** When the thinking is crisp, the document is short on its own. If a section feels like it wants more words, the answer is usually to tighten the thinking, not expand the section.

## Section vocabulary

Pick what earns its place; rename freely.

- **The pain / what's wrong** — what hurts and why now
- **Key insight** — the non-obvious understanding that reframes the problem
- **What we're building** — the artifact(s) or change(s) the work produces
- **Why it's tricky** — failure modes, mental traps, things that defeat the obvious approach
- **What success looks like** — concrete outcomes, not metrics theater
- **Constraints** — what bounds the solution (not assumptions, not anti-goals — actual bounds)
- **Open questions** — unresolved choices the next phase needs to make

## Anchor example

This is the target style — terse, scannable, structured by what serves the content rather than by template:

<example>
# Session debugging is too expensive to do

## The pain
When a sisyphus session produces unexpected output, the maintainer can't
cheaply learn from it. The choice is between re-teaching Claude the
architecture every conversation, or doing manual archaeology across raw
JSONL files. Both are expensive enough that the learning loop gets skipped
entirely.

## Key insight
The data is already on disk — sisyphus just doesn't read it. Every agent's
full transcript lives at `~/.claude/projects/<cwd>/<sessionId>.jsonl` with
file touches, tokens, subagent spawns, and timing. The fix is a reader, not
new instrumentation.

## The two artifacts

| What | Why it's needed |
|---|---|
| **Debugging toolkit** (CLI verbs) | Cheap "what happened in session X" lookups Claude can compose with grep/jq |
| **Architecture skill** (SKILL.md) | A mental model Claude can pull when reasoning about sisyphus runtime — the novel multi-agent design defeats its priors |

Useless apart, powerful together. The toolkit answers *what*; the skill
answers *how to make sense of what*.

## Why the skill matters

Claude's failure modes when reasoning about sisyphus are predictable:
- Treats the orchestrator as a long-running process with memory (it's
  stateless, fork-per-cycle)
- Conflates sisyphus-managed agents with Claude-Code-managed Task-tool
  subagents
- Misses that "completed" means three different things at three levels
- Loses track of which channel agents communicate over

These aren't undocumented — they're scattered across CLAUDE.md files framed
as traps, not mental models. The skill is synthesis with decision heuristics,
not new philosophy.

## What success looks like

- Maintainer says "investigate session X", Claude pulls the skill, runs a
  couple of CLI queries, gives a grounded diagnosis citing real file paths
  and JSONL evidence — no re-teaching
- Same skill loads automatically for high-level architecture discussions,
  not just debugging
- Zero new instrumentation — derived from data already on disk plus a
  one-line fix to complete an existing index

## Constraints

- Claude Code JSONL format isn't a stable contract — reader must degrade
  gracefully if Anthropic changes it
- Codex/OpenAI agents have no equivalent transcript — known blind spot,
  not in scope

## Open questions

- Skill scope: one broad "sisyphus" skill (architecture + debugging) or
  split into two?
- Pre-fix sessions: accept they're harder to debug, or add an mtime-proximity
  fallback in the reader?
</example>

Notice what this example *doesn't* have: no "Alternatives Considered," no "Assumptions" section, no "User Experience" header (folded into success), no "Anti-Goals." Each section earned its place because the content needed it. A different problem would skip "Why the skill matters" and add "Migration path" or "User flows" — whatever the content demands.

## Bifurcation case

If the conversation revealed that the scope contains **independent sub-problems** rather than one problem with sub-parts, do not write a unified `problem.md`. Instead, use the bifurcation-exit pattern from the agent prompt — the orchestrator handles re-entering discovery for each sub-problem.
