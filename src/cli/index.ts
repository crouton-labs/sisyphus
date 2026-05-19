const nodeVersion = parseInt(process.versions.node.split('.')[0]!, 10);
if (nodeVersion < 22) {
  console.error(`Sisyphus requires Node.js v22+ (current: v${process.versions.node})`);
  process.exit(1);
}

// Native Windows is unsupported: the orchestration layer depends on tmux,
// bash, and POSIX sockets. WSL2 runs the Linux build with no changes.
if (process.platform === 'win32') {
  console.error(`Sisyphus does not run on native Windows (PowerShell / cmd.exe).

It depends on tmux, bash, and POSIX sockets — please run it inside WSL2:

  1. Install WSL2:  https://learn.microsoft.com/windows/wsl/install
  2. Open your WSL distro (Ubuntu is a safe default).
  3. Install Node.js v22+ and Claude Code inside WSL.
  4. Re-run \`sis\` from the WSL shell, not PowerShell.

Tip: enable systemd in /etc/wsl.conf for the recommended daemon setup.`);
  process.exit(1);
}

import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerStart } from './commands/start.js';
import { registerStatus } from './commands/status.js';
import { registerDashboard } from './commands/dashboard.js';
import { registerList } from './commands/list.js';
import { registerOrchTell, registerAgentTell } from './commands/tell.js';
import { registerOrchRead, registerAgentRead } from './commands/read.js';
import { registerMessage } from './commands/message.js';
import { registerAsk } from './commands/ask.js';
import { registerKill } from './commands/kill.js';
import { registerDelete } from './commands/delete.js';
import { registerResume } from './commands/resume.js';
import { registerContinue } from './commands/continue.js';
import { registerComplete } from './commands/complete.js';
import { registerRollback } from './commands/rollback.js';
import { registerReconnect } from './commands/reconnect.js';
import { registerClone } from './commands/clone.js';
import { registerSessionTask } from './commands/update-task.js';
import { registerSessionEffort } from './commands/set-effort.js';
import { registerSessionDangerous } from './commands/set-dangerous.js';
import { registerSessionContext } from './commands/print-context.js';
import { registerSpawn } from './commands/spawn.js';
import { registerAgentTypesList } from './commands/agent-types.js';
import { registerSubmit } from './commands/submit.js';
import { registerReport } from './commands/report.js';
import { registerAwait } from './commands/await.js';
import { registerAgentKill } from './commands/kill-agent.js';
import { registerAgentRestart } from './commands/restart-agent.js';
import { registerYield } from './commands/yield.js';
import { registerSegmentRegister } from './commands/register-segment.js';
import { registerSegmentUnregister } from './commands/unregister-segment.js';
import { registerSetup } from './commands/setup.js';
import { registerSetupKeybind } from './commands/setup-keybind.js';
import { registerCheckKeybinds } from './commands/check-keybinds.js';
import { registerCheckStatusbar } from './commands/check-statusbar.js';
import { registerHomeInit } from './commands/home-init.js';
import { registerQuiesce } from './commands/quiesce.js';
import { registerDoctor } from './commands/doctor.js';
import { registerBug } from './commands/bug.js';
import { registerInit } from './commands/init.js';
import { registerUninstall } from './commands/uninstall.js';
import { registerConfigureUpload } from './commands/configure-upload.js';
import { registerGettingStarted } from './commands/getting-started.js';
import { registerHistory } from './commands/history.js';
import { registerExport } from './commands/export.js';
import { registerUpload } from './commands/upload.js';
import { registerScratch } from './commands/scratch.js';
import { registerReview } from './commands/review.js';
import { registerCompanion } from './commands/companion.js';
import { registerCompanionProfile } from './commands/companion-profile.js';
import { registerDeploy } from './commands/deploy.js';
import { registerDeployList } from './commands/deploy-list.js';
import { registerCloud } from './commands/cloud.js';
import { attachNotify } from './commands/notify.js';
import { attachTmuxSessions } from './commands/tmux-sessions.js';
import { registerCleanZombies } from './commands/clean-zombies.js';
import { globalDir } from '../shared/paths.js';
import { subcommandRubric, CONCEPTS_BLOCK } from './help-rubric.js';
import { rawSend } from './client.js';

let sessionCounts: { active: number; paused: number; completed: number } | null = null;

const program = new Command();

