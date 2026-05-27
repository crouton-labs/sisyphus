import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import { readStdin } from '../stdin.js';
import { assertTmux } from '../tmux.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerYield(program: Command): void {
  program
    .command('yield')
    .description('Yield control back to daemon (orchestrator only)')
    .option('--prompt <text>', 'Short orienting nudge for the next cycle (or pipe via stdin) — name what just happened; leave tactical decisions to the fresh read of the reports')
    .option('--stdin', 'Force-read prompt from stdin (avoids shell escaping for long prompts)')
    .requiredOption('--mode <mode>', 'System prompt mode for next cycle (discovery, planning, implementation, validation, completion). Required — pass the current mode to stay in it.')
    .option('--session <sessionId>', 'Session ID (defaults to SISYPHUS_SESSION_ID env var)')
    .addHelpText(
      'after',
      `
orch yield: hand control back to the daemon; orchestrator exits and respawns on the next cycle.

Input
  --mode <mode>      required. Cycle mode for next spawn: discovery, planning, implementation,
                     validation, completion. Pass current mode to stay in phase; pass a
                     different mode to transition. No implicit keep-current.
  --prompt <text>    optional. Orienting nudge for the next cycle; or pipe via stdin.
  --stdin            optional. Force-read prompt from stdin (avoids shell escaping).
  --session <id>     optional. Defaults to $SISYPHUS_SESSION_ID.
  stdin              optional. Piped input used as prompt when --prompt is omitted.

Output (stdout, JSON)
  ok, data: { sessionId, mode }

Effects
  Kills the current orchestrator process; daemon blocks until all running agents submit, then
  respawns orchestrator with --mode applied. Never yield while waiting for user input — the
  respawned instance has no conversation memory and will loop.

Exit codes: 0 ok | 2 usage (missing --mode or --session) | 3 not_found.`,
    )
    .action(async (opts: { prompt?: string; stdin?: boolean; mode?: string; session?: string }) => {
      assertTmux();
      const sessionId = opts.session ?? process.env.SISYPHUS_SESSION_ID;
      if (!sessionId) {
        exitUsage('missing_session_id', 'Provide --session or set SISYPHUS_SESSION_ID environment variable', {
          next: 'export SISYPHUS_SESSION_ID=<sessionId> or pass --session <sessionId>',
        });
      }

      let nextPrompt: string | undefined;
      if (opts.stdin) {
        const piped = await readStdin({ force: true });
        if (!piped) {
          exitUsage('empty_stdin', '--stdin set but no input received on stdin', {
            next: 'pipe content: `echo "..." | sis orch yield --stdin --mode <mode>`',
          });
        }
        if (opts.prompt) {
          exitUsage('stdin_conflict', '--stdin conflicts with --prompt; pass one source', {
            received: { stdin: true, prompt: opts.prompt },
          });
        }
        nextPrompt = piped;
      } else {
        nextPrompt = opts.prompt ?? await readStdin() ?? undefined;
      }

      const request: Request = { type: 'yield', sessionId, agentId: 'orchestrator', nextPrompt, mode: opts.mode };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      emitJsonOk({ sessionId, mode: opts.mode }); return;
    });
}
