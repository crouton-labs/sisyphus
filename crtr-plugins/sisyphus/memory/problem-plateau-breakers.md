---
kind: knowledge
when-and-why-to-read: When the problem-agent dialogue loop has stalled — repeated circling, user freetext like "different angle" or "feels stuck", or the sense of chasing one framing without traction — this skill should be read because it provides four breaker-deck shapes (flip, zoom-out, zoom-in, name-tension) and the routing for each before returning to the dialogue loop.
short-form: Four breaker-deck shapes for restarting a stalled problem-agent dialogue.
system-prompt-visibility: name
file-read-visibility: none
---
# Plateau-breaker decks

When the conversation circles, the user wants a *different shape of question*, not another variation of the same one. Pick the breaker whose move matches the stall pattern, issue the deck, then resume the turn loop.

## Pick the breaker type

| Type | Use when | Move |
|---|---|---|
| `flip` | The conversation keeps assuming a position is correct | Embrace the opposite — what changes if we believed the inverse? |
| `zoom-out` | The conversation is litigating details before establishing whether they matter | Step back — does this distinction even change the outcome? |
| `zoom-in` | The conversation is trading abstractions without testing them against a real case | Pick a concrete scenario and see if the framing survives |
| `name-tension` | Two values are being held in tension without naming the trade-off | Surface the tension itself as the question |

Choose one per stall. Do not chain breakers — if a breaker doesn't unstick the conversation, the next one is the *next* stall, counted toward the repeated-stuck guard.

## Issue the deck

Required prior assignments before the heredoc:
- `type` — one of `flip` / `zoom-out` / `zoom-in` / `name-tension`

Angle-bracket placeholders (substitute literally before writing the heredoc):
- `<observation>` — what the conversation has been circling
- `<reframe>` — provisional alternative tied to the breaker type

```bash
type=flip  # or zoom-out / zoom-in / name-tension
deck="$SISYPHUS_SESSION_DIR/context/.ask-problem-plateau-${type}-$(date +%s)-$$.json"
cat > "$deck" <<EOF
{
  "interactions": [{
    "id": "problem-plateau-${type}",
    "title": "Plateau breaker",
    "subtitle": "Plateau breaker — ${type}",
    "body": "## Stalled\n\n- <observation>\n\n## Reframe\n\n- <reframe>",
    "kind": "decision",
    "options": [
      <options for this type — see table below>
    ],
    "allowFreetext": true,
    "freetextLabel": "Or describe the angle differently"
  }]
}
EOF
result=$(sis ask deck submit "$deck") || { sis agent submit "Plateau-breaker deck failed — type: $type — deck: $deck"; exit 1; }
[ -n "$result" ] || { sis agent submit "Plateau-breaker deck: empty result — type: $type — deck: $deck"; exit 1; }
choice=$(echo "$result" | jq -r '.responses[0].selectedOptionId // empty')
notes=$(echo  "$result" | jq -r '.responses[0].freetext // ""')
```

## Per-breaker options

Pre-substitute the matching row before writing the heredoc:

| `type` | Options (id / label) |
|---|---|
| `flip` | `embrace-flipped` / "Embrace the flipped position" · `stick-original` / "Stick with original" · `merge-both` / "Merge both" |
| `zoom-out` | `drop-doesnt-matter` / "Doesn't matter — drop" · `smaller-scope` / "Matters but smaller" · `matters-as-is` / "Matters as is" |
| `zoom-in` | `scenario-breaks-it` / "This scenario breaks it" · `scenario-holds` / "Scenario holds" · `different-scenario` / "Different scenario" |
| `name-tension` | `pick-side-A` / "Pick A" · `pick-side-B` / "Pick B" · `tension-itself` / "The tension itself is the problem" |

## After the response

Increment the turn counter `N` and return to the dialogue loop's turn-deck flow. The user's `choice` and `notes` flow into the next turn's framing.

## Body content rules

The deck `body` field uses `##` headings, bullet lists, and bold only — no tables, no code fences, no directive fences (`:::`). Violations fail humanloop's `checkMarkdown` inside `parseDeck`.

## Sanitize freetext on bail

If you bail with the user's freetext in the message, sanitize it first:

```bash
safe_notes=$(printf '%s' "$notes" | tr -d '`$"\\')
```

Raw `"$notes"` in a shell-interpolated bail message is a defect.