program
  .name('sis')
  .description('tmux-integrated orchestration daemon for Claude Code')
  .helpOption('--help', 'print -h for any node or leaf')
  .version(
    JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8'),
    ).version,
    '--version',
    'output the version number',
  );

program.configureHelp({
  sortSubcommands: false,
  subcommandDescription: (cmd) => subcommandRubric(cmd),
});

program.addHelpText('before', CONCEPTS_BLOCK);

// Root-only ('after', not 'afterAll'): the full exit-code enum + JSON
// envelope is reference material that belongs on `sis -h`. Subcommands carry
// their own concise per-command exit-code line in their own addHelpText, so
// propagating this everywhere just duplicated ~18 lines onto every -h.
program.addHelpText('after', `
I/O contract: flags and positional args on input, JSON on stdout (JSONL for streams).

Exit codes:
  0   success
  1   permanent error (fallback)
  2   usage error (bad args/shape)
  3   not found
  4   ambiguous (multiple matches — see error.candidates)
  5   conflict (already-exists, wrong-state)
  60  transient (retry-safe: daemon down, timeout, lock contention)

Errors:
  {"ok": false, "schema_version": 1,
   "error": {"code": "<stable-enum>", "kind": "<usage|not_found|ambiguous|conflict|transient|permanent>",
             "message": "...", "received"?: ..., "expected"?: ..., "next"?: "...", "candidates"?: [...]}}
`);

// Pre-fetch session counts when rendering session help (250ms hard timeout, fail soft)
if (process.argv.includes('--help') && process.argv.some(a => a === 'session')) {
  try {
    const resp = await rawSend({ type: 'list', cwd: process.cwd(), all: true }, 250);
    if (resp.ok && Array.isArray((resp.data as { sessions?: unknown[] } | undefined)?.sessions)) {
      const sessions = (resp.data as { sessions: Array<{ status: string }> }).sessions;
      sessionCounts = { active: 0, paused: 0, completed: 0 };
      for (const s of sessions) {
        if (s.status === 'active') sessionCounts.active++;
        else if (s.status === 'paused') sessionCounts.paused++;
        else if (s.status === 'completed') sessionCounts.completed++;
      }
    }
  } catch { /* daemon down or timeout — omit Current: line */ }
}

// session group
const session = program
  .command('session')
  .description('Manage sessions')
  .addHelpText('before', () => {
    const base = '\nsession: tracked unit of work. lifecycle: start → discovery → planning → implementation → validation → complete. children: lifecycle, inspect, config, recover, scratch.\n';
    if (sessionCounts !== null) {
      return `${base}\nCurrent: ${sessionCounts.active} active, ${sessionCounts.paused} paused, ${sessionCounts.completed} completed.\n`;
    }
    return base;
  });

const sessLifecycle = session
  .command('lifecycle')
  .description('Start/stop/advance a session')
  .addHelpText('before', '\nsession lifecycle: change whether a session is running. start | continue | resume reopen work; complete | kill | delete close it.\n');
registerStart(sessLifecycle, program);
registerComplete(sessLifecycle);
registerContinue(sessLifecycle);
registerResume(sessLifecycle);
registerKill(sessLifecycle);
registerDelete(sessLifecycle);

const sessInspect = session
  .command('inspect')
  .description('Read session state')
  .addHelpText('before', '\nsession inspect: read session state. status (live), list (paginated catalog), history (past), context (orchestrator prompt), export (transcript), requirements (locked doc).\n');
registerStatus(sessInspect);
registerList(sessInspect);
registerHistory(sessInspect);
registerSessionContext(sessInspect);
registerExport(sessInspect);
registerReview(sessInspect);

const sessConfig = session
  .command('config')
  .description('Change session settings')
  .addHelpText('before', '\nsession config: mutate per-session settings. task (text), effort (low|medium|high|xhigh), dangerous (auto-accept asks).\n');
registerSessionTask(sessConfig);
registerSessionEffort(sessConfig);
registerSessionDangerous(sessConfig);

const sessRecover = session
  .command('recover')
  .description('Repair or relocate a session')
  .addHelpText('before', '\nsession recover: repair or relocate. rollback (cycle), reconnect (tmux), quiesce (pause), clone (fork goal).\n');
registerRollback(sessRecover);
registerReconnect(sessRecover);
registerQuiesce(sessRecover);
registerClone(sessRecover);

registerScratch(session);

