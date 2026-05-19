import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import {
  deployDown,
  deployLogs,
  deploySsh,
  deployStatus,
  deployUp,
  deployUpdate,
  type UpOptions,
} from '../deploy/runner.js';
import { PROVIDERS, type Provider } from '../deploy/creds.js';
import { authTailscale } from '../deploy/tailscale.js';

interface RawUpOptions {
  region?: string;
  arch?: string;
  size?: string;
  sshKey?: string;
  chromium?: boolean; // commander exposes --no-chromium as opts.chromium = false
  autoUpdate?: boolean;
  name?: string;
  yes?: boolean;
}

interface DownOptions {
  yes?: boolean;
}

function assertArch(raw: string): 'arm' | 'x86' {
  if (raw === 'arm' || raw === 'x86') return raw;
  throw new Error(`Invalid --arch: ${raw}. Must be 'arm' or 'x86'.`);
}

function defaultRegion(provider: Provider): string {
  return provider === 'hetzner' ? 'nbg1' : 'us-east-1';
}

function resolveUpOptions(provider: Provider, raw: RawUpOptions): UpOptions {
  // arch/name/sshKey carry commander-supplied defaults — guaranteed defined.
  if (!raw.arch || !raw.name || !raw.sshKey) {
    throw new Error('Internal error: commander failed to apply defaults for --arch/--name/--ssh-key.');
  }
  const arch = assertArch(raw.arch);
  // --region's default is provider-specific, so commander can't supply it.
  const region = raw.region === undefined ? defaultRegion(provider) : raw.region;
  // --size has no default — undefined means "fall through to the Terraform module's arch-based default".
  const size = raw.size === undefined ? null : raw.size;
  // commander: --no-chromium → chromium === false; absent → undefined (default install on)
  const withChromium = raw.chromium !== false;
  const enableAutoUpdate = raw.autoUpdate !== false;
  const yes = raw.yes === true;
  return { region, arch, size, sshKey: raw.sshKey, name: raw.name, withChromium, enableAutoUpdate, yes };
}

