import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { sendRequest } from '../client.js';
import { EXEC_ENV } from '../../shared/exec.js';
import { boxRepoPath, sessionDir, statePath, projectDir } from '../../shared/paths.js';
import { shellQuote, shellQuoteHomePath } from '../../shared/shell.js';
import { effectiveSshTarget } from '../deploy/runner.js';
import { runOnBox, runOnBoxStreaming } from '../deploy/ssh-exec.js';
import { pickProvider } from '../deploy/provider-pick.js';
import type { Provider } from '../deploy/creds.js';
import type { Request } from '../../shared/protocol.js';
import type { Session } from '../../shared/types.js';
import { join } from 'node:path';
import { exitError } from '../errors.js';

interface HandoffOptions {
  provider: Provider;
  repo: string;
  force: boolean;
  wait: boolean;
}

export async function cloudHandoff(sessionId: string, opts: HandoffOptions): Promise<void> {
  const cwd = process.env['SISYPHUS_CWD'] ?? process.cwd();

  const request: Request = {
    type: 'cloud-handoff',
    sessionId,
    cwd,
    provider: opts.provider,
    repo: opts.repo,
    force: opts.force,
  };
  const response = await sendRequest(request);
  if (!response.ok) exitError(response.error);

  const data = response.data as { force?: boolean; provider?: string; repo?: string } | undefined;
  const where = `${data?.provider ?? opts.provider}:${data?.repo ?? opts.repo}`;
  if (data?.force) {
    console.log(`Forcing handoff of ${sessionId} → ${where} (interrupting in-flight work).`);
  } else {
    console.log(`Handoff of ${sessionId} → ${where} queued; will fire at next quiesce point.`);
  }

  if (!opts.wait) {
    if (!opts.force) {
      console.log(`Tip: run \`sis cloud handoff cancel ${sessionId}\` to cancel before quiesce.`);
    }
    return;
  }

  console.log('Waiting for handoff to complete...');
  await waitForSentOrError(cwd, sessionId);
}

export async function cloudHandoffCancel(sessionId: string): Promise<void> {
  const cwd = process.env['SISYPHUS_CWD'] ?? process.cwd();
  const response = await sendRequest({ type: 'cloud-handoff-cancel', sessionId, cwd });
  if (!response.ok) exitError(response.error);
  console.log(`Handoff for ${sessionId} cancelled.`);
}

