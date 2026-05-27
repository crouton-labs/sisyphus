import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import type { Session } from '../../shared/types.js';
import { exportSessionToZip } from '../../shared/session-export.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

export { exportSessionToZip };

export function registerExport(program: Command): void {
  program
    .command('export')
    .description('Export session data as zip to ~/Downloads')
    .argument('[session-id]', 'Session ID (defaults to SISYPHUS_SESSION_ID or active session)')
    .option('--cwd <path>', 'Project directory override')
    .addHelpText('after', `
session inspect export: package a session's state and artifacts into a zip archive.

Input
  [session-id]    optional — session ID to export; defaults to $SISYPHUS_SESSION_ID then the active session for cwd
  --cwd <path>    optional — project directory used to resolve the active session; defaults to $SISYPHUS_CWD then process cwd

Output (stdout, JSON)
  { ok, data: { sessionId, outputPath } }
  outputPath is the absolute path of the written zip file (typically ~/Downloads/<sessionId>.zip).
  on error: { ok: false, error: { code, message } }

Effects
  Writes a zip archive to ~/Downloads.

Exit codes: 0 ok | 2 usage | 1 export_failed.`)
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
          next: 'sis session inspect export <session-id>',
        });
      }

      try {
        const outputPath = await exportSessionToZip(sessionId, cwd);
        emitJsonOk({ sessionId, outputPath }); return;
      } catch (err) {
        exitError({
          code: 'export_failed',
          kind: 'permanent',
          message: (err as Error).message,
          received: sessionId,
        });
      }
    });
}
