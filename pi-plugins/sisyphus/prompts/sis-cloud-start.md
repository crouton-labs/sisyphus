---
description: Sync this repo to the cloud box, start the dashboard, and attach in a new tmux window
argument-hint: "[--fresh] [--name <repo>] [--provider <hetzner|aws>]"
---

You are running `sis cloud start` against the user's shared cloud box and recovering from any setup failures until the box-side dashboard is healthy and the user is attached.

Start by running it and reading the full output to determine which subcommand (if any) failed on non-zero exit (`sync`, `install`, or `session`):

```bash
sis cloud start $ARGUMENTS
```

## Workflow

1. If the command above exited 0, jump to step 5. Otherwise continue.

3. **Failure recovery loop.** Re-run only the failed subcommand after fixing the root cause, then continue with the rest:
   - **`sync` failed** — usually network/SSH/disk:
     - `sis deploy <provider> ssh -- df -h` — disk full?
     - `sis deploy <provider> ssh -- tailscale status` — tailnet healthy?
     - Re-run: `sis cloud sync --name <repo>`
   - **`install` failed** — usually a missing native build dep:
     - Read the install error output for missing libraries (e.g. `pg`, `node-gyp`, `sharp`, `canvas`).
     - SSH in: `sis deploy <provider> ssh -- sudo apt-get install -y <package(s)>` (e.g. `libpq-dev`, `python3-dev`, `build-essential`, `libvips-dev`).
     - Re-run: `sis cloud install --name <repo>`
   - **`session` failed** — sisyphusd may not be running on the box:
     - `sis deploy <provider> ssh -- systemctl --user status sisyphusd`
     - If down: `sis deploy <provider> ssh -- systemctl --user restart sisyphusd`
     - Re-run: `sis cloud session --name <repo>`

4. After fixing, re-run the failed subcommand. If it now passes, continue with the next step (`install` after `sync`, `session` after `install`). Loop until `sis cloud session` succeeds.

5. Once everything is healthy, attach the user. Read the SSH target from `sis cloud status --name <repo>`, then:
   ```bash
   tmux new-window -n cloud-<repo> "ssh -t <ssh-target> tmux attach-session -t <repo>"
   ```
   The user's tmux focus shifts to the new window automatically. They land in the cloud session with the dashboard already open in window 1.

## Diagnostic allow-list

Run freely:
- Read-only: `node --version`, `which X`, `ls`, `cat`, `tail`, `df -h`, `free -m`, `cat package.json`
- Apt installs: `sudo apt-get install -y <package>`
- Sisyphus subcommands: `sis cloud install`, `sis cloud session`, `sis cloud status`

## Forbidden without explicit user approval

These can brick the box or wipe other repos' state:
- `apt-get remove`, `apt-get purge`, `apt-get autoremove`
- `npm rm -g sisyphi`, `npm rm -g @crouton-kit/grove`
- `tailscale logout`, `tailscale down`
- Touching `~/.sisyphus/` directly (other repos' sidecars + daemon state live here)
- Touching another repo's `~/projects/<other>/`
- Reinstalling Node, replacing systemd unit files, modifying `/etc/`

If you think you need any of these, ask the user first with the specific command and reason.

## Done

When the new tmux window is open, briefly confirm to the user:
- Repo synced to `~/projects/<repo>` on `<provider>`
- Any apt packages you installed during recovery
- The session name they're now in (so they can re-attach later with `sis cloud attach --name <repo>`)
