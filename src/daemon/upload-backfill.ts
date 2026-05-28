import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { historyBaseDir, historySessionSummaryPath, statePath } from '../shared/paths.js';
import { loadConfig } from '../shared/config.js';
import { isUploadConfigured } from '../shared/upload.js';
import { getSisyphusVersion } from '../shared/version.js';
import type { SessionSummary } from '../shared/history-types.js';
import type { Session } from '../shared/types.js';
import * as state from './state.js';
import { runSessionUploadAndPersist } from './uploader.js';

/**
 * One-shot backfill: on daemon start, upload every completed session that was
 * never successfully uploaded. Catches sessions that completed while upload was
 * unconfigured, the daemon was down, or a prior upload failed.
 *
 * Dedup is twofold and makes re-runs safe:
 *   1. Local — skip any session whose state.json already has uploadStatus
 *      'uploaded'. runSessionUploadAndPersist persists that on success, so the
 *      next daemon start skips it.
 *   2. Remote — the Worker keys objects at users/{userId}/{sessionId}.{zip,json},
 *      deterministic per session. A re-upload overwrites in place; it can never
 *      create a duplicate object (worst case is a redundant write + token counter
 *      bump, never a dup).
 *
 * Nonblocking: callers invoke this as `void backfillUploads()` off the startup
 * critical path. Sessions are processed strictly sequentially (one zip + one
 * POST in flight at a time) so it never spikes memory/network, and every step
 * awaits async I/O so the daemon event loop stays responsive throughout.
 */
let backfillStarted = false;

export async function backfillUploads(): Promise<void> {
  if (backfillStarted) return; // idempotent within a process
  backfillStarted = true;

  try {
    // Upload credentials live only in the global config; loadConfig merges them in.
    const config = loadConfig(process.cwd());
    if (!isUploadConfigured(config.upload)) return; // user hasn't opted into uploads

    // The global history index is the cross-project enumerator: one dir per
    // session, each with a session.json summary carrying its cwd + status.
    const base = historyBaseDir();
    let dirs: string[];
    try {
      dirs = readdirSync(base);
    } catch {
      return; // no history yet
    }

    type Candidate = { sessionId: string; cwd: string; startedAt: number };
    const candidates: Candidate[] = [];
    for (const sessionId of dirs) {
      let summary: SessionSummary;
      try {
        summary = JSON.parse(readFileSync(historySessionSummaryPath(sessionId), 'utf-8')) as SessionSummary;
      } catch {
        continue; // events-only dir or unreadable summary — nothing to upload
      }
      if (summary.status !== 'completed' || !summary.cwd) continue;
      candidates.push({ sessionId, cwd: summary.cwd, startedAt: new Date(summary.startedAt ?? 0).getTime() });
    }

    // Newest first — most relevant sessions backfill before older ones.
    candidates.sort((a, b) => b.startedAt - a.startedAt);

    const sisyphusVersion = getSisyphusVersion();
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;
    let unexportable = 0;

    for (const { sessionId, cwd } of candidates) {
      // state.json is both the upload-status source of truth and the export
      // source; if it's gone the session can't be rebuilt, so skip it.
      if (!existsSync(statePath(cwd, sessionId))) {
        unexportable++;
        continue;
      }

      let session: Session;
      try {
        session = state.getSession(cwd, sessionId);
      } catch {
        unexportable++;
        continue;
      }

      // Authoritative gate on live state: skip already-uploaded (dedup) and any
      // session that was continued back to active/paused since the summary.
      if (session.status !== 'completed') continue;
      if (session.uploadStatus === 'uploaded') {
        skipped++;
        continue;
      }

      // Sequential await — one upload in flight at a time. runSessionUploadAndPersist
      // swallows upload errors and persists uploadStatus itself; re-read to classify.
      try {
        await runSessionUploadAndPersist({
          sessionId,
          cwd,
          fullConfig: loadConfig(cwd),
          session,
          status: 'completed',
          sisyphusVersion,
        });
        const after = state.getSession(cwd, sessionId);
        if (after.uploadStatus === 'uploaded') uploaded++;
        else failed++;
      } catch {
        failed++; // error already persisted to state.uploadError
      }
    }

    // Only log when something actually happened — a steady-state restart (all
    // already uploaded, only un-exportable leftovers) stays quiet.
    if (uploaded || failed) {
      console.log(
        `[sisyphus] upload backfill: ${uploaded} uploaded, ${skipped} already up, ` +
          `${failed} failed, ${unexportable} unexportable (of ${candidates.length} completed)`,
      );
    }
  } catch (err) {
    console.warn('[sisyphus] upload backfill aborted:', err instanceof Error ? err.message : err);
  }
}