export function registerDeploy(program: Command): void {
  const deploy = program
    .command('deploy')
    .description('Provision a Tailscale-only sisyphus box on Hetzner or AWS via Terraform.')
    .addHelpText('before', '\ndeploy: provision sisyphus boxes (Terraform). auth (creds), hetzner | aws (per-provider lifecycle), list (provider catalog).\n');

  deploy.action(() => {
    deploy.help();
  });

  // sisyphus deploy auth tailscale — one-time OAuth client setup
  const auth = deploy
    .command('auth')
    .description('Configure deploy credentials.')
    .addHelpText('before', '\ndeploy auth: configure provider credentials. tailscale (OAuth + keys).\n');
  auth
    .command('tailscale')
    .description('Configure Tailscale OAuth client or fallback auth key.')
    .addHelpText('after', `
deploy auth tailscale: interactively configure Tailscale OAuth client or fallback auth key.

Input
  None.

Output (stdout, plain text — interactive credential setup; not JSON)
  Prompts for OAuth client ID/secret/tag or a reusable auth key, verifies, and saves.

Effects
  Writes credentials to ~/.sisyphus/deploy/tailscale.env (mode 0600).
  For OAuth path: verifies the client against the Tailscale API before saving.

Exit codes: 0 ok | 1 error (bad credentials or API failure).`)
    .action(async () => {
      await authTailscale();
    });

  for (const provider of PROVIDERS) {
    const sub = deploy
      .command(provider)
      .description(`${provider} commands.`)
      .addHelpText('before', `\ndeploy ${provider}: per-provider box lifecycle. up | down | status | ssh | logs | update.\n`);

    sub
      .command('up')
      .description(`Provision the ${provider} box (terraform init → plan → apply).`)
      .option('--region <region>', `Provider region (defaults: hetzner=nbg1, aws=us-east-1).`)
      .option('--arch <arch>', "'arm' (default) or 'x86'. Picks the default --size and image.", 'arm')
      .option('--size <size>', 'Instance type override (defaults follow --arch).')
      .option('--ssh-key <path>', 'Path to SSH public key.', join(homedir(), '.ssh', 'id_ed25519.pub'))
      .option('--no-chromium', 'Skip headless Chromium install.')
      .option('--no-auto-update', 'Skip the daily auto-update systemd timer.')
      .option('--name <name>', 'Box hostname / Tailscale node name.', 'sisyphus')
      .option('--yes', 'Skip the re-provision confirmation prompt when state already exists.')
      .addHelpText('after', `
deploy ${provider} up: provision the ${provider} box via Terraform (init → plan → apply).

Input
  --region <region>   optional — provider region (hetzner default: nbg1, aws default: us-east-1)
  --arch <arch>       optional — 'arm' (default) or 'x86'; selects default instance size and image
  --size <size>       optional — instance type override; omit to use arch-based default
  --ssh-key <path>    optional — path to SSH public key (default: ~/.ssh/id_ed25519.pub)
  --no-chromium       optional — skip headless Chromium install
  --no-auto-update    optional — skip daily auto-update systemd timer
  --name <name>       optional — box hostname / Tailscale node name (default: sisyphus)
  --yes               optional — skip re-provision confirmation when state already exists

Output (stdout, plain text — Terraform streaming output + status messages; not JSON)
  Streams terraform init/plan/apply output, then prints box IP, hostname, and next steps.

Effects
  Provisions a remote cloud box (EXPENSIVE — incurs billing). Runs terraform init, plan, apply.
  Writes Terraform state to ~/.sisyphus/deploy/${provider}/terraform.tfstate.
  Writes tailnet discovery state to ~/.sisyphus/deploy/${provider}/runtime.json.
  Mints a single-use Tailscale auth key (consumed during cloud-init).
  Hetzner re-provision: DESTROYS the existing box (user_data is ForceNew — all on-box data lost).

Exit codes: 0 ok | 1 error (terraform failure, missing credentials, or ssh key not found).`)
      .action(async (raw: RawUpOptions) => {
        const opts = resolveUpOptions(provider, raw);
        await deployUp(provider, opts);
      });

    sub
      .command('down')
      .description(`Destroy the ${provider} box (terraform destroy).`)
      .option('--yes', 'Skip confirmation prompt.')
      .addHelpText('after', `
deploy ${provider} down: destroy the ${provider} box via Terraform.

Input
  --yes   optional — skip confirmation prompt

Output (stdout, plain text — Terraform streaming output; not JSON)
  Streams terraform destroy output and prints confirmation on success.

Effects
  DESTROYS the remote cloud box (IRREVERSIBLE). All on-box data is lost.
  Backs up then clears Terraform state at ~/.sisyphus/deploy/${provider}/terraform.tfstate.
  Clears tailnet runtime state at ~/.sisyphus/deploy/${provider}/runtime.json.

Exit codes: 0 ok | 1 error (terraform failure or missing state).`)
      .action(async (opts: DownOptions) => {
        await deployDown(provider, { yes: opts.yes === true });
      });

    sub
      .command('status')
      .description(`Print current ${provider} outputs (IP, hostname, instance type, est. cost).`)
      .addHelpText('after', `
deploy ${provider} status: print current provisioning status and box details.

Input
  None.

Output (stdout, plain text — not JSON)
  Prints provisioned/not-provisioned, public IP, Tailscale hostname, instance type, and estimated cost.

Effects
  None. Read-only.

Exit codes: 0 ok | 1 error (Terraform state unreadable).`)
      .action(() => {
        deployStatus(provider);
      });

    sub
      .command('ssh [remoteCmd...]')
      .description(`SSH (or mosh, if available) into the ${provider} box via Tailscale.`)
      .addHelpText('after', `
deploy ${provider} ssh: SSH (or mosh) into the ${provider} box via Tailscale.

Input
  [remoteCmd...]   optional variadic — remote shell command to execute; all tokens join to a
                   single string passed as: ssh user@host <remoteCmd...>
                   Variadic carve-out: the variadic IS the primary target (a remote command line).
                   Omit to open an interactive shell (mosh if available, otherwise ssh).

Output (stdout/stderr passthrough from remote command — NOT JSON; ssh-passthrough carve-out)
  stdout/stderr from the remote command land verbatim. No JSON envelope.

Effects
  Executes the remote command on the box. Effects depend entirely on what is run remotely.
  Uses mosh for interactive sessions when mosh is on PATH and no remoteCmd is given.

Exit codes: forwarded from the remote process | 1 if box is not provisioned.`)
      .action((remoteCmd: string[]) => {
        deploySsh(provider, remoteCmd);
      });

    sub
      .command('logs')
      .description(`Tail cloud-init + daemon logs from the ${provider} box.`)
      .addHelpText('after', `
deploy ${provider} logs: tail cloud-init and daemon logs from the ${provider} box.

Input
  None.

Output (stdout/stderr passthrough — NOT JSON; ssh-passthrough carve-out)
  Streams /var/log/cloud-init-output.log and ~/.sisyphus/daemon.log via ssh + tail -F.
  Raw log text from the remote box; streams until interrupted (Ctrl-C).

Effects
  None on local state. Tails log files on the remote box (read-only).

Exit codes: forwarded from ssh | 1 if box is not provisioned.`)
      .action(() => {
        deployLogs(provider);
      });

    sub
      .command('update')
      .description(`Run \`npm i -g sisyphi@latest && systemctl --user restart sisyphusd\` on the ${provider} box.`)
      .addHelpText('after', `
deploy ${provider} update: update sisyphus to latest on the ${provider} box and restart the daemon.

Input
  None.

Output (stdout/stderr passthrough — NOT JSON; ssh-passthrough carve-out)
  Streams output of: sudo npm i -g sisyphi@latest && systemctl --user restart sisyphusd

Effects
  Updates sisyphi to latest on the remote box. Restarts the sisyphusd daemon.
  Does not modify local state.

Exit codes: forwarded from ssh | 1 if box is not provisioned.`)
      .action(() => {
        deployUpdate(provider);
      });
  }

}
