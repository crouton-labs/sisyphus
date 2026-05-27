import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import type { Session } from '../../shared/types.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

const VALID_STATES = ['on', 'off', 'toggle'] as const;
type State = typeof VALID_STATES[number];

export function registerSessionDangerous(program: Command): void {
  program
    .command('dangerous [sessionId]')
    .description('Toggle dangerous mode (auto-accept first option for every ask)')
    .option('--state <state>', 'on|off|toggle', 'toggle')
    .addHelpText(
      'after',
      `
Input:
  [sessionId]    Session to modify (defaults to SISYPHUS_SESSION_ID).
  --state        on|off|toggle — desired dangerous-mode state (default: toggle).

Output (stdout, JSON)
  ok, data: { sessionId, enabled, flushed }

Effects:
  Sets dangerousMode on the session; flushes any pending asks if enabling.

Exit codes: 0 ok | 2 usage (bad state) | 3 not_found.`,
    )
    .action(async (sessionIdArg?: string, opts: { state: string } = { state: 'toggle' }) => {
      let sessionId: string;
      if (sessionIdArg) {
        sessionId = sessionIdArg;
      } else if (process.env.SISYPHUS_SESSION_ID) {
        sessionId = process.env.SISYPHUS_SESSION_ID;
      } else {
        exitUsage('missing_session_id', 'Provide <sessionId> or set SISYPHUS_SESSION_ID environment variable', {
          next: 'export SISYPHUS_SESSION_ID=<sessionId> or pass it as the first positional',
        });
      }

      const stateInput = opts.state.toLowerCase();
      if (!VALID_STATES.includes(stateInput as State)) {
        exitUsage('bad_state', `--state must be one of: ${VALID_STATES.join(', ')}`, {
          received: opts.state,
          expected: [...VALID_STATES],
        });
      }
      const state = stateInput as State;

      let enabled: boolean;
      if (state === 'toggle') {
        const cwd = process.env['SISYPHUS_CWD'] ? process.env['SISYPHUS_CWD'] : process.cwd();
        const statusResp = await sendRequest({ type: 'status', sessionId, cwd });
        if (!statusResp.ok) exitError(statusResp.error);
        const session = statusResp.data?.session as Session | undefined;
        if (!session) {
          exitError({
            code: 'unknown_session',
            kind: 'not_found',
            message: `session ${sessionId} not found`,
            received: sessionId,
            next: 'sis session inspect list --all',
          });
        }
        enabled = !session.dangerousMode;
      } else {
        enabled = state === 'on';
      }

      const request: Request = { type: 'set-dangerous-mode', sessionId, enabled };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      const flushedRaw = response.data?.flushed;
      const flushed = typeof flushedRaw === 'number' ? flushedRaw : 0;
      emitJsonOk({ sessionId, enabled, flushed }); return;
    });
}
