import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import { readStdin } from '../stdin.js';
import { assertTmux } from '../tmux.js';
import { exitError, exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerSpawn(program: Command): void {
  program
    .command('spawn')
    .description('Spawn a new agent (orchestrator only)')
    .option('--agent-type <type>', 'Agent type (e.g. sisyphus:debug, devcore:programmer)')
    .option('--name <name>', 'Agent name')
    .option('--stdin', 'Force-read instruction from stdin (avoids shell escaping for long prompts)')
    .option('--repo <name>', 'Repo subdirectory to use for this agent')
    .option('--session <sessionId>', 'Session ID (defaults to SISYPHUS_SESSION_ID env var)')
    .addHelpText(
      'after',
      `
agent spawn: spawn a worker agent. Returns immediately. Reads instruction from stdin.

Input
  stdin              required. Task instruction; treated as the agent's prompt.
                     Pipe content directly: \`cat task.md | sis agent spawn …\`.
  --stdin            optional boolean. Required when running interactively to
                     force-read stdin (mirrors \`sis session lifecycle start\`).
  --agent-type TYPE  required. Agent template (e.g. sisyphus:debug, devcore:programmer).
  --name NAME        required. Agent name. Must not start with \`/\`.
  --repo NAME        optional. Subdirectory under the session cwd to use.
  --session ID       optional. Defaults to $SISYPHUS_SESSION_ID.

Output (stdout, JSON)
  ok, data: { agentId, sessionId, agentType, name }

Effects
  Persists an agent record under the session. Spawns a tmux pane running Claude.
  Agent runs until it calls \`sis agent submit\` or is killed.

Exit codes: 0 ok | 2 usage | 3 not_found (unknown session) | 5 conflict.`,
    )
    .action(async (opts: { agentType?: string; name?: string; stdin?: boolean; repo?: string; session?: string }) => {
      if (!opts.agentType) {
        exitUsage('missing_agent_type', 'required option --agent-type <type> not specified', {
          expected: 'an agent type string, e.g. sisyphus:debug, devcore:programmer',
          next: 'pass --agent-type <type>',
        });
      }

      if (!opts.name) {
        exitUsage('missing_name', 'required option --name <name> not specified', {
          expected: 'a string',
          next: 'pass --name <agent-name>',
        });
      }

      assertTmux();
      const sessionId = opts.session ?? process.env.SISYPHUS_SESSION_ID;
      if (!sessionId) {
        exitUsage('missing_session_id', 'Provide --session or set SISYPHUS_SESSION_ID environment variable', {
          next: 'export SISYPHUS_SESSION_ID=<sessionId> or pass --session <sessionId>',
        });
      }

      let instruction: string | null | undefined;
      if (opts.stdin) {
        instruction = await readStdin({ force: true });
        if (!instruction) {
          exitUsage('empty_stdin', '--stdin set but no input received on stdin', {
            next: 'pipe content into the command: `cat prompt.md | sis agent spawn --stdin ...`',
          });
        }
      } else {
        instruction = await readStdin();
      }
      if (!instruction) {
        exitUsage('missing_instruction', 'instruction is required — pipe via stdin or use --stdin', {
          next: 'echo "<instruction>" | sis agent spawn --stdin --agent-type <type> --name <name>',
        });
      }
      if (instruction.trim().length < 20) {
        exitUsage('instruction_too_short', `instruction too short (${instruction.trim().length} chars). Did you mean to pipe via stdin?`, {
          received: instruction.trim(),
          expected: 'at least 20 characters of instruction',
          next: 'pipe content via stdin: echo "<instruction>" | sis agent spawn --stdin ...',
        });
      }

      const sisyphusCwd = process.env['SISYPHUS_CWD'] ?? process.cwd();

      if (opts.repo && (opts.repo.includes('/') || opts.repo.includes('..') || opts.repo.includes('\\'))) {
        exitUsage('repo_path_invalid', '--repo must be a directory name, not a path', {
          received: opts.repo,
          expected: 'a single directory name without "/" or ".."',
        });
      }

      if (opts.repo && opts.repo !== '.') {
        const repoPath = join(sisyphusCwd, opts.repo);
        if (!existsSync(repoPath)) {
          exitError({
            code: 'repo_not_found',
            kind: 'not_found',
            message: `repo directory does not exist: ${repoPath}`,
            received: opts.repo,
            next: `mkdir ${opts.repo} or pick a different --repo`,
          });
        }
      }

      let agentType = opts.agentType.trim();
      if (agentType.startsWith('/')) {
        agentType = agentType.slice(1);
        process.stderr.write('note: stripped leading "/" from --agent-type (agent types are identifiers, not slash commands)\n');
      }
      let agentName = opts.name.trim();
      if (agentName.startsWith('/')) {
        agentName = agentName.slice(1);
        process.stderr.write('note: stripped leading "/" from --name (agent types are identifiers, not slash commands)\n');
      }

      const request: Request = {
        type: 'spawn',
        sessionId,
        agentType,
        name: agentName,
        instruction,
        ...(opts.repo ? { repo: opts.repo } : {}),
      };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);
      const agentId = response.data?.agentId as string;
      emitJsonOk({ agentId, sessionId, agentType, name: agentName }); return;
    });
}