async function waitForSentOrError(cwd: string, sessionId: string): Promise<void> {
  const POLL_INTERVAL_MS = 2_000;
  const MAX_WAIT_MS = 30 * 60 * 1000; // 30 minutes — handoff might wait on long-running agents
  const start = Date.now();
  const path = statePath(cwd, sessionId);
  while (Date.now() - start < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);
    if (!existsSync(path)) continue;
    let session: Session;
    try {
      session = JSON.parse(readFileSync(path, 'utf-8')) as Session;
    } catch (err) {
      // state.json may be mid-write during a daemon update; just retry on next tick.
      // Don't log — polling cadence (every 2s) would flood the terminal.
      void err;
      continue;
    }
    if (session.handoff?.lastError) {
      exitError({
        code: 'handoff_failed',
        kind: 'permanent',
        message: `Handoff failed: ${session.handoff.lastError}`,
        received: sessionId,
      });
    }
    if (session.handoff?.sentAt) {
      const where = session.handoff.target
        ? `${session.handoff.target.provider}:${session.handoff.target.repo}`
        : 'cloud';
      console.log(`Handoff complete → ${where} at ${session.handoff.sentAt}.`);
      return;
    }
  }
  exitError({
    code: 'handoff_timeout',
    kind: 'transient',
    message: `Timed out waiting for handoff after ${Math.round(MAX_WAIT_MS / 60000)}m.`,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── reclaim ──────────────────────────────────────────────────────────────────

interface ReclaimOptions {
  providerOverride?: string;
  force: boolean;
}

export async function cloudReclaim(sessionId: string, opts: ReclaimOptions): Promise<void> {
  const cwd = process.env['SISYPHUS_CWD'] ?? process.cwd();

  // 1. Read local session.handoff to find the target. Override provider if user
  //    explicitly passed one (rare — usually the recorded target is correct).
  const local = readLocalSession(cwd, sessionId);
  if (!local.handoff?.sentAt) {
    exitError({
      code: 'not_on_cloud',
      kind: 'conflict',
      message: `Session ${sessionId} is not on cloud (no handoff.sentAt). Nothing to reclaim.`,
      received: sessionId,
    });
  }
  if (local.handoff.reclaimedAt) {
    exitError({
      code: 'already_reclaimed',
      kind: 'conflict',
      message: `Session ${sessionId} was already reclaimed at ${local.handoff.reclaimedAt}.`,
      received: sessionId,
    });
  }
  if (!local.handoff.target) {
    exitError({
      code: 'corrupted_handoff',
      kind: 'permanent',
      message: `Session ${sessionId} has handoff.sentAt but no target — corrupted state.`,
      received: sessionId,
    });
  }
  const provider = pickProvider(opts.providerOverride ?? local.handoff.target.provider);
  const repo = local.handoff.target.repo;
  const target = effectiveSshTarget(provider);
  const remoteSessionDir = `${boxRepoPath(repo)}/.sisyphus/sessions/${sessionId}`;
  const remoteRepoDir = boxRepoPath(repo);

  console.log(`Reclaiming ${sessionId} from ${provider}:${repo}...`);

  // 2. Tell box-side daemon to quiesce. Box-side `sis session recover quiesce` calls the
  //    `admin-quiesce` RPC against the box's local daemon socket. Must `cd`
  //    into the repo first so the CLI uses the right cwd to find state.json.
  const quiesceBase = opts.force
    ? `sis session recover quiesce ${shellQuote(sessionId)} --force`
    : `sis session recover quiesce ${shellQuote(sessionId)}`;
  const quiesceCmd = `cd ${shellQuoteHomePath(remoteRepoDir)} && ${quiesceBase}`;
  console.log(`→ ssh box: ${quiesceCmd}`);
  const quiesceCode = await runOnBoxStreaming(provider, quiesceCmd);
  if (quiesceCode !== 0) {
    exitError({
      code: 'box_quiesce_failed',
      kind: 'transient',
      message: `Box-side quiesce failed (exit ${quiesceCode}).`,
      received: quiesceCode,
    });
  }

  // 3. Poll the box's state.json until status === 'paused'. The box-side
  //    daemon sets status=paused inside `quiesceLocalSession` after all panes
  //    are torn down.
  console.log(`→ waiting for box-side session to reach paused...`);
  await waitForBoxPaused(provider, remoteSessionDir);

  // 4. Two-pass rsync down. Session dir first (--delete so local mirrors box
  //    exactly), then working tree (NO --delete — we don't want to clobber
  //    local files the user may have created since the original handoff).
  console.log(`→ rsync session state down`);
  await rsyncDown(target, `${remoteSessionDir}/`, `${sessionDir(cwd, sessionId)}/`, { withDelete: true });

  // CRITICAL excludes:
  // - `.sisyphus/`: without this, the box's `.sisyphus/sessions/*/state.json`
  //   for OTHER live sessions on this box overwrites their local state,
  //   clobbering cwd and wiping handoff.sentAt. Target session came down in
  //   the previous --delete pass; top-level configs are pulled explicitly
  //   below.
  // `update: true`: prefer newer-on-local files. Without it, the box's older
  //   copy of any file (incl. this very source if edited mid-reclaim) wins
  //   over local edits made after the original handoff.
  console.log(`→ rsync working tree down`);
  await rsyncDown(target, `${remoteRepoDir}/`, `${cwd}/`, { withDelete: false, excludeSisyphus: true, update: true });

  // Top-level project configs aren't in the session dir; pull them too.
  for (const name of ['config.json', 'orchestrator.md', 'orchestrator-settings.json']) {
    const remotePath = `${remoteRepoDir}/.sisyphus/${name}`;
    const localPath = join(projectDir(cwd), name);
    const probe = runOnBox(provider, `test -f ${shellQuote(remotePath.replace(/^~\//, ''))} && echo y || echo n`);
    if (probe.stdout.trim() !== 'y') continue;
    await rsyncDown(target, remotePath, localPath, { withDelete: false });
  }

  // Restore local-only fields the rsync clobbered. See CLAUDE.md in this
  // directory for the trap:
  // - cwd: box has `/home/sisyphus/projects/<repo>`; daemon would write
  //   atomic temp files to that nonexistent macOS path and fail.
  // - handoff: box never sees `handoff.sentAt` (it's set locally only after
  //   the push-side ssh resume succeeds), so rsync-down wipes it and
  //   `cloud-reclaim-finalize` rejects without it.
  const localStatePath = statePath(cwd, sessionId);
  const merged = JSON.parse(readFileSync(localStatePath, 'utf-8')) as Session;
  merged.cwd = cwd;
  merged.handoff = local.handoff;
  writeFileSync(localStatePath, JSON.stringify(merged, null, 2));

  // 5. Locally resume — spawn orchestrator with a context message about reclaim.
  const reclaimMessage = `Session reclaimed from cloud (${provider}:${repo}). Resuming locally.`;
  console.log(`→ local sis resume`);
  const resumeResp = await sendRequest({
    type: 'resume',
    sessionId,
    cwd,
    message: reclaimMessage,
  });
  if (!resumeResp.ok) exitError(resumeResp.error);

  // 6. Tear down box-side. `sis session lifecycle kill` is destructive but fine — the
  //    box state is now mirrored locally; we don't want a stale tmux session
  //    living on. Same `cd` requirement as quiesce above.
  const killCmd = `cd ${shellQuoteHomePath(remoteRepoDir)} && sis session lifecycle kill ${shellQuote(sessionId)}`;
  console.log(`→ ssh box: ${killCmd}`);
  const killResult = runOnBox(provider, killCmd);
  if (killResult.exitCode !== 0) {
    console.warn(`Warning: box-side kill exited ${killResult.exitCode}: ${killResult.stderr.trim()}`);
  }

  // 7. Mark reclaimed locally.
  const finalizeResp = await sendRequest({ type: 'cloud-reclaim-finalize', sessionId, cwd });
  if (!finalizeResp.ok) {
    const errMsg = typeof finalizeResp.error === 'string' ? finalizeResp.error : finalizeResp.error.message;
    console.warn(`Warning: failed to finalize reclaim state: ${errMsg}`);
  }

  console.log(`✓ ${sessionId} reclaimed; orchestrator respawning locally.`);
}

function readLocalSession(cwd: string, sessionId: string): Session {
  const path = statePath(cwd, sessionId);
  if (!existsSync(path)) {
    exitError({
      code: 'no_local_state',
      kind: 'not_found',
      message: `No local state.json for ${sessionId} at ${path}.`,
      received: sessionId,
    });
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as Session;
}

async function waitForBoxPaused(provider: Provider, remoteSessionDir: string): Promise<void> {
  const POLL_INTERVAL_MS = 2_000;
  const MAX_WAIT_MS = 30 * 60 * 1000;
  const start = Date.now();
  const cmd = `cat ${shellQuote(remoteSessionDir.replace(/^~\//, ''))}/state.json 2>/dev/null | head -c 200000`;
  while (Date.now() - start < MAX_WAIT_MS) {
    const r = runOnBox(provider, cmd);
    if (r.exitCode === 0 && r.stdout.trim()) {
      try {
        const s = JSON.parse(r.stdout) as Session;
        if (s.status === 'paused') return;
      } catch (err) {
        console.warn(`Could not parse box-side state.json yet: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  exitError({
    code: 'box_pause_timeout',
    kind: 'transient',
    message: 'Timed out waiting for box-side session to pause.',
  });
}

interface RsyncOpts { withDelete: boolean; excludeSisyphus?: boolean; update?: boolean }

function rsyncDown(target: string, remotePath: string, localPath: string, opts: RsyncOpts): Promise<void> {
  return new Promise((resolve, reject) => {
    const args: string[] = ['-avz'];
    if (opts.withDelete) args.push('--delete');
    if (opts.update) args.push('--update');
    if (opts.excludeSisyphus) args.push('--exclude=.sisyphus/');
    // Default excludes for working-tree pull (matches local→box direction).
    args.push('--exclude=.terraform/', '--exclude=node_modules/', '--exclude=dist/', '--exclude=.next/', '--exclude=.turbo/', '--exclude=coverage/', '--exclude=tmp/', '--exclude=.git/lfs/', '--exclude=.DS_Store');
    args.push('-e', 'ssh', `${target}:${remotePath}`, localPath);
    const child = spawn('rsync', args, { stdio: 'inherit', env: EXEC_ENV });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`rsync exited ${code} for ${remotePath}`));
    });
  });
}
