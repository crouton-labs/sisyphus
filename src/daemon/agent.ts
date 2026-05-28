import { readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve, relative, dirname, join } from 'node:path';
import type { Agent, AgentReport } from '../shared/types.js';
import * as state from './state.js';
import * as tmux from './tmux.js';
import { getNextColor, normalizeTmuxColor } from './colors.js';
import { getWindowId } from './orchestrator.js';
import { contextDir, promptsDir, reportsDir, reportFilePath, sessionDir } from '../shared/paths.js';
import { injectHelp } from './help-inject.js';
import { registerPane, unregisterPane, unregisterAgentPane } from './pane-registry.js';
import { flushAgentTimer } from './pane-monitor.js';
import { summarizeReport } from './summarize.js';
import { resolveAgentConfig, detectProvider } from './frontmatter.js';
import type { Provider } from './frontmatter.js';
import { loadConfig } from '../shared/config.js';
import { execEnv } from '../shared/env.js';
import { shellQuote } from '../shared/shell.js';
import { resolveCliBin, resolveNpmBinDir, resolveBannerCmd, buildEnvExports, buildNotifyCmd, writeRunScript } from './spawn-helpers.js';
import { resolveRequiredPluginDirs, resolveAgentPluginDirs } from './plugins.js';
import { digestSpinnerVerbs } from '../shared/digest-verbs.js';
import { emitHistoryEvent } from './history.js';
import { emitOrphanAsk, markAgentAsksOrphan, resolveAgentOrphanAsks } from './orphan-asks.js';
import { capturePanePidLstart } from './orphan-sweep.js';
import { renderEffortMarkers } from './lib/effort-render.js';
import {
  agentPluginLayers,
  mergeHookManifests,
  copyLayered,
  collectReferencedHookScripts,
  collectDisabledHookScripts,
  copySkill,
} from './extensions.js';

const agentCounters = new Map<string, number>();

export function resetAgentCounter(sessionId: string, value: number = 0): void {
  agentCounters.set(sessionId, value);
}

export function resetAgentCounterFromState(sessionId: string, agents: { id: string }[]): void {
  let max = 0;
  for (const a of agents) {
    const match = a.id.match(/^agent-(\d+)$/);
    if (match) max = Math.max(max, parseInt(match[1]!, 10));
  }
  agentCounters.set(sessionId, max);
}

export function clearAgentCounter(sessionId: string): void {
  agentCounters.delete(sessionId);
}

// Substitute $SISYPHUS_* literals in template text at plugin-creation / pane-setup time.
// Applied to sub-agent file bodies and to parent agent/codex system prompts — the runtime
// shell also exports these as real env vars, but substitution here means the LLM sees
// concrete values in its prompt rather than the variable name.
function substituteSisyphusVars(text: string, sessionId: string, agentId: string, sesDir: string): string {
  return text
    .replace(/\$SISYPHUS_SESSION_DIR/g, sesDir)
    .replace(/\$SISYPHUS_SESSION_ID/g, sessionId)
    .replace(/\$SISYPHUS_AGENT_ID/g, agentId);
}

function renderAgentSuffix(sessionId: string, instruction: string, contextDirRel: string): string {
  const templatePath = resolve(import.meta.dirname, '../templates/agent-suffix.md');
  let template: string;
  try {
    template = readFileSync(templatePath, 'utf-8');
  } catch {
    template = `# Sisyphus Agent\nSession: {{SESSION_ID}}\nTask: {{INSTRUCTION}}`;
  }

  return injectHelp(
    template
      .replace(/\{\{SESSION_ID\}\}/g, sessionId)
      .replace(/\{\{INSTRUCTION\}\}/g, instruction)
      .replace(/\{\{CONTEXT_DIR\}\}/g, contextDirRel)
  );
}

