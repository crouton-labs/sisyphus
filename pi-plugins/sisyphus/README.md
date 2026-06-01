# pi-sisyphus

Pi prompt templates and skills for [sisyphus](https://github.com/crouton-labs/sisyphus) multi-agent orchestration. The pi-native counterpart to sisyphus's Claude Code commands under `plugins/sisyphus/commands/`.

## Prompt templates

| Command | Description |
|---|---|
| `/sisyphus [task]` | Hand a task to sisyphus orchestration (`sis session start`). Distills a focused goal + factual context, then runs it on confirmation. |
| `/sis-bug [what went wrong]` | File a sisyphus bug report — previews, gets approval, then opens a public GitHub issue with diagnostics. |
| `/sis-onboard` | First-time setup — installs deps, daemon, keybinds, verifies health, runs the tutorial. |
| `/sis-cloud-start [flags]` | Sync the repo to the cloud box, recover from setup failures, attach in a new tmux window. |
| `/sis-configure-upload <url>` | Configure auto-upload of completed sessions to a Cloudflare Worker. |

## Skills

| Skill | Description |
|---|---|
| `sisyphus-autopsy` | Forensic debugging of a past sisyphus session — reconstruct what each decision-maker could see and judge their calls. Ships a `references/autopsy-reference.md` mental-model doc. Invoke with `/skill:sisyphus-autopsy <session-id-or-path>` or let the model load it on a matching task. |

## Install

```bash
pi install /absolute/path/to/sisyphus/pi-plugins/sisyphus    # local
# or, once published from the sisyphus repo root:
# pi install git:github.com/crouton-labs/sisyphus
```

Then type `/sisyphus` (or any `/sis-*`) in the pi editor; the autopsy skill loads on demand or via `/skill:sisyphus-autopsy`.

## Porting notes

These were adapted from sisyphus's Claude Code commands:

- pi prompt templates expand to a prompt (no inline `` !`cmd` `` pre-execution), so each template instructs the agent to run the relevant `sis` command itself.
- Argument syntax converted to pi's (`$1`, `$@`, `$ARGUMENTS`).
- `autopsy` became a **skill** rather than a prompt template because it ships a companion reference doc — prompt templates can't bundle/embed files, skills can (`references/`).
- `onboard`'s "resume this conversation in tmux" step uses pi's `pi -c` / `pi -r` instead of Claude Code's `claude -r <session-id>`.
