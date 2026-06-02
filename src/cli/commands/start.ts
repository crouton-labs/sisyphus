import type { Command } from 'commander';
import { execSync } from 'node:child_process';
import { basename } from 'node:path';
import { sendRequest } from '../client.js';
import { readStdin } from '../stdin.js';
import { getCurrentTmuxSessionHome, getTmuxSessionInfo, isTmuxInstalled } from '../tmux.js';
import { shellQuote } from '../../shared/shell.js';
import type { Request } from '../../shared/protocol.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';


/**
 * Get or create a tmux session for the given cwd.
 * Returns the session name. Does NOT attach — caller decides.
 */
function ensureTmuxSessionExists(cwd: string): string {
  const sessionName = `sisyphus-${basename(cwd)}`;

  try {
    execSync(`tmux has-session -t ${shellQuote(sessionName)}`, { stdio: 'pipe' });
  } catch {
    execSync(
      `tmux new-session -d -s ${shellQuote(sessionName)} -c ${shellQuote(cwd)}`,
      { stdio: 'pipe' },
    );
  }

  return sessionName;
}


/**
 * Registers `<parent> start` (canonical, e.g. `sis session lifecycle start`) and,
 * when `root` is given, a hidden top-level `sis session lifecycle start` alias.
 */
export function registerStart(parent: Command, root?: Command): void {
  buildStartCommand(parent, false);
  if (root) buildStartCommand(root, true);
}