function createAgentPlugin(
  cwd: string,
  sessionId: string,
  agentId: string,
  agentType: string,
  agentConfig: ReturnType<typeof resolveAgentConfig>,
): string {
  const base = `${promptsDir(cwd, sessionId)}/${agentId}-plugin`;
  mkdirSync(`${base}/.claude-plugin`, { recursive: true });
  mkdirSync(`${base}/agents`, { recursive: true });
  mkdirSync(`${base}/hooks`, { recursive: true });
  mkdirSync(`${base}/skills`, { recursive: true });

  writeFileSync(
    `${base}/.claude-plugin/plugin.json`,
    JSON.stringify({ name: `sisyphus-agent-${agentId}`, version: '1.0.0' }),
    'utf-8',
  );

  const sesDir = sessionDir(cwd, sessionId);
  const substituteEnvVars = (text: string) => substituteSisyphusVars(text, sessionId, agentId, sesDir);

  if (agentConfig?.filePath && agentType && agentType !== 'worker') {
    const shortName = agentType.replace(/^sisyphus:/, '');

    // Copy sub-agent definitions if a subdirectory exists next to the resolved
    // agent .md. The parent agent's own .md is NOT copied — it would make the
    // parent visible as a Task-tool subagent inside its own pane, enabling
    // self-dispatch. The main session receives the body via --append-system-prompt.
    const subAgentDir = join(dirname(agentConfig.filePath), shortName);
    if (existsSync(subAgentDir)) {
      for (const f of readdirSync(subAgentDir)) {
        if (f.endsWith('.md') && f !== 'CLAUDE.md') {
          writeFileSync(`${base}/agents/${f}`, substituteEnvVars(readFileSync(join(subAgentDir, f), 'utf-8')), 'utf-8');
        }
      }
    }
  }

  // ── Layered hook composition ────────────────────────────────────────────────
  // Walk project (.sisyphus/agent-plugin) > user (~/.sisyphus/agent-plugin) > bundled
  // (templates/agent-plugin) and merge hooks.json manifests, copy hook scripts,
  // and inject any skills the agent's frontmatter opts into.
  const layers = agentPluginLayers(cwd);
  const normalizedType = agentType?.replace(/^sisyphus:/, '') ?? '';
  const filterCtx = {
    agentType: normalizedType,
    interactive: agentConfig?.frontmatter.interactive === true,
  };

  const referenced = collectReferencedHookScripts(layers, filterCtx);
  const disabled = collectDisabledHookScripts(layers);
  // Suppress disabled scripts even if a layer ships the file on disk, and
  // skip scripts that no surviving manifest entry references (avoids leaking
  // bundled scripts that only applied to other agent types).
  const skipFiles = new Set<string>(disabled);
  copyLayered(layers, {
    subdir: 'hooks',
    destDir: `${base}/hooks`,
    filter: (name) => name !== 'CLAUDE.md' && name !== 'hooks.json' && (referenced.has(name) || !name.endsWith('.sh')),
    skipFiles,
  });

  const mergedHooks = mergeHookManifests(layers, filterCtx);
  writeFileSync(`${base}/hooks/hooks.json`, JSON.stringify({ hooks: mergedHooks }, null, 2), 'utf-8');

  // ── Skill injection ─────────────────────────────────────────────────────────
  // Skills are opt-in via the agent's `skills:` frontmatter list. Each name
  // resolves across layers (project > user > bundled). Missing skills warn but
  // do not fail spawn — the agent body may reference them best-effort.
  const requestedSkills = agentConfig?.frontmatter.skills ?? [];
  for (const skillName of requestedSkills) {
    const ok = copySkill(layers, skillName, `${base}/skills`);
    if (!ok) {
      console.warn(`[sisyphus] Agent ${agentId} (${normalizedType}) requested skill '${skillName}' but no layer provides it.`);
    }
  }

  return base;
}

interface SetupAgentPaneOpts {
  sessionId: string;
  sessionName?: string;
  cycleNum: number;
  cwd: string;
  agentId: string;
  agentType: string;
  name: string;
  instruction: string;
  windowId: string;
  color: string;
  provider: Provider;
  agentConfig: ReturnType<typeof resolveAgentConfig>;
  paneCwd: string;
  claudeSessionId?: string;
}

