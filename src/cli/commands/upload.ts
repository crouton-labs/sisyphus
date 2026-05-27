import type { Command } from 'commander';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import type { Session } from '../../shared/types.js';
import { loadConfig } from '../../shared/config.js';
import { exportSessionToZip } from '../../shared/session-export.js';
import { uploadSession, isUploadConfigured } from '../../shared/upload.js';
import { buildManifest } from '../../shared/manifest.js';
import { getSession } from '../../daemon/state.js';
import { getSisyphusVersion } from '../../shared/version.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerUpload(program: Command): void {
  program
    .command('upload')
    .description('Upload a session zip to the configured upload endpoint')
    .argument('[session-id]', 'Session ID (defaults to SISYPHUS_SESSION_ID or active session)')
    .option('--cwd <path>', 'Project directory override')
    .addHelpText(
      'after',
      `
upload: upload a completed session zip to the configured Cloudflare Worker endpoint.

Input
  [session-id]    optional — session to upload; defaults to SISYPHUS_SESSION_ID env var,
                  then active session for --cwd.
  --cwd <path>    project directory override (default: SISYPHUS_CWD env var or cwd).

Output (stdout, JSON envelope)
  { ok, data: { sessionId, storageKey } }

Effects
  Exports session to a temporary zip file, POSTs it to the configured upload URL,
  updates session upload status via the daemon, and deletes the temporary zip.
  Requires upload configured via \`sis admin report configure-upload\`.

Exit codes: 0 ok | 1 upload or export error | 2 usage`,
    )
    .action(async (sessionIdArg?: string, opts?: { cwd?: string }) => {
      let sessionId = sessionIdArg ?? process.env.SISYPHUS_SESSION_ID;
      const cwd = opts?.cwd ?? process.env['SISYPHUS_CWD'] ?? process.cwd();

      if (!sessionId) {
        const request: Request = { type: 'status', cwd };
        const response = await sendRequest(request);
        if (response.ok) {
          const session = response.data?.session as Session | undefined;
          if (session) {
            sessionId = session.id;
          }
        }
      }

      if (!sessionId) {
        exitUsage('missing_session_id', 'No session ID provided and no active session found.', {
          next: 'sis admin report upload <session-id>',
        });
      }

      const config = loadConfig(cwd);
      if (!isUploadConfigured(config.upload)) {
        exitError({
          code: 'upload_not_configured',
          kind: 'usage',
          message: "upload not configured.",
          next: "Run 'sis admin report configure-upload <url-with-token>' or set { upload: { url, token } } in .sisyphus/config.json.",
        });
      }

      let zipPath: string;
      try {
        zipPath = await exportSessionToZip(sessionId, cwd, { reveal: false, outputDir: tmpdir() });
      } catch (err) {
        exitError({
          code: 'export_failed',
          kind: 'permanent',
          message: (err as Error).message,
          received: sessionId,
        });
      }

      try {
        const session = getSession(cwd, sessionId);
        if (session.status !== 'completed') {
          console.warn(`warning: session ${sessionId} is not completed (status: ${session.status}); uploading anyway`);
        }

        const manifest = buildManifest({ session, status: 'completed', config, sisyphusVersion: getSisyphusVersion() });

        let result: Awaited<ReturnType<typeof uploadSession>>;
        try {
          result = await uploadSession({ config: config.upload, zipPath, manifest });
        } catch (err) {
          const errMsg = (err as Error).message;
          const persistReq: Request = {
            type: 'set-upload-status',
            sessionId,
            cwd,
            status: 'failed',
            error: errMsg,
          };
          try {
            await sendRequest(persistReq);
          } catch {
            // daemon unreachable — best-effort
          }
          exitError({
            code: 'upload_failed',
            kind: 'transient',
            message: `Upload failed: ${errMsg}`,
            received: sessionId,
          });
        }

        const persistReq: Request = {
          type: 'set-upload-status',
          sessionId,
          cwd,
          status: 'uploaded',
          storageKey: result!.storageKey,
        };
        try {
          const resp = await sendRequest(persistReq);
          if (!resp.ok) {
            const detail = typeof resp.error === 'string' ? resp.error : resp.error?.message ?? 'no error detail';
            console.warn(`warning: could not persist upload status (${detail})`);
          }
        } catch {
          console.warn('warning: daemon unreachable — upload status not persisted to session state');
        }

        emitJsonOk({ sessionId, storageKey: result!.storageKey }); return;
      } finally {
        rmSync(zipPath!, { force: true });
      }
    });
}
