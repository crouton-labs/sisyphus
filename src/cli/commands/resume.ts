import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import { readStdin } from '../stdin.js';
import type { Request } from '../../shared/protocol.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerResume(program: Command): void {
  program
    .command('resume')
    .description('Respawn orchestrator with new instructions (for paused/completed sessions)')
    .argument('<session-id>', 'Session ID to resume')
    .option('--message <text>', 'Instructions for the orchestrator')
    .option('--stdin', 'Read message from stdin (avoids shell escaping for long prompts)')
    .addHelpText(
      'after',
      `
Input:
  <session-id>   Session to resume.
  --message      Instructions passed to the orchestrator on respawn.
  --stdin        Read instructions from stdin instead of --message.

Output (stdout, JSON)
  ok, schema_version: 1, data: { sessionId, tmuxSessionName? }

Effects:
  Respawns the orchestrator process; session history is preserved.

Exit codes: 0 ok | 2 usage | 3 not_found | 5 conflict (session already running).`,
    )
    .action(async (sessionId: string, opts: { message?: string; stdin?: boolean }) => {
      const cwd = process.env['SISYPHUS_CWD'] ?? process.cwd();

      let message: string | undefined = opts.message;
      if (opts.stdin) {
        const piped = await readStdin({ force: true });
        if (!piped) {
          exitUsage('empty_stdin', '--stdin set but no input received on stdin', {
            next: 'pipe content: `echo "..." | sis session lifecycle resume <id> --stdin`',
          });
        }
        if (opts.message !== undefined) {
          exitUsage('stdin_conflict', '--stdin conflicts with --message; pass one source', {
            received: { stdin: true, message: opts.message },
          });
        }
        message = piped;
      }

      const request: Request = { type: 'resume', sessionId, cwd, message };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      const tmuxSessionName = response.data?.tmuxSessionName as string | undefined;
      emitJsonOk({ sessionId, ...(tmuxSessionName ? { tmuxSessionName } : {}) }); return;
    });
}
