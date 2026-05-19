# Companion Roadmap

## In progress

### Companion memory
The companion should accumulate observations about the user over time — not just stat counters but qualitative understanding. This feeds into commentary generation.

Possible approach: a small structured file (~/.sisyphus/companion-memory.json) with:
- Recent session sentiments (rolling window)
- Repo impressions (beyond visits/crashes — actual characterization)
- User patterns ("works late", "prefers quality over speed", "gets frustrated with tech debt")
- Notable moments ("first 10-agent session", "longest streak")

### Direct conversation with companion
Users should be able to talk to the companion directly — not just read its status bar quips. Could be:
- `sis companion chat` — a short exchange
- A TUI overlay mode
- Integration into the orchestrator prompt so the companion can comment during sessions

This is the furthest out. Needs design for what the interaction model looks like and what the companion can actually do in response.

## Future ideas
- Companion reacts to git state (big merge, conflict resolution, force push)
- Repo-specific personality shifts (companion is nervous in repos with high crash history)
- Companion "remembers" past sessions and references them in commentary
- Seasonal/calendar awareness (holidays, weekends, late nights)
- Multiple companion personas/skins
