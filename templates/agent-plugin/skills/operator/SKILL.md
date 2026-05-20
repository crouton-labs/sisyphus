---
name: operator
description: Project-local operational knowledge for THIS app, accumulated by prior operator runs. Covers app surfaces (routes, ports, processes, admin overlays), auth/login flow, db state management, common UI flows, and known footguns. Use whenever the operator agent needs project-specific operating knowledge — read at session start, update before submitting.
---

# Operator memory for this project

This is the operator agent's accumulated memory for THIS project. Each prior operator run added what it learned. You should add what you learn before submitting.

If this file looks mostly empty, you're early — populate as you go. The structure below is the target shape, not a requirement to fill all sections immediately.

## App surfaces

Routes, ports, processes, admin overlays, debug flags. One line each — link to a reference file if there's depth.

- *(populate as you discover them)*

## Common operational patterns

Login, logout, db reset, seeding, environment toggles. Brief — defer details to reference files.

- *(populate as you discover them)*

## Known footguns

Things that broke once and might break again — race conditions, ordering requirements, stale-cache traps.

- *(populate as you discover them)*

## Reference files

One line per file in this directory. Add an entry here when you create a new reference.

- *(none yet)*

---

For guidance on what to capture, where to put it (SKILL.md vs new reference file), and naming conventions, run `crtr skill read sisyphus/operator-memory` (`.content`) before submitting.
