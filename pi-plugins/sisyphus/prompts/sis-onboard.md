---
description: First-time sisyphus setup — install deps, daemon, keybinds, verify everything, run tutorial
---

You are walking the user through first-time sisyphus setup. Drive the whole flow yourself — run each command, read the output, fix issues, and only stop to ask the user when you genuinely need a decision (e.g., `--force` would overwrite their existing keybinds).

## 1. Run setup

Run this and read the full output:

```bash
sis admin setup -y
```

`-y` auto-accepts the `~/.tmux.conf` source-file append. This installs tmux (macOS only, via brew), the daemon, the editor/agent integrations, and the `C-s` prefix menu + `M-s` cycle key. On a fresh tmux install with no existing `~/.tmux.conf`, it also writes sensible defaults (mouse, scrollback, `C-n`/`C-p` window nav, `prefix n`/`N` for new window/session, `M-=`/`M--` split/kill, vi copy-mode).

**If setup reports a keybind conflict** (status `requires-force` or `conflict`), stop and ask the user:
- Show the existing binding from the output.
- Offer three options: pick a different cycle key (`sis admin setup-keybind M-w`), force-overwrite (`sis admin setup -f -y`), or skip keybinds for now.
- Do not run `--force` without explicit confirmation — it overwrites their binding.

## 2. Verify install health

Run both in parallel:

```bash
sis admin doctor
sis admin check-keybinds
```

Read both outputs carefully. For each failure or warning:
- **Daemon not running** → `sisyphusd start` (or `sis admin setup` again if the plist is missing).
- **Keybind missing/stale** → `sis admin setup-keybind` to reinstall.
- **tmux not installed on Linux/WSL** → tell the user the exact apt/dnf command; sisyphus only auto-installs via brew.
- **Statusbar segments not wired** → `sis admin check-statusbar` for the diagnostic.

Don't pretend a warning is fine. If something's off, fix it before moving on.

## 3. Get the user into tmux (with this conversation resumed)

Check `$TMUX` to see whether the user is already inside tmux.

**If `$TMUX` is set** (already in tmux) — reload the conf so the new keybinds take effect:

```bash
tmux source-file ~/.tmux.conf
```

Then continue to step 4.

**If `$TMUX` is empty** (not in tmux yet) — they need to start a tmux session and resume this exact conversation inside it. Tell the user to open a new terminal and run, in order:

```
tmux new -s sisyphus
pi -c
```

`tmux new -s sisyphus` drops them into tmux; `pi -c` continues this most-recent pi session inside it. (If `pi -c` picks the wrong session, use `pi -r` to choose from the list.) Tell them to reply here once they're back. Then stop and wait — do not proceed to step 4 until they confirm. When they reply, you'll be running inside tmux (`$TMUX` set) and can move on.

## 4. Run the interactive tutorial

Hand off to the built-in tutorial — it has its own state machine and walks through `sis session start`, the dashboard, the `C-s` menu, and a real test task:

```bash
sis ui guide
```

The tutorial is self-driving; let it talk to the user. Don't narrate over it. If they get stuck mid-tutorial, they can re-enter at any step with `sis ui guide --tutorial <N>`.

## 5. Wrap up

Once the tutorial finishes (or the user opts out), give them a short cheat sheet:
- `sis session start "<task>"` — hand a task to sisyphus
- `C-s h` — open the dashboard from any tmux pane
- `C-s x` — smart kill-pane (jumps home if it's the last pane)
- `M-s` — cycle through sisyphus sessions
- `sis admin doctor` — re-run if anything feels off

Then stop. Don't keep generating advice.

## Diagnostic allow-list

Run freely without asking:
- `sis admin setup`, `sis admin setup -y`, `sis admin setup-keybind`, `sis admin doctor`, `sis admin check-keybinds`, `sis admin check-statusbar`, `sis ui guide`
- `tmux -V`, `tmux source-file ~/.tmux.conf`, `tmux list-keys`
- `which tmux`, `which sis`, `node --version`

## Ask before running

- `sis admin setup --force` (overwrites user's existing keybinds)
- `sis admin uninstall`, anything that removes config
- Manual edits to `~/.tmux.conf` (sisyphus is supposed to manage its own block; don't write outside it)
