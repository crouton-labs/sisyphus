import type { Command } from 'commander';
import {
  cloudAttach,
  cloudClaudeLogin,
  cloudInstall,
  cloudSession,
  cloudStart,
  cloudStatus,
  cloudSync,
} from '../cloud/runner.js';
import { cloudHandoff, cloudHandoffCancel, cloudReclaim } from '../cloud/handoff.js';
import { inferRepoName } from '../cloud/repo.js';
import { pickProvider } from '../deploy/provider-pick.js';
import type { Provider } from '../deploy/creds.js';
import { validateRepoName } from '../../shared/shell.js';

interface CommonRaw {
  name?: string;
  provider?: string;
}

interface StartRaw extends CommonRaw {
  fresh?: boolean;
  yes?: boolean;
}

function resolve(raw: CommonRaw): { provider: Provider; repo: string } {
  const provider = pickProvider(raw.provider);
  const repo = raw.name ? raw.name : inferRepoName();
  if (!validateRepoName(repo)) {
    throw new Error(`Invalid --name "${repo}": must not contain '/' '\\' or '..'.`);
  }
  return { provider, repo };
}

export function registerCloud(program: Command): void {
  const cloud = program
    .command('cloud')
    .description('Per-repo workflow on the shared cloud box (sync, install, dashboard).')
    .addHelpText('before', '\ncloud: per-repo workflow on the deployed box. box (provision/sync/run), handoff (move sessions).\n');

  // cloud box is exactly at the 7-child cap (sync/install/session/attach/status/login/up) — adding another verb requires a further sub-noun.
  const box = cloud
    .command('box')
    .description('Provision / operate the box for this repo')
    .addHelpText('before', '\ncloud box: box-side environment for this repo. sync | install | session | attach | status | login | up.\n');

  box
    .command('sync')
    .description('Rsync this repo to the cloud box; ensures grove is installed and the repo is registered.')
    .option('--fresh', 'Wipe the box-side dir and `git clone` from origin instead of rsync.')
    .option('--yes', 'Skip the --fresh confirmation prompt.')
    .option('--name <repo>', 'Override the repo name (default: basename of git toplevel).')
    .option('--provider <name>', 'Cloud provider (default: auto-pick if exactly one is provisioned).')
    .addHelpText('after', `
cloud box sync: rsync local repo to the cloud box, install grove, register the repo.

Input
  --fresh           optional — wipe box-side dir and git clone from origin instead of rsync.
  --yes             optional — skip the --fresh confirmation prompt.
  --name <repo>     optional — override the repo slug (default: basename of git toplevel).
  --provider <name> optional — cloud provider (default: auto-pick if exactly one is provisioned).

Output (stdout, streaming text)
  Progress lines as rsync and grove-setup steps complete.
  Final: "✓ synced <repo> → <target>:<remoteDir>/"
  on error: throws with a descriptive message; exits non-zero.

Effects
  Rsyncs local working tree to box (or git-clones fresh).
  Ensures grove is installed on the box.
  Registers the repo with grove on the box.
  Writes/updates the local cloud sidecar (lastSync, originUrl, localHostname).

Exit codes: 0 ok | 1 rsync/clone/grove error | 2 usage`)
    .action(async (raw: StartRaw) => {
      const { provider, repo } = resolve(raw);
      await cloudSync(provider, repo, { fresh: raw.fresh === true, yes: raw.yes === true });
    });

  box
    .command('install')
    .description('Run the repo\'s package-manager install on the box.')
    .option('--name <repo>', 'Override the repo name.')
    .option('--provider <name>', 'Cloud provider.')
    .addHelpText('after', `
cloud box install: run the repo's package-manager install on the box.

Input
  --name <repo>     optional — override the repo slug.
  --provider <name> optional — cloud provider (default: auto-pick).

Output (stdout, streaming text)
  Progress line "→ <pm> install in <remoteDir> on box..." then install output.
  Final: "✓ installed <repo> (<pm>)"
  If no lockfile is detected: "No lockfile detected — skipping install."
  on error: throws with a descriptive message; exits non-zero.

Effects
  Runs package-manager install inside the box-side repo dir.
  Updates local cloud sidecar (lastInstall, packageManager).

Exit codes: 0 ok | 1 install error | 2 usage`)
    .action(async (raw: CommonRaw) => {
      const { provider, repo } = resolve(raw);
      await cloudInstall(provider, repo);
    });

  box
    .command('session')
    .description('Create or refresh the box-side tmux home session for this repo.')
    .option('--name <repo>', 'Override the repo name.')
    .option('--provider <name>', 'Cloud provider.')
    .addHelpText('after', `
cloud box session: create or refresh the box-side tmux home session for this repo.

Input
  --name <repo>     optional — override the repo slug.
  --provider <name> optional — cloud provider (default: auto-pick).

Output (stdout, streaming text)
  "→ initializing tmux home session \"<repo>\" on box..."
  Final: "✓ session \"<repo>\" ready on box"
  on error: throws with home-init failure message; exits non-zero.

Effects
  Runs sis diagnostic home-init on the box via ssh.
  Creates (or refreshes) the named tmux session on the box.

Exit codes: 0 ok | 1 ssh/home-init error | 2 usage`)
    .action(async (raw: CommonRaw) => {
      const { provider, repo } = resolve(raw);
      await cloudSession(provider, repo);
    });

  box
    .command('attach')
    .description('Attach to the box-side tmux home session for this repo.')
    .option('--name <repo>', 'Override the repo name.')
    .option('--provider <name>', 'Cloud provider.')
    .addHelpText('after', `
cloud box attach: SSH into the cloud box and attach to the repo's tmux session.

Input
  --name <repo>     optional — override the repo slug.
  --provider <name> optional — cloud provider (default: auto-pick).

Output (interactive — attaches to tmux session; no structured output)

Effects
  Opens an SSH connection to the box with tmux attach-session.
  Process exits with the ssh/tmux exit code.

Exit codes: 0 ok | 1 ssh error or tmux attach failed | 2 usage (including: called from inside tmux)`)
    .action((raw: CommonRaw) => {
      const { provider, repo } = resolve(raw);
      cloudAttach(provider, repo);
    });

  box
    .command('status')
    .description('Print box-side status for this repo (planted, session running, last sync/install).')
    .option('--name <repo>', 'Override the repo name.')
    .option('--provider <name>', 'Cloud provider.')
    .addHelpText('after', `
cloud box status: print box-side status for this repo.

Input
  --name <repo>     optional — override the repo slug.
  --provider <name> optional — cloud provider (default: auto-pick).

Output (stdout, plain text — human-readable box status summary; not for agentic consumption)
  Multi-line status block: provider, target, planted (yes/no), originUrl, lastSync,
  lastInstall, packageManager, session (running/absent), attach command if running.
  on error: throws; exits non-zero.

Effects
  None. Read-only.

Exit codes: 0 ok | 1 ssh probe error | 2 usage`)
    .action((raw: CommonRaw) => {
      const { provider, repo } = resolve(raw);
      cloudStatus(provider, repo);
    });

  box
    .command('login')
    .description('Run auth login on the box (device-code flow; paste the URL into your local browser).')
    .option('--provider <name>', 'Cloud provider.')
    .addHelpText('after', `
cloud box login: run claude auth login on the box via an interactive SSH session.

Input
  --provider <name> optional — cloud provider (default: auto-pick).

Output (interactive — device-code flow; prompts for browser auth)
  SSH session streams claude auth login output. User pastes device code from local browser.

Effects
  Installs claude-code on the box if not already present.
  Completes claude auth login on the box (writes box-local credentials).
  Process exits with the ssh exit code.

Exit codes: 0 ok | 1 ssh or auth error | 2 usage`)
    .action((raw: CommonRaw) => {
      const provider = pickProvider(raw.provider);
      cloudClaudeLogin(provider);
    });

  box
    .command('up')
    .description('Sync, install, and create the box session in one shot (cold start). Stops short of attach.')
    .option('--fresh', 'Wipe the box-side dir and `git clone` from origin instead of rsync.')
    .option('--yes', 'Skip the --fresh confirmation prompt.')
    .option('--name <repo>', 'Override the repo name.')
    .option('--provider <name>', 'Cloud provider.')
    .addHelpText('after', `
cloud box up: sync + install + session in one shot (cold-start shortcut).

Input
  --fresh           optional — wipe box-side dir and git clone from origin instead of rsync.
  --yes             optional — skip the --fresh confirmation prompt.
  --name <repo>     optional — override the repo slug.
  --provider <name> optional — cloud provider (default: auto-pick).

Output (stdout, streaming text)
  Streams progress from sync, install, and session steps.
  Final: attach command hint ("Box-side dashboard ready. Attach with: ...").
  on error: throws at the failing step; exits non-zero.

Effects
  All effects of box sync + box install + box session, in sequence.
  Does NOT attach (use box attach afterwards).

Exit codes: 0 ok | 1 sync/install/session error | 2 usage`)
    .action(async (raw: StartRaw) => {
      const { provider, repo } = resolve(raw);
      await cloudStart(provider, repo, { fresh: raw.fresh === true, yes: raw.yes === true });
    });

  const handoff = cloud
    .command('handoff')
    .description('Move a live session between local and box')
    .addHelpText('before', '\ncloud handoff: move sessions between local and cloud.\n  push <session-id>    Send a live session to the cloud box.               | use when handing off a session to cloud\n  pull <session-id>    Reclaim a handed-off session back to local.          | use when resuming locally after cloud work\n  cancel <session-id>  Cancel a queued handoff before it fires.             | use when aborting a queued push before it fires\n');

  handoff
    .command('push <session-id>')
    .description('Hand off a live session to the cloud box. Queues at next quiesce; --force interrupts now.')
    .option('--provider <name>', 'Cloud provider (default: auto-pick).')
    .option('--name <repo>', 'Override the repo name on the box.')
    .option('--force', 'Interrupt in-flight orchestrator/agents now instead of queueing.')
    .option('--wait', 'Block until the handoff completes (or fails).')
    .addHelpText('after', `
cloud handoff push: send a live session to the cloud box.

Input
  <session-id>      required — the session to hand off.
  --provider <name> optional — cloud provider (default: auto-pick).
  --name <repo>     optional — override the repo slug on the box.
  --force           optional — interrupt agents now instead of queueing at next quiesce.
  --wait            optional — block until the handoff completes (polls up to 30 min).

Output (stdout, plain text)
  Queue confirmation or force-interrupt message, then tip to cancel if not --force.
  With --wait: "Handoff complete → <provider>:<repo> at <sentAt>."
  on error: exits non-zero with error message.

Effects
  Sends cloud-handoff request to the local daemon (queues or forces handoff).
  With --wait: polls local state.json until handoff.sentAt is set.
  The daemon orchestrates the actual session transfer to the box.

Exit codes: 0 ok | 1 daemon error or handoff failure | 2 usage`)
    .action(async (sessionId: string, raw: { provider?: string; name?: string; force?: boolean; wait?: boolean }) => {
      const provider = pickProvider(raw.provider);
      const repo = raw.name ? raw.name : inferRepoName();
      if (!validateRepoName(repo)) {
        throw new Error(`Invalid --name "${repo}": must not contain '/' '\\' or '..'.`);
      }
      await cloudHandoff(sessionId, { provider, repo, force: raw.force === true, wait: raw.wait === true });
    });

  handoff
    .command('pull <session-id>')
    .description('Pull a handed-off session back from the cloud box and resume locally.')
    .option('--provider <name>', 'Override the cloud provider (default: read from session.handoff).')
    .option('--force', 'Force the box-side session to stop now instead of waiting for quiesce.')
    .addHelpText('after', `
cloud handoff pull: reclaim a handed-off session from the cloud box and resume it locally.

Input
  <session-id>      required — the session to reclaim (must have handoff.sentAt in local state).
  --provider <name> optional — override the cloud provider (default: read from session.handoff target).
  --force           optional — force box-side stop now instead of waiting for quiesce.

Output (stdout, plain text)
  Step-by-step progress: quiesce, rsync, resume, box teardown.
  Final: "✓ <session-id> reclaimed; orchestrator respawning locally."
  on error: exits non-zero with error message.

Effects
  Quiesces the box-side session via ssh.
  Rsyncs session dir and working tree from box to local (two-pass).
  Resumes the orchestrator locally via daemon resume request.
  Tears down the box-side tmux session.
  Marks reclaim via daemon cloud-reclaim-finalize request.

Exit codes: 0 ok | 1 quiesce/rsync/resume/kill error | 2 usage | 3 not_on_cloud | conflict`)
    .action(async (sessionId: string, raw: { provider?: string; force?: boolean }) => {
      await cloudReclaim(sessionId, { providerOverride: raw.provider, force: raw.force === true });
    });

  handoff
    .command('cancel <session-id>')
    .description('Cancel a queued handoff before it fires.')
    .addHelpText('after', `
cloud handoff cancel: cancel a queued push handoff before it fires.

Input
  <session-id>      required — the session whose queued handoff to cancel.

Output (stdout, plain text — short confirmation; not for agentic consumption)
  "Handoff for <session-id> cancelled."
  on error: exits non-zero with error message.

Effects
  Sends cloud-handoff-cancel request to the local daemon.
  The daemon dequeues the pending handoff for this session.

Exit codes: 0 ok | 1 daemon error (e.g. no queued handoff) | 2 usage`)
    .action(async (sessionId: string) => {
      await cloudHandoffCancel(sessionId);
    });
}