// agent group
const agent = program
  .command('agent')
  .description('Manage agents')
  .addHelpText('before', '\nagent: worker agents spawned to execute scoped sub-tasks. spawn | submit | report | await for lifecycle. ctl, io, types for control, transcript I/O, catalog.\n');
registerSpawn(agent);
registerSubmit(agent);
registerReport(agent);
registerAwait(agent);

const agentCtl = agent
  .command('ctl')
  .description('Agent process control')
  .addHelpText('before', '\nagent ctl: agent process control. kill (stop now), restart (relaunch with same instruction).\n');
registerAgentKill(agentCtl);
registerAgentRestart(agentCtl);

const agentIo = agent
  .command('io')
  .description('Agent message I/O')
  .addHelpText('before', '\nagent io: agent message I/O. tell (inject), read (transcript).\n');
registerAgentTell(agentIo);
registerAgentRead(agentIo);

const agentTypes = agent
  .command('types')
  .description('Agent-type catalog')
  .addHelpText('before', '\nagent types: agent-type catalog. list (enumerate).\n');
registerAgentTypesList(agentTypes);

// orch group
const orch = program
  .command('orch')
  .description('Orchestrator commands')
  .addHelpText('before', '\norch: talk to / steer the orchestrator. yield (return control), tell (inject), message (queue), read (transcript).\n');
registerYield(orch);
registerOrchTell(orch);
registerMessage(orch);
registerOrchRead(orch);

// ask group (self-parenting; `registerAsk` adds subcommands internally)
registerAsk(program);

// ui group
const ui = program
  .command('ui')
  .description('Interactive surfaces (dashboard, guide)')
  .addHelpText('before', '\nui: interactive surfaces for humans. dashboard (TUI), guide (usage manual).\n');
registerDashboard(ui, program);
registerGettingStarted(ui, program);

// segment group
const segment = program
  .command('segment')
  .description('Status-line segments')
  .addHelpText('before', '\nsegment: tmux status-line segments. register (install), unregister (remove).\n');
registerSegmentRegister(segment);
registerSegmentUnregister(segment);

// admin group
const admin = program
  .command('admin')
  .description('Admin / setup commands')
  .addHelpText('before', '\nadmin: install, verify, report. install (setup), check (diagnostics), report (bug/upload), clean-zombies (garbage).\n');

const adminInstall = admin
  .command('install')
  .description('Install / uninstall')
  .addHelpText('before', '\nadmin install: install / uninstall. setup (full), setup-keybind (just the hotkey), init (per-repo), uninstall (remove).\n');
registerSetup(adminInstall);
registerSetupKeybind(adminInstall);
registerInit(adminInstall);
registerUninstall(adminInstall);

const adminCheck = admin
  .command('check')
  .description('Verify the installation')
  .addHelpText('before', '\nadmin check: verify the installation. doctor (general health), check-keybinds (tmux), check-statusbar (rendering).\n');
registerDoctor(adminCheck);
registerCheckKeybinds(adminCheck);
registerCheckStatusbar(adminCheck);

const adminReport = admin
  .command('report')
  .description('Diagnostics & telemetry')
  .addHelpText('before', '\nadmin report: diagnostics & telemetry. bug (file), upload (session), configure-upload (worker URL).\n');
registerBug(adminReport);
registerUpload(adminReport);
registerConfigureUpload(adminReport);

registerCleanZombies(admin);

// companion group
registerCompanion(program);
registerCompanionProfile(program.commands.find(c => c.name() === 'companion')!);

// deploy group (Terraform-wrapped cloud provisioning)
registerDeploy(program);
registerDeployList(program.commands.find(c => c.name() === 'deploy')!);

// cloud group (per-repo workflow on the deployed box)
registerCloud(program);

// diagnostic group (hidden)
const diagnostic = program.command('diagnostic', { hidden: true });
attachNotify(diagnostic);
attachTmuxSessions(diagnostic);
registerHomeInit(diagnostic);


// Show welcome on first run (before ~/.sisyphus exists)
const args = process.argv.slice(2);
const firstArg = args[0];
const skipWelcome = ['session', 'start', 'dashboard', 'agent', 'orch', 'ask', 'ui', 'segment', 'admin', 'help', '--help', '--version'];
if (!existsSync(globalDir()) && firstArg && !skipWelcome.includes(firstArg)) {
  mkdirSync(globalDir(), { recursive: true });
  console.log('');
  console.log("  Welcome to Sisyphus. Run 'sis admin install setup' to get started.");
  console.log('');
}

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