function setupAgentPane(opts: SetupAgentPaneOpts): { paneId: string; fullCmd: string; resumeEnv: string; resumeArgs?: string } {
  const { sessionId, cycleNum, cwd, agentId, agentType, name, instruction, windowId, color, provider, agentConfig, paneCwd, claudeSessionId } = opts;

  const paneId = tmux.createPane(windowId, paneCwd);
  registerPane(paneId, sessionId, 'agent', agentId);
  const shortType = agentType && agentType !== 'worker'
    ? agentType.replace(/^sisyphus:/, '')
    : '';
  const paneLabel = shortType ? `${name}-${shortType}` : name;
  const sessionLabel = opts.sessionName ?? sessionId.slice(0, 8);
  const agentTitle = `ssph:${sessionLabel} ${paneLabel} c${cycleNum}`;
  tmux.setPaneTitle(paneId, agentTitle);
  tmux.setPaneStyle(paneId, color, { role: paneLabel, session: sessionLabel, cycle: `c${cycleNum}` });

  const ctxDirRel = relative(paneCwd, contextDir(cwd, sessionId));
  if (agentType === 'plan') {
    mkdirSync(join(contextDir(cwd, sessionId), agentId), { recursive: true });
  }
  const sesDir = sessionDir(cwd, sessionId);
  const substitute = (text: string) => substituteSisyphusVars(text, sessionId, agentId, sesDir);
  const suffix = renderAgentSuffix(sessionId, instruction, ctxDirRel);

  // Resolve prompt effort tier. agentConfig.frontmatter.effort is the Claude Code --effort
  // thinking flag (low|medium|high|xhigh|max); re-using it as the prompt-tier override is
  // intentional per spec Design Principle 1 (no new frontmatter fields). Unrecognized values
  // (e.g. 'max') render as 'high' (fail open).
  const session = state.getSession(cwd, sessionId);
  const frontmatterEffort = agentConfig?.frontmatter.effort;
  const promptTier = frontmatterEffort != null ? frontmatterEffort : (session.effort != null ? session.effort : 'high');

  // For typed agents, prepend the agent type body to the system prompt.
  // --agent doesn't resolve from --plugin-dir, so we deliver it via --append-system-prompt.
  const systemParts: string[] = [];
  if (agentConfig?.body && agentType && agentType !== 'worker') {
    systemParts.push(renderEffortMarkers(substitute(agentConfig.body), promptTier));
  }
  systemParts.push(suffix);
  const suffixFilePath = `${promptsDir(cwd, sessionId)}/${agentId}-system.md`;
  writeFileSync(suffixFilePath, systemParts.join('\n\n'), 'utf-8');

  const bannerCmd = resolveBannerCmd();
  const npmBinDir = resolveNpmBinDir();

  const envExports = buildEnvExports([
    `export SISYPHUS_SESSION_ID=${shellQuote(sessionId)}`,
    `export SISYPHUS_AGENT_ID=${shellQuote(agentId)}`,
    `export SISYPHUS_CWD=${shellQuote(cwd)}`,
    `export SISYPHUS_SESSION_DIR=${shellQuote(sesDir)}`,
    `export PATH="${npmBinDir}:$PATH"`,
  ]);

  const notifyCmd = buildNotifyCmd(paneId);

  let mainCmd: string;
  let resumeArgs: string | undefined;

  if (provider === 'openai') {
    const codexPromptPath = `${promptsDir(cwd, sessionId)}/${agentId}-codex-prompt.md`;
    const parts: string[] = [];
    if (agentConfig?.body) parts.push(renderEffortMarkers(substitute(agentConfig.body), promptTier));
    parts.push(suffix);
    parts.push(`## Task\n\n${instruction}`);
    writeFileSync(codexPromptPath, parts.join('\n\n'), 'utf-8');
    const model = agentConfig?.frontmatter.model ?? 'codex-mini';
    mainCmd = `codex -m ${shellQuote(model)} --dangerously-bypass-approvals-and-sandbox "$(cat '${codexPromptPath}')"`;
  } else {
    const config = loadConfig(cwd);
    const effort = agentConfig?.frontmatter.effort ?? config.agentEffort ?? 'high';
    const rawModel = agentConfig?.frontmatter.model;
    // Map the `opus` alias to the 1M-context variant so plan/review/debug agents
    // don't hit auto-compact at ~160K. Other aliases pass through unchanged.
    const model = rawModel === 'opus' ? 'claude-opus-4-8[1m]' : rawModel;
    const modelFlag = model ? ` --model ${shellQuote(model)}` : '';
    const permMode = agentConfig?.frontmatter.permissionMode;
    const permFlag = permMode ? ` --permission-mode ${shellQuote(permMode)}` : ' --dangerously-skip-permissions';
    const pluginPath = createAgentPlugin(cwd, sessionId, agentId, agentType, agentConfig);
    const requiredPluginDirs = resolveRequiredPluginDirs(cwd);
    const agentPluginDirs = resolveAgentPluginDirs(agentConfig?.frontmatter.plugins);
    const allExtraPluginDirs = [...requiredPluginDirs, ...agentPluginDirs];
    const extraPluginFlags = allExtraPluginDirs.map(p => `--plugin-dir "${p}"`).join(' ');
    const sessionIdFlag = claudeSessionId ? ` --session-id "${claudeSessionId}"` : '';
    const promptFlag = agentConfig?.frontmatter.systemPrompt === 'replace' ? '--system-prompt' : '--append-system-prompt';
    const siblingSettingsPath = agentConfig?.filePath ? agentConfig.filePath.replace(/\.md$/, '.settings.json') : null;
    const hasSibling = !!siblingSettingsPath && existsSync(siblingSettingsPath);
    const agentDigestVerbs = digestSpinnerVerbs(cwd, sessionId);
    let resolvedSettingsPath: string | null = hasSibling ? siblingSettingsPath : null;
    if (agentDigestVerbs) {
      let base: Record<string, unknown> = {};
      if (hasSibling) {
        try {
          base = JSON.parse(readFileSync(siblingSettingsPath!, 'utf-8')) as Record<string, unknown>;
        } catch {
          base = {};
        }
      }
      base.spinnerVerbs = { mode: 'replace', verbs: agentDigestVerbs };
      const mergedSettingsOut = join(promptsDir(cwd, sessionId), `${agentId}-settings.merged.json`);
      writeFileSync(mergedSettingsOut, JSON.stringify(base, null, 2), 'utf-8');
      resolvedSettingsPath = mergedSettingsOut;
    }
    const settingsFlag = resolvedSettingsPath ? ` --settings "${resolvedSettingsPath}"` : '';
    mainCmd = `claude${permFlag} --effort ${effort}${modelFlag} --plugin-dir "${pluginPath}"${sessionIdFlag}${extraPluginFlags ? ` ${extraPluginFlags}` : ''}${settingsFlag} --name ${shellQuote(agentTitle)} ${promptFlag} "$(cat '${suffixFilePath}')" ${shellQuote(instruction)}`;
    resumeArgs = `${permFlag.trimStart()} --effort ${effort}${modelFlag} --plugin-dir "${pluginPath}"${extraPluginFlags ? ` ${extraPluginFlags}` : ''}${settingsFlag}`;
  }

  const scriptPath = writeRunScript(promptsDir(cwd, sessionId), `${agentId}-run`, [
    '#!/usr/bin/env bash',
    ...(bannerCmd ? [bannerCmd] : []),
    envExports,
    mainCmd,
    notifyCmd,
  ]);
  const fullCmd = `bash '${scriptPath}'`;

  return { paneId, fullCmd, resumeEnv: envExports, resumeArgs };
}

