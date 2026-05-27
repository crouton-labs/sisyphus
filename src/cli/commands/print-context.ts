import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import type { Session } from '../../shared/types.js';
import { buildSessionContext } from '../../tui/lib/context.js';
import { exitError } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerSessionContext(program: Command): void {
  program
    .command('context <sessionId>')
    .description('Print session context XML (same as dashboard space y C)')
    .option('--cwd <path>', 'Working directory of the session', process.cwd())
    .addHelpText(
      'after',
      `
Input
  <sessionId>        required — session to inspect.
  --cwd <path>       optional — working directory of the session; defaults to process cwd.

Output (stdout, JSON)
  ok, data: { sessionId, context }

Effects
  None. Read-only.

Exit codes: 0 ok | 3 not_found (unknown session).`,
    )
    .action(async (sessionId: string, opts: { cwd: string }) => {
      const request: Request = { type: 'status', sessionId, cwd: opts.cwd };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      const session = response.data?.session as Session | undefined;
      if (!session) {
        exitError({
          code: 'unknown_session',
          kind: 'not_found',
          message: 'Session not found',
          received: sessionId,
          next: 'sis session inspect list --all',
        });
      }
      const context = buildSessionContext(session, opts.cwd);
      emitJsonOk({ sessionId, context }); return;
    });
}
