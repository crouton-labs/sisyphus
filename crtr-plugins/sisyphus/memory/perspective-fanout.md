---
kind: knowledge
when-and-why-to-read: When a problem-agent dialogue has produced enough substance to react to but conclusions have not hardened — typically four-plus turns in with a framing solidifying, at MEDIUM effort or above — this skill should be read because it gives the protocol for fanning out eight parallel perspective sub-agents, synthesizing them, and presenting the synthesis back via a render+deck pair.
short-form: Protocol for spawning eight parallel perspective sub-agents and synthesizing their output.
system-prompt-visibility: name
file-read-visibility: none
---
# Perspective fanout

Spawn the eight perspective lenses as parallel sub-agents to challenge convergence before the framing locks in. The agents operate from a shared problem statement so their outputs are directly comparable. After they return, synthesize and surface to the user — convergence, surprises, insights — as the seed for the next dialogue turn.

## When to spawn

- The conversation has substance to react to (typically four or more turns in)
- A framing is starting to solidify
- You want to challenge convergence, not rescue a stalled discussion
- You have already formed your own take

If the conversation is stalled, use a plateau-breaker instead — perspective fanout needs material to push against.

## Before spawning: write the shared problem statement

Two or three sentences, given verbatim to all eight agents:

- What's happening (or not happening)
- What's been considered so far (from your exploration and the user input)
- What a good outcome looks like

This shared framing is what makes the eight outputs comparable. Different framings produce different conversations and the synthesis collapses.

## The eight lenses

Spawn one sub-agent per lens, all in the background, in parallel:

| Lens | Brief |
|---|---|
| First Principles | Strip away assumptions. What is the actual problem at its most fundamental level? |
| User Empathy | Forget the code. What does the person using this actually need? |
| Simplifier | What can be deleted, removed, or skipped? The best solution might be no solution. |
| Systems Thinker | Zoom out. What are the second-order effects? What breaks downstream? |
| Contrarian | Take the opposite position of whatever seems obvious. |
| Time Traveler | Six months from now, what will we wish we had done? |
| Adversarial | Assume the current approach is wrong. Find the flaw, the hidden assumption that breaks under stress. |
| Precedent | Has this been solved before? In this codebase, in open source, in a different domain entirely? |

Continue the conversation with the user while the agents run. Do not block.

## Synthesis

When the eight return, write to `$SISYPHUS_SESSION_DIR/context/perspective-synthesis.md` covering:

- **Convergence** — where multiple lenses pointed the same direction (signal worth trusting)
- **Surprises** — which perspective said something nobody else did (potential breakthroughs)
- **Insights** — name each key finding in a memorable sentence the user can carry forward

Then display in the side pane (live-watched, scrollable):

```bash
printf '{"path":"%s"}' "$SISYPHUS_SESSION_DIR/context/perspective-synthesis.md" | crtr human show >/dev/null
```

Bail on non-zero exit with the file path and exit code.

## Surface to the user

Issue the synthesis deck. No `${var}` shell assignments needed; angle-bracket placeholders are pre-substituted:

- `<one-line convergence>` — where multiple lenses pointed the same direction
- `<one-line surprise>` — what a single lens said that nobody else did

```bash
synth_deck="$SISYPHUS_SESSION_DIR/context/.ask-problem-synth-$(date +%s)-$$.json"
cat > "$synth_deck" <<EOF
{
  "interactions": [{
    "id": "problem-perspective-synth",
    "title": "Lens synthesis",
    "subtitle": "After 8 perspective agents",
    "body": "## In the side pane\n\n- Synthesis displayed via `crtr human show` — scroll and react below.\n\n## What I'm hearing\n\n- <one-line convergence>\n- <one-line surprise>",
    "kind": "decision",
    "options": [
      {"id": "breakthrough",    "label": "Breakthrough — this lens reframes it"},
      {"id": "useful",          "label": "Useful but not load-bearing"},
      {"id": "wrong-direction", "label": "Wrong direction — discard"},
      {"id": "mixed",           "label": "Mixed — see freetext"}
    ],
    "allowFreetext": true,
    "freetextLabel": "Which lens, what landed, what's still missing"
  }]
}
EOF
result=$(sis ask deck submit "$synth_deck") || { sis agent submit "Synthesis deck failed — deck: $synth_deck"; exit 1; }
[ -n "$result" ] || { sis agent submit "Synthesis deck: empty result — deck: $synth_deck"; exit 1; }
choice=$(echo "$result" | jq -r '.responses[0].selectedOptionId // empty')
notes=$(echo  "$result" | jq -r '.responses[0].freetext // ""')
```

## Routing after synthesis

All four option ids return to the dialogue loop's turn-deck flow.

- `breakthrough`, `useful`, `mixed` — carry the synthesis forward into the next turn's framing (the next turn deck body should reference what landed)
- `wrong-direction` — discards the synthesis but does not exit the loop
- `notes` flows into the next turn's framing regardless of `choice`

**Increment the turn counter `N`** before issuing the next turn deck. Skipping the increment produces two consecutive `Turn N — <lens>` subtitles with the same N, breaking inbox scannability.

## Failure handling

- If more than four of eight agents return errors, surface partial results if any returned cleanly, otherwise bail
- If `crtr human show` fails on the synthesis render, bail with file path and exit code
- If the synthesis deck fails or returns empty, bail with the deck path

## Body content rules

The deck `body` field uses `##` headings, bullet lists, and bold only — no tables, no code fences, no directive fences (`:::`).