export interface SpawnAgentOpts {
  sessionId: string;
  sessionName?: string;
  cycleNum: number;
  cwd: string;
  agentType: string;
  name: string;
  instruction: string;
  windowId: string;
  repo?: string;
}

export async function spawnAgent(opts: SpawnAgentOpts): Promise<Agent> {
  const { sessionId, cwd, agentType, name, instruction, windowId } = opts;
  const count = (agentCounters.get(sessionId) ?? 0) + 1;
  agentCounters.set(sessionId, count);
  const agentId = `agent-${String(count).padStart(3, '0')}`;
  const bundledPluginPath = resolve(import.meta.dirname, '../templates/agent-plugin');

  // Resolve agent config for frontmatter (color, model, provider)
  const agentConfig = resolveAgentConfig(agentType, bundledPluginPath, cwd);
  let provider = detectProvider(agentConfig?.frontmatter.model);
  const color = (agentConfig?.frontmatter.color ? normalizeTmuxColor(agentConfig.frontmatter.color) : null) ?? getNextColor(sessionId);

  // Verify CLI is available before spawning; fall back if configured
  let cliToCheck = provider === 'openai' ? 'codex' : 'claude';
  try {
    execSync(`which ${cliToCheck}`, { stdio: 'pipe', env: execEnv() });
  } catch {
    const fallback = agentConfig?.frontmatter.fallbackModel;
    if (fallback) {
      const fallbackProvider = detectProvider(fallback);
      const fallbackCli = fallbackProvider === 'openai' ? 'codex' : 'claude';
      try {
        execSync(`which ${fallbackCli}`, { stdio: 'pipe', env: execEnv() });
      } catch {
        throw new Error(`Neither ${cliToCheck} (model: ${agentConfig?.frontmatter.model}) nor ${fallbackCli} (fallback: ${fallback}) CLI found on PATH. Run \`sis admin check doctor\` to diagnose.`);
      }
      if (agentConfig) agentConfig.frontmatter.model = fallback;
      provider = fallbackProvider;
    } else {
      throw new Error(`${cliToCheck} CLI not found on PATH. Run \`sis admin check doctor\` to diagnose.`);
    }
  }

  const repo = opts.repo !== undefined ? opts.repo : '.';
  const repoRoot = repo === '.' ? cwd : join(cwd, repo);
  const paneCwd = repoRoot;

  const claudeSessionId = provider !== 'openai' ? randomUUID() : undefined;

  const { paneId, fullCmd, resumeEnv, resumeArgs } = setupAgentPane({
    sessionId, sessionName: opts.sessionName, cycleNum: opts.cycleNum, cwd, agentId, agentType, name, instruction,
    windowId, color, provider, agentConfig, paneCwd, claudeSessionId,
  });

  const agent: Agent = {
    id: agentId,
    name,
    agentType,
    provider,
    claudeSessionId,
    color,
    instruction,
    status: 'running',
    spawnedAt: new Date().toISOString(),
    completedAt: null,
    activeMs: 0,
    reports: [],
    paneId,
    repo,
    resumeEnv,
    resumeArgs,
  };

  await state.addAgent(cwd, sessionId, agent);

  tmux.sendKeys(paneId, fullCmd);

  const captured = await capturePanePidLstart(paneId);
  if (captured) {
    await state.setAgentPid(cwd, sessionId, agentId, captured.pid, captured.lstart);
  }

  return agent;
}

