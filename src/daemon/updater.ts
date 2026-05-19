import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { get } from 'node:https';
import { daemonUpdatingPath } from '../shared/paths.js';
import { getSisyphusVersion } from '../shared/version.js';

export function isNewer(latest: string, current: string): boolean {
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

export function getCurrentVersion(): string {
  return getSisyphusVersion();
}

export function checkForUpdate(): Promise<{ current: string; latest: string } | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.error('[sisyphus] Update check timed out (5s)');
      resolve(null);
    }, 5000);

    const req = get('https://registry.npmjs.org/sisyphi/latest', (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const { version: latest } = JSON.parse(data) as { version: string };
          if (latest && isNewer(latest, getSisyphusVersion())) {
            resolve({ current: getSisyphusVersion(), latest });
          } else {
            resolve(null);
          }
        } catch (err) {
          console.error('[sisyphus] Failed to parse registry response:', err);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[sisyphus] Update check failed:', err.message);
      resolve(null);
    });
  });
}

export function applyUpdate(expectedVersion: string): boolean {
  try {
    // launchd gives a minimal PATH — ensure node/npm directory is on PATH
    const nodeDir = resolve(process.execPath, '..');
    const env = { ...process.env, PATH: `${nodeDir}:${process.env.PATH ?? ''}` };
    execSync('npm install -g sisyphi', { timeout: 15000, stdio: 'pipe', env });

    // Verify the install actually landed the expected version
    const result = execSync('npm ls -g sisyphi --json --depth=0', {
      timeout: 5000, encoding: 'utf-8', env,
    });
    const info = JSON.parse(result) as { dependencies?: { sisyphi?: { version?: string } } };
    const installed = info.dependencies?.sisyphi?.version;
    if (installed !== expectedVersion) {
      console.error(`[sisyphus] Update installed ${installed} but expected ${expectedVersion}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[sisyphus] Auto-update failed:', err);
    return false;
  }
}

function markUpdating(version: string): void {
  try { writeFileSync(daemonUpdatingPath(), version, 'utf-8'); } catch {}
}

function clearUpdating(): void {
  try { unlinkSync(daemonUpdatingPath()); } catch {}
}

function isLinkedInstall(): boolean {
  // If the global node_modules entry is a symlink, we're locally linked for development — skip auto-update
  try {
    const nodeDir = resolve(process.execPath, '..');
    const globalPrefix = execSync('npm prefix -g', { timeout: 5000, encoding: 'utf-8', env: { ...process.env, PATH: `${nodeDir}:${process.env.PATH ?? ''}` } }).trim();
    const globalPkgDir = resolve(globalPrefix, 'lib', 'node_modules', 'sisyphi');
    return lstatSync(globalPkgDir).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function checkAndApply(): Promise<void> {
  clearUpdating(); // clean up stale marker from previous run
  if (isLinkedInstall()) return;
  try {
    const update = await checkForUpdate();
    if (!update) return;

    console.log(`[sisyphus] Update available: ${update.current} → ${update.latest}`);
    markUpdating(update.latest);
    const success = applyUpdate(update.latest);
    if (success) {
      console.log(`[sisyphus] Updated to ${update.latest}, restarting daemon...`);
      process.exit(0); // launchd respawns with new code
    }
    clearUpdating();
  } catch (err) {
    clearUpdating();
    console.error('[sisyphus] Auto-update check failed:', err);
  }
}

const UPDATE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
let updateTimer: ReturnType<typeof setInterval> | null = null;

export function startPeriodicUpdateCheck(): void {
  if (isLinkedInstall()) return;
  updateTimer = setInterval(() => {
    void checkAndApply();
  }, UPDATE_INTERVAL_MS);
  updateTimer.unref(); // don't keep the process alive just for update checks
}

export function stopPeriodicUpdateCheck(): void {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
}
