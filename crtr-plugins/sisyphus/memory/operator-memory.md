---
kind: knowledge
when-and-why-to-read: When the operator agent is about to submit its final report, this skill should be read because it directs how to update the project-local operator memory — what to capture, whether it belongs in SKILL.md or a new reference file, naming conventions, and what to skip.
short-form: Updating project-local operator memory right before the operator's final report.
system-prompt-visibility: name
file-read-visibility: none
---
# Updating operator memory

You're about to submit. Spend a minute capturing what the next operator should not have to rediscover.

The memory lives at `.sisyphus/agent-plugin/skills/operator/`:
- `SKILL.md` — the high-level map of this app's surfaces and operations
- per-task-family reference files alongside it (`auth.md`, `db-reset.md`, `checkout-flow.md`, etc.)

## When to update (and when NOT to)

The bar is **"will future operators benefit from this?"** Specifics:

UPDATE when you discovered:
- A repeatable operational procedure (login flow, db reset, seed step, environment toggle)
- A surface that wasn't obvious (admin route, debug overlay, hidden flag, internal port)
- A footgun you hit and worked around (race condition, ordering requirement, stale-cache trap)
- A convention this app uses that differs from defaults (custom auth headers, non-standard ports, weird redirect chains)

DON'T update when:
- It's session-specific state (this user's email, this session's seeded data)
- It's a one-off observation that won't reproduce
- It's already covered (read existing files first — duplication is worse than nothing)
- It's about the codebase, not about operating the app — that's the orchestrator's domain, not yours

## SKILL.md vs a reference file

**SKILL.md** is the high-level map. It answers "what surfaces does this app have, what are the most common operations, where do I find deep dives?" Keep it dense — under ~80 lines. Each entry is a line or two with a pointer.

**A reference file** is the deep dive for one task family. It answers "exactly how do I do X step by step in this project". Each file has scope: `auth.md`, `db-reset.md`, `checkout-flow.md`, `feature-flags.md`.

Decision rule:
- New task family the operator might face → new reference file (and add a one-line entry to SKILL.md's Reference Files section).
- Refinement to existing knowledge → update the existing reference file or SKILL.md.
- A surface name you keep referencing → add it to SKILL.md's App Surfaces section once.

## Naming conventions

- Reference files: kebab-case, task-family scope, no `operator-` prefix (the directory already implies it), `.md` extension.
- Good: `auth.md`, `admin-panel.md`, `db-reset.md`, `feature-flags.md`.
- Bad: `operator-auth.md`, `flows.md`, `notes.md`, `stuff.md`.
- One file per task family. If `auth.md` exists, append to it; don't create `auth-new.md` or `auth-2.md`.

## How to update

1. **Read first.** Open the current `SKILL.md` and any reference file you'll touch — orient before writing. Avoid duplicating what's already there.
2. **Write/edit with the Write or Edit tool.** The directory already exists at `.sisyphus/agent-plugin/skills/operator/` (the hook scaffolds it on first run).
3. **Keep prose dense.** The next operator pays in tokens for everything you write. If a step is obvious, omit it.
4. **Register new reference files** by adding a one-line entry to `SKILL.md`'s "Reference files" section so they're discoverable.

For frontmatter, length budgets, and general skill structure rules, invoke `crtr memory read claude-authoring/skills`. Don't reinvent those rules here — this skill only covers operator-specific guidance.

## Examples

**Discovered magic-link auth flow:** Create `auth.md` with the steps (email submit → check inbox → click link → cookie set). Add a one-liner to `SKILL.md` App Surfaces (`/login` — magic-link, see `auth.md`). Add to Common Operational Patterns (`Log in: see auth.md`).

**Hit a stale-cache footgun:** The `/dashboard` route serves stale data for ~30s after a write because of an SWR cache. Add a single bullet to `SKILL.md` Known Footguns: `Dashboard SWR cache holds stale data ~30s after writes — hard refresh or wait`. No new reference file needed — it's a one-liner.

**Found admin overlay:** `?admin=1` query param toggles an admin panel with seed/reset buttons. Add to `SKILL.md` App Surfaces: `Admin overlay: append ?admin=1 to any page; has seed/reset/feature-flag buttons`. If the overlay is rich enough to need step-by-step coverage, create `admin-panel.md` and link from there.
