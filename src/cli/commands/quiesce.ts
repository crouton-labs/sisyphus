import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import { exitError } from '../errors.js';
import { emitJsonOk } from '../output.js';

/**
 * `sis session recover quiesce <session-id>`
 *
 * Stop a session at the next quiesce point (or immediately with --force) and
 * leave it paused — no cloud push. Used by `sis cloud handoff pull` on the box to
 * halt the box-side session before rsync-ing state back to local.
 */
export function registerQuiesce(parent: Command): void {
  parent
    .command('quiesce <session-id>')
    .description('Pause a session at the next quiesce point (or now with --force). No cloud push.')
    .option('--force', 'Interrupt running orchestrator/agents immediately.')
    .addHelpText(
      'after',
      `
Input
  <session-id>       required. Session to pause.
  --force            optional. Interrupt running orchestrator/agents immediately.

Output (stdout, JSON)
  ok, data: { sessionId, force, queued }

Effects
  Signals the session to halt at its next quiesce point, leaving it paused in place.
  With --force, interrupts immediately rather than waiting for the next safe point.
  Does not transport state — use \`sis cloud handoff pull\` to move state.

Exit codes: 0 ok | 3 not_found | 5 conflict (session on cloud — use reclaim).`,
    )
    .action(async (sessionId: string, opts: { force?: boolean }) => {
      const cwd = process.env['SISYPHUS_CWD'] ?? process.cwd();
      const request: Request = {
        type: 'admin-quiesce',
        sessionId,
        cwd,
        force: opts.force === true,
      };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      const data = response.data as { queued?: boolean; force?: boolean } | undefined;
      const force = data?.force === true;
      const queued = data?.queued === true;
      emitJsonOk({ sessionId, force, queued }); return;
    });
}