function buildStartCommand(target: Command, hidden: boolean): void {
  target
    .command('start', { hidden })
    .description('Start a new sisyphus session')
    .argument('[task]', 'Task description for the orchestrator (omit when using --stdin)')
    .option('-c, --context <context>', 'Background context for the orchestrator')
    .option('--name <name>', 'Human-readable name for the session')
    .option('--effort <tier>', 'Pipeline effort tier (low|medium|high|xhigh)')
    .option('--stdin', 'Read the task description from stdin (avoids shell escaping for long prompts)')
    .option('--context-stdin', 'Read the context from stdin (mutually exclusive with --stdin)')
    .option('--accept-cwd-mismatch', 'Proceed even when invocation cwd differs from the current tmux session\'s home (linking will be inconsistent)')
    .addHelpText('after', `
session lifecycle start: launch a new orchestrated sisyphus session.

Writing the handoff
  task          the goal — what to build or fix and what "done" looks like. This is the
                persistent objective the orchestrator re-reads every cycle; keep it focused.
  -c/--context  background that informs the work but isn't the goal itself: relevant file
                paths, constraints, specs, adjacent concerns, prior findings. Rendered
                apart from the task so the orchestrator references it without conflating it.
  Keep context factual, not diagnostic — point at files, areas, and constraints; don't
  speculate on root causes or fixes, which biases the orchestrator down the wrong path.

  Example
    sis start "Fix the JWT refresh bug — app shows a blank screen on token expiry instead of redirecting to login" -c "Auth system lives in src/auth/. Key files: interceptor.ts (HTTP interceptor), token-store.ts (token persistence), refresh.ts (refresh flow). Tests in src/auth/__tests__/. Don't break the logout flow."

  Long task or context? Pipe via stdin to avoid shell escaping:
    cat task.md | sis start --stdin -c "short context here"
    cat ctx.md  | sis start "short task" --context-stdin
  The same --stdin / --context-stdin pattern exists on \`agent spawn\`, \`orch message\`,
  \`orch tell\`, \`session resume\`, and agent-side \`agent submit\` / \`agent report\` / \`orch yield\`.

Input
  [task]                    optional positional — task description string; omit when using --stdin or pass \`-\` to read stdin
  -c, --context <context>   optional — background context injected alongside the task; also readable via --context-stdin
  --name <name>             optional — human-readable label for the session
  --effort <tier>           optional — pipeline effort tier: low | medium | high | xhigh
  --stdin                   optional — read task from stdin instead of positional; mutually exclusive with --context-stdin
  --context-stdin           optional — read context from stdin; mutually exclusive with --stdin
  --accept-cwd-mismatch     optional — bypass the tmux session home check when cwd intentionally differs

Output (stdout, JSON)
  { ok, data: { sessionId, tmuxSessionName? } }
  on error: { ok: false, error: { code, message } }

Effects
  Creates a new session record on the daemon.
  Tags the current tmux session with @sisyphus_cwd if not already set.
  Creates a tmux session for the project cwd when invoked outside tmux.

Exit codes: 0 ok | 2 usage | 1 runtime_error.`)
    .action(async (taskArg: string | undefined, opts: { context?: string; name?: string; effort?: string; stdin?: boolean; contextStdin?: boolean; acceptCwdMismatch?: boolean }) => {
      const cwd = process.env['SISYPHUS_CWD'] ?? process.cwd();

      if (opts.stdin && opts.contextStdin) {
        exitUsage('flag_conflict', '--stdin and --context-stdin cannot be combined; pipe one and pass the other on argv', {
          expected: 'exactly one of --stdin, --context-stdin',
        });
      }

      let task: string | undefined = taskArg;
      let context: string | undefined = opts.context;

      if (opts.stdin) {
        const piped = await readStdin({ force: true });
        if (!piped) {
          exitUsage('empty_stdin', '--stdin set but no input received on stdin', {
            next: 'pipe content: `cat task.md | sis session lifecycle start --stdin`',
          });
        }
        if (taskArg !== undefined && taskArg !== '-') {
          exitUsage('stdin_conflict', '--stdin conflicts with [task] positional; pass one or the other', {
            received: { stdin: true, task: taskArg },
          });
        }
        task = piped;
      } else if (taskArg === '-') {
        const piped = await readStdin({ force: true });
        if (!piped) {
          exitUsage('empty_stdin', "task '-' means read stdin, but no input received", {
            next: 'pipe content or omit `-`',
          });
        }
        task = piped;
      }

      if (opts.contextStdin) {
        const piped = await readStdin({ force: true });
        if (!piped) {
          exitUsage('empty_stdin', '--context-stdin set but no input received on stdin', {
            next: 'pipe content: `cat ctx.md | sis session lifecycle start "..." --context-stdin`',
          });
        }
        if (opts.context !== undefined) {
          exitUsage('flag_conflict', '--context-stdin conflicts with -c/--context; use one', {
            received: { contextStdin: true, context: opts.context },
          });
        }
        context = piped;
      }

      if (!task) {
        exitUsage('missing_task', 'provide <task> argument, pipe via --stdin, or pass `-` as the task', {
          next: 'sis session lifecycle start "your task" — or sis session lifecycle start - <task.md — or sis session lifecycle start --stdin <task.md',
        });
      }

      if (opts.effort !== undefined) {
        const validTiers = ['low', 'medium', 'high', 'xhigh'];
        if (!validTiers.includes(opts.effort)) {
          exitUsage('bad_effort', `--effort must be one of: ${validTiers.join(', ')}`, {
            received: opts.effort,
            expected: validTiers,
          });
        }
      }

      if (!isTmuxInstalled()) {
        exitError({
          code: 'tmux_missing',
          kind: 'permanent',
          message: 'tmux is not installed. Sisyphus requires tmux for agent panes.',
          next: 'brew install tmux (macOS) or apt install tmux (Linux)',
        });
      }

      // When inside an existing tmux session that's already homed at a different
      // project, refuse — the dashboard window would get pinned to this cwd but
      // live in a session tagged for the other project, poisoning C-s h, alt+s
      // cycle groups, scratch resolver, and dashboard re-attach. Usually caused
      // by `cd <subdir> && sis session lifecycle start` from an agent.
      if (process.env['TMUX'] && opts.acceptCwdMismatch !== true) {
        const info = getTmuxSessionInfo();
        const existingHome = getCurrentTmuxSessionHome(info.id);
        const normalizedCwd = cwd.replace(/\/+$/, '');
        if (existingHome && existingHome !== normalizedCwd) {
          exitError({
            code: 'cwd_mismatch',
            kind: 'conflict',
            message: `cwd mismatch with current tmux session. Session "${info.name}" is homed at: ${existingHome}; this invocation's cwd: ${normalizedCwd}. Running \`cd <dir> && sis session lifecycle start\` from inside a tmux session homed elsewhere breaks dashboard/session linking (C-s h, alt+s cycle, scratch resolver). Usually you want to operate in the parent project, not the cd'd subdir.`,
            received: { invocationCwd: normalizedCwd, tmuxSession: info.name, tmuxHome: existingHome },
            next: `Verify with the user: start a session for ${existingHome} or ${normalizedCwd}? To proceed anyway: sis session lifecycle start --accept-cwd-mismatch ...`,
          });
        }
      }

      // Send the start request — this is just a socket call, no tmux needed
      const effort = opts.effort as 'low' | 'medium' | 'high' | 'xhigh' | undefined;
      const request: Request = { type: 'start', task, context, cwd, name: opts.name, ...(effort !== undefined ? { effort } : {}) };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);

      const sessionId = response.data?.sessionId as string;
      const tmuxSessionName = response.data?.tmuxSessionName as string | undefined;

      // Determine which tmux session to use for cwd tagging.
      // If we're already in tmux, use the current session.
      // If not, create a dedicated session for this project.
      let tmuxSessionTarget: string;
      if (process.env['TMUX']) {
        const info = getTmuxSessionInfo();
        tmuxSessionTarget = info.id;
      } else {
        tmuxSessionTarget = ensureTmuxSessionExists(cwd);
      }

      // Tag the tmux session with the cwd — but don't clobber a tag that
      // already points to a different project. Overwriting would re-home an
      // existing session onto this project, poisoning alt+s cycle groups and
      // C-s h for the original project.
      // Target by $N id when available — tmux -t <name> can substring-match
      // the wrong session under sparse env.
      try {
        const normalizedCwd = cwd.replace(/\/+$/, '');
        let existing = '';
        try {
          existing = execSync(
            `tmux show-options -t ${shellQuote(tmuxSessionTarget)} -v @sisyphus_cwd`,
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
          ).trim();
        } catch {
          // option unset
        }
        if (!existing || existing === normalizedCwd) {
          execSync(
            `tmux set-option -t ${shellQuote(tmuxSessionTarget)} @sisyphus_cwd ${shellQuote(normalizedCwd)}`,
            { stdio: 'ignore' },
          );
        }
      } catch {
        // non-fatal: tagging failure doesn't block session start
      }

      emitJsonOk({ sessionId, ...(tmuxSessionName ? { tmuxSessionName } : {}) });
    });
}