export async function restartAgent(
  sessionId: string,
  cwd: string,
  agentId: string,
  windowId: string,
): Promise<void> {
  const session = state.getSession(cwd, sessionId);
  const agent = session.agents.find(a => a.id === agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  if (agent.status === 'running') {
    // Check if the pane is actually alive — if not, the agent is a zombie
    const paneAlive = agent.paneId && tmux.paneExists(agent.paneId);
    if (paneAlive) {
      throw new Error(`Agent ${agentId} is already running`);
    }
    // Pane is dead — mark as lost before restarting
    await state.updateAgent(cwd, sessionId, agentId, {
      status: 'lost',
      killedReason: 'pane disappeared (detected on restart)',
      completedAt: new Date().toISOString(),
    });
  }

  const { instruction, agentType, name, color } = agent;
  const bundledPluginPath = resolve(import.meta.dirname, '../templates/agent-plugin');

  // Resolve agent config for frontmatter (model, provider)
  const agentConfig = resolveAgentConfig(agentType, bundledPluginPath, cwd);
  const provider = detectProvider(agentConfig?.frontmatter.model);

  let paneCwd = cwd;

  if (agent.repo !== '.') {
    paneCwd = join(cwd, agent.repo);
  }

  // Kill old pane if it still exists
  if (agent.paneId) {
    try { tmux.killPane(agent.paneId); } catch { /* already dead */ }
    unregisterAgentPane(sessionId, agentId);
  }

  // GC the bg-tasks registry from the prior Claude session — on restart, Claude Code
  // spawns a fresh session UUID, so any background Tasks it tracked are orphaned.
  gcBgTasks(cwd, sessionId, agentId);

  const claudeSessionId = provider !== 'openai' ? randomUUID() : undefined;

  const { paneId, fullCmd } = setupAgentPane({
    sessionId, sessionName: session.name, cycleNum: session.orchestratorCycles.length, cwd, agentId, agentType, name, instruction,
    windowId, color, provider, agentConfig, paneCwd, claudeSessionId,
  });

  // Preserve original spawn time (immutable after first restart)
  const originalSpawnedAt = agent.originalSpawnedAt ?? agent.spawnedAt;
  const restartCount = (agent.restartCount ?? 0) + 1;
  const previousStatus = agent.status;

  // Update agent state in-place
  await state.updateAgent(cwd, sessionId, agentId, {
    status: 'running',
    paneId,
    provider,
    claudeSessionId,
    spawnedAt: new Date().toISOString(),
    completedAt: null,
    killedReason: undefined,
    originalSpawnedAt,
    restartCount,
  });

  tmux.sendKeys(paneId, fullCmd);

  const capturedRestart = await capturePanePidLstart(paneId);
  if (capturedRestart) {
    await state.setAgentPid(cwd, sessionId, agentId, capturedRestart.pid, capturedRestart.lstart);
  }

  emitHistoryEvent(sessionId, 'agent-restarted', { agentId, restartCount, originalSpawnedAt, previousStatus, claudeSessionId });

  // Resolve any pending orphan asks for this agent now that it has been restarted.
  resolveAgentOrphanAsks(cwd, sessionId, agentId, 'respawn').catch(err => {
    console.warn(
      `[sisyphus] resolveAgentOrphanAsks on restart failed for ${agentId}:`,
      err instanceof Error ? err.message : err,
    );
  });
}

function nextReportNumber(cwd: string, sessionId: string, agentId: string): string {
  const dir = reportsDir(cwd, sessionId);
  try {
    const files = readdirSync(dir).filter(f => f.startsWith(`${agentId}-`) && !f.endsWith('-final.md'));
    return String(files.length + 1).padStart(3, '0');
  } catch {
    return '001';
  }
}

export async function handleAgentReport(
  cwd: string,
  sessionId: string,
  agentId: string,
  content: string,
): Promise<void> {
  const dir = reportsDir(cwd, sessionId);
  mkdirSync(dir, { recursive: true });

  const num = nextReportNumber(cwd, sessionId, agentId);
  const filePath = reportFilePath(cwd, sessionId, agentId, num);
  writeFileSync(filePath, content, 'utf-8');

  const entry: AgentReport = {
    type: 'update',
    filePath,
    summary: content.slice(0, 200),
    timestamp: new Date().toISOString(),
  };
  await state.appendAgentReport(cwd, sessionId, agentId, entry);

  // Fire async Haiku summarization (non-blocking)
  summarizeReport(content).then(async (aiSummary) => {
    if (aiSummary) {
      await state.updateReportSummary(cwd, sessionId, agentId, filePath, aiSummary);
    }
  }).catch((err) => { console.warn('[sisyphus] Report summarization failed:', err instanceof Error ? err.message : err); });
}

// Clean up the per-agent background-task registry written by register-bg-task.sh.
// Called from every agent-completion path (submit, kill, pane-exit, restart). Any entries
// still present represent background Tasks the agent launched but never saw complete —
// surface them as a warning so we can spot detector drift or agents that stop early.
export function gcBgTasks(cwd: string, sessionId: string, agentId: string): void {
  const file = `${sessionDir(cwd, sessionId)}/runtime/bg-tasks/${agentId}.txt`;
  if (!existsSync(file)) return;
  try {
    const leftover = readFileSync(file, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean);
    if (leftover.length > 0) {
      console.warn(`[bg-tasks] ${agentId} exited with ${leftover.length} untracked background task(s): ${leftover.join(', ')}`);
      emitHistoryEvent(sessionId, 'bg-tasks-leftover', { agentId, leftover });
    }
    unlinkSync(file);
  } catch (err) {
    console.warn(`[bg-tasks] ${agentId} cleanup failed:`, err instanceof Error ? err.message : err);
  }
}

export async function handleAgentSubmit(
  cwd: string,
  sessionId: string,
  agentId: string,
  report: string,
): Promise<boolean> {
  const dir = reportsDir(cwd, sessionId);
  mkdirSync(dir, { recursive: true });

  const filePath = reportFilePath(cwd, sessionId, agentId, 'final');
  writeFileSync(filePath, report, 'utf-8');

  const entry: AgentReport = {
    type: 'final',
    filePath,
    summary: report.slice(0, 200),
    timestamp: new Date().toISOString(),
  };
  await state.appendAgentReport(cwd, sessionId, agentId, entry);

  // Fire async Haiku summarization (non-blocking)
  summarizeReport(report).then(async (aiSummary) => {
    if (aiSummary) {
      await state.updateReportSummary(cwd, sessionId, agentId, filePath, aiSummary);
    }
  }).catch((err) => { console.warn('[sisyphus] Report summarization failed:', err instanceof Error ? err.message : err); });

  const flushedActiveMs = flushAgentTimer(sessionId, agentId);
  await state.updateAgent(cwd, sessionId, agentId, {
    status: 'completed',
    completedAt: new Date().toISOString(),
    activeMs: flushedActiveMs,
  });
  emitHistoryEvent(sessionId, 'agent-completed', { agentId, status: 'completed', activeMs: flushedActiveMs, reportSummary: report.slice(0, 500) });
  gcBgTasks(cwd, sessionId, agentId);

  // Kill the pane — Claude doesn't exit on its own after running a bash command.
  // But if this is the last agent, defer the kill to onAllAgentsDone() so the tmux
  // window doesn't collapse (killing the last pane destroys the window and detaches the user).
  const session = state.getSession(cwd, sessionId);
  const agent = session.agents.find(a => a.id === agentId);
  const allDone = allAgentsDone(session);
  if (agent?.paneId) {
    unregisterAgentPane(sessionId, agentId);
    if (!allDone) {
      try { tmux.killPane(agent.paneId); } catch { /* already dead */ }
    }
  }

  return allDone;
}

export async function handleAgentKilled(
  cwd: string,
  sessionId: string,
  agentId: string,
  reason: string,
): Promise<boolean> {
  unregisterAgentPane(sessionId, agentId);
  const flushedActiveMs = flushAgentTimer(sessionId, agentId);
  await state.markAgentOrphan(cwd, sessionId, agentId, {
    reason,
    status: 'lost',
    activeMs: flushedActiveMs,
  });
  emitHistoryEvent(sessionId, 'agent-exited', { agentId, status: 'lost', activeMs: flushedActiveMs, orphaned: true });
  gcBgTasks(cwd, sessionId, agentId);

  const session = state.getSession(cwd, sessionId);
  const agent = session.agents.find(a => a.id === agentId);
  await markAgentAsksOrphan(cwd, sessionId, agentId);
  await emitOrphanAsk({
    cwd, sessionId, reason: 'pane-gone',
    detectedAt: new Date().toISOString(),
    agent: agent ? { id: agent.id, name: agent.name, paneId: agent.paneId } : undefined,
  });

  return allAgentsDone(session);
}

// Note: this checks ALL running agents in the session, not just orchestrator-spawned ones.
// Agents can also call `sis agent spawn`, and those child agents are included here —
// the orchestrator won't respawn until every agent (including agent-spawned ones) finishes.
function allAgentsDone(session: import('../shared/types.js').Session): boolean {
  const running = session.agents.filter(a => a.status === 'running');
  return running.length === 0 && session.agents.length > 0;
}

export interface AwaitResult {
  status: import('../shared/types.js').AgentStatus;
  reportPath: string | null;
  agentName: string;
  agentType: string;
}

/**
 * Block until the named agent reaches a terminal status, then mark it
 * `consumedInline` so its report is suppressed from the next cycle's prompt.
 * Returns null when the agent ID is unknown for the session.
 */
export async function handleAwait(
  cwd: string,
  sessionId: string,
  agentId: string,
): Promise<AwaitResult | null> {
  const initial = state.getSession(cwd, sessionId);
  const initialAgent = initial.agents.find(a => a.id === agentId);
  if (!initialAgent) return null;

  const POLL_MS = 250;
  let agent = initialAgent;
  while (agent.status === 'running') {
    await new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
    const session = state.getSession(cwd, sessionId);
    const found = session.agents.find(a => a.id === agentId);
    if (!found) return null;
    agent = found;
  }

  await state.setAgentConsumedInline(cwd, sessionId, agentId);

  const finalReport = agent.reports.find(r => r.type === 'final');
  return {
    status: agent.status,
    reportPath: finalReport?.filePath ?? null,
    agentName: agent.name,
    agentType: agent.agentType,
  };
}

