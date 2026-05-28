import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve, join, relative } from 'node:path';
import { resolveNpmBinDir, resolveBannerCmd, buildEnvExports, buildNotifyCmd, writeRunScript } from './spawn-helpers.js';
import { injectHelp } from './help-inject.js';
import {
  contextDir, goalPath, strategyPath, digestPath, cycleLogPath, logsDir, roadmapPath,
  projectOrchestratorPromptPath, userOrchestratorPromptPath,
  projectOrchestratorSettingsPath, userOrchestratorSettingsPath,
  promptsDir, sessionDir, reportsDir,
} from '../shared/paths.js';
import { execSafe } from '../shared/exec.js';
import { digestSpinnerVerbs } from '../shared/digest-verbs.js';
import { ORCHESTRATOR_ASKED_BY } from '../shared/types.js';
import type { Agent, Session } from '../shared/types.js';
import { loadConfig } from '../shared/config.js';
import { shellQuote } from '../shared/shell.js';
import { ORCHESTRATOR_COLOR } from './colors.js';
import { discoverAgentTypes, extractAgentBody } from './frontmatter.js';
import { discoverOrchestratorModes } from './orchestrator-modes.js';
import * as state from './state.js';
import { renderEffortMarkers } from './lib/effort-render.js';
import { renderPluginDir } from './lib/render-plugin.js';
import { orchestratorPluginLayers, renderLayeredPluginDir } from './extensions.js';
import * as tmux from './tmux.js';
import { registerPane, unregisterPane, unregisterSessionPanes } from './pane-registry.js';
import { flushCycleTimer } from './pane-monitor.js';
import { emitModeTransitionNotify } from './mode-notify.js';
import { resolveRequiredPluginDirs } from './plugins.js';


interface RepoInfo {
  name: string;       // "." for session root, directory name for children
  path: string;       // absolute path
  branch: string;     // current git branch
  isDirty: boolean;   // has uncommitted changes
}

function detectRepos(cwd: string): RepoInfo[] {
  const config = loadConfig(cwd);
  const repos: RepoInfo[] = [];

  // Check if session root is a git repo
  if (existsSync(join(cwd, '.git'))) {
    try { repos.push(getRepoInfo(cwd, '.')); } catch { /* skip unreadable root repo */ }
  }

  // Scan immediate children for git repos
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      const childPath = join(cwd, entry.name);
      if (existsSync(join(childPath, '.git'))) {
        try { repos.push(getRepoInfo(childPath, entry.name)); } catch { /* skip unreadable repo */ }
      }
    }
  } catch { /* ignore read errors */ }

  // Filter by config.repos if present
  if (config.repos && config.repos.length > 0) {
    const allowed = new Set(config.repos);
    return repos.filter(r => r.name === '.' || allowed.has(r.name));
  }

  return repos;
}

function getRepoInfo(repoPath: string, name: string): RepoInfo {
  const branchRaw = execSafe(`git -C ${shellQuote(repoPath)} rev-parse --abbrev-ref HEAD`)?.trim();
  if (!branchRaw) throw new Error(`Failed to detect git branch for repo: ${repoPath}`);
  const status = execSafe(`git -C ${shellQuote(repoPath)} status --porcelain`);
  const isDirty = !!(status && status.trim().length > 0);
  return { name, path: repoPath, branch: branchRaw, isDirty };
}

const sessionWindowMap = new Map<string, string>();
const sessionOrchestratorPane = new Map<string, string>();

export function getWindowId(sessionId: string): string | undefined {
  return sessionWindowMap.get(sessionId);
}

export function setWindowId(sessionId: string, windowId: string): void {
  sessionWindowMap.set(sessionId, windowId);
}

export function getOrchestratorPaneId(sessionId: string): string | undefined {
  return sessionOrchestratorPane.get(sessionId);
}

export function setOrchestratorPaneId(sessionId: string, paneId: string): void {
  sessionOrchestratorPane.set(sessionId, paneId);
}

/**
 * Shallow-merge orchestrator settings across layers (project > user > bundled)
 * and write the result into the session prompts dir. Returns the path Claude
 * CLI should be pointed at via `--settings`. Falls back to the bundled file
 * unmodified if no extension layer contributes.
 */
function resolveOrchestratorSettings(cwd: string, sessionId: string): string {
  const bundled = resolve(import.meta.dirname, '../templates/orchestrator-settings.json');
  const projectSettings = projectOrchestratorSettingsPath(cwd);
  const userSettings = userOrchestratorSettingsPath();

  const hasProject = existsSync(projectSettings);
  const hasUser = existsSync(userSettings);
  const digestVerbs = digestSpinnerVerbs(cwd, sessionId);
  if (!hasProject && !hasUser && !digestVerbs) return bundled;

  // Merge from lowest to highest priority so higher overrides lower.
  let merged: Record<string, unknown> = {};
  for (const path of [bundled, hasUser ? userSettings : null, hasProject ? projectSettings : null]) {
    if (!path || !existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      merged = { ...merged, ...parsed };
    } catch (err) {
      console.warn(`[sisyphus] Failed to parse settings layer ${path}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Live session status (digest.json) replaces the themed verbs when present.
  if (digestVerbs) {
    merged.spinnerVerbs = { mode: 'replace', verbs: digestVerbs };
  }

  const out = join(promptsDir(cwd, sessionId), 'orchestrator-settings.merged.json');
  writeFileSync(out, JSON.stringify(merged, null, 2), 'utf-8');
  return out;
}

function loadOrchestratorPrompt(cwd: string, sessionId: string, mode: string): string {
  // Project- or user-level full base override (single-file replacement of the bundled base).
  const projectPath = projectOrchestratorPromptPath(cwd);
  if (existsSync(projectPath)) {
    return readFileSync(projectPath, 'utf-8');
  }
  const userPath = userOrchestratorPromptPath();
  if (existsSync(userPath)) {
    return readFileSync(userPath, 'utf-8');
  }

  const basePath = resolve(import.meta.dirname, '../templates/orchestrator-base.md');
  const base = readFileSync(basePath, 'utf-8');

  const modes = discoverOrchestratorModes(cwd);
  const selected = modes.find(m => m.name === mode) ?? modes.find(m => m.name === 'discovery');

  if (!selected) {
    throw new Error(`Unknown orchestrator mode '${mode}' and no fallback found. Available: ${modes.map(m => m.name).join(', ')}`);
  }

  const modeContent = readFileSync(selected.filePath, 'utf-8');
  const modeBody = extractAgentBody(modeContent);

  return base + '\n\n' + modeBody;
}

// --- Mode-specific user prompt content ---
// Each function receives the session and returns extra markdown to append.
// Add new modes here as the orchestrator grows.

type ModeContentBuilder = (session: Session) => string;

const modeContentBuilders: Record<string, ModeContentBuilder> = {
  completion: buildCompletionContent,
};

export function buildCompletionContent(session: Session): string {
  const lines: string[] = ['\n## Session History\n'];

  // Agent summary table
  if (session.agents.length > 0) {
    lines.push('### Agents\n');
    lines.push('| Agent | Name | Type | Status | Summary |');
    lines.push('|-------|------|------|--------|---------|');
    for (const agent of session.agents) {
      const finalReport = agent.reports.find(r => r.type === 'final');
      const summary = finalReport?.summary ?? agent.reports[agent.reports.length - 1]?.summary ?? '(no report)';
      lines.push(`| ${agent.id} | ${agent.name} | ${agent.agentType} | ${agent.status} | ${summary} |`);
    }
    lines.push('');
  }

  // Inline cycle logs, collapsing runs of consecutive idle (zero-agent) cycles into
  // a single summary line. Without compaction a long completion-mode hold (e.g. 90+
  // peek-and-yield cycles waiting on a deck) inflates this section past 1k lines and
  // the orchestrator's user prompt past 4k lines. We preserve the last 5 cycles
  // verbatim — they're load-bearing for "what just happened" — and any cycle that
  // actually spawned agents.
  const logsDirPath = logsDir(session.cwd, session.id);
  if (existsSync(logsDirPath)) {
    const logFiles = readdirSync(logsDirPath)
      .filter(f => f.startsWith('cycle-') && f.endsWith('.md'))
      .sort();
    if (logFiles.length > 0) {
      lines.push('### Cycle Logs\n');
      const cycleByNum = new Map(session.orchestratorCycles.map(c => [c.cycle, c]));
      const totalCycles = session.orchestratorCycles.length;
      const VERBATIM_TAIL = 5;

      type Entry = { cycleNum: number; file: string; idle: boolean; mode?: string };
      const entries: Entry[] = logFiles.map(file => {
        const m = file.match(/^cycle-(\d+)\.md$/);
        const cycleNum = m && m[1] ? parseInt(m[1], 10) : NaN;
        const meta = cycleByNum.get(cycleNum);
        const isTail = !isNaN(cycleNum) && cycleNum > totalCycles - VERBATIM_TAIL;
        const idle = !!meta && meta.agentsSpawned.length === 0 && !isTail;
        const result: Entry = { cycleNum, file, idle };
        if (meta?.mode) result.mode = meta.mode;
        return result;
      });

      let i = 0;
      while (i < entries.length) {
        const e = entries[i]!;
        if (e.idle) {
          // Collapse a run of consecutive idle cycles. Group strictly by matching
          // mode value (an undefined mode breaks the run — mixed modes don't get
          // pooled into one summary).
          let j = i + 1;
          while (j < entries.length && entries[j]!.idle && entries[j]!.mode === e.mode) j++;
          const runEntries = entries.slice(i, j);
          if (runEntries.length === 1) {
            const content = readFileSync(join(logsDirPath, e.file), 'utf-8').trim();
            if (content) { lines.push(content); lines.push(''); }
          } else {
            const first = runEntries[0]!;
            const last = runEntries[runEntries.length - 1]!;
            const modeTag = e.mode ? `${e.mode}, ` : '';
            lines.push(`#### Cycles ${first.cycleNum}–${last.cycleNum} — ${runEntries.length} idle cycles (${modeTag}0 agents each)`);
            lines.push('');
            lines.push(`Collapsed for prompt size. Per-cycle detail on disk: \`logs/cycle-${String(first.cycleNum).padStart(3, '0')}.md\` … \`logs/cycle-${String(last.cycleNum).padStart(3, '0')}.md\`.`);
            lines.push('');
          }
          i = j;
        } else {
          const content = readFileSync(join(logsDirPath, e.file), 'utf-8').trim();
          if (content) { lines.push(content); lines.push(''); }
          i++;
        }
      }
    }
  }

  // Reference to full reports for deeper digging
  const reportsDirPath = reportsDir(session.cwd, session.id);
  if (existsSync(reportsDirPath)) {
    const reportFiles = readdirSync(reportsDirPath).filter(f => f.endsWith('.md'));
    if (reportFiles.length > 0) {
      lines.push('### Detailed Reports\n');
      lines.push(`Full agent reports: @${relative(session.cwd, reportsDirPath)}\n`);
    }
  }

  return lines.join('\n');
}

function formatStateForOrchestrator(session: Session, mode: string): string {
  const cycleNum = session.orchestratorCycles.length;

  const ctxDir = contextDir(session.cwd, session.id);
  const roadmapFile = roadmapPath(session.cwd, session.id);
  const logFile = cycleLogPath(session.cwd, session.id, cycleNum + 1);

  // Context section: first cycle shows background context text; subsequent cycles show context dir files
  let contextSection = '';
  if (cycleNum === 0) {
    if (session.context) {
      contextSection = `\n## Context\n\n${session.context}\n`;
    }
  } else {
    let ctxFiles: string[] = [];
    if (existsSync(ctxDir)) {
      ctxFiles = readdirSync(ctxDir).filter(f => f !== 'CLAUDE.md');
    }
    if (ctxFiles.length > 0) {
      contextSection = `\n## Context\n\n@${relative(session.cwd, ctxDir)}\n`;
    }
  }

  // Messages section
  const messages = session.messages ?? [];
  const messagesSection = messages.length > 0
    ? '\n### Messages\n\n' + messages.map(m => {
        const sourceLabel = m.source.type === 'agent'
          ? `agent:${m.source.agentId}`
          : m.source.type === 'system' && m.source.detail
            ? `system:${m.source.detail}`
            : m.source.type;
        const fileRef = m.filePath ? ` → ${relative(session.cwd, m.filePath)}` : '';
        return `- [${sourceLabel} @ ${m.timestamp}] "${m.summary}"${fileRef}`;
      }).join('\n') + '\n'
    : '';


  // Most recent cycle: agent reports as file references.
  // Agents marked `consumedInline` (via `sis agent await`) are filtered out — their reports
  // were already absorbed inline during the previous cycle and shouldn't reappear here.
  let mostRecentCycleSection = '';
  const lastCycle = session.orchestratorCycles[session.orchestratorCycles.length - 1];
  if (lastCycle && lastCycle.agentsSpawned.length > 0) {
    const agentMap = new Map(session.agents.map((a: Agent) => [a.id, a]));
    const visibleSpawned = lastCycle.agentsSpawned.filter(id => {
      const a = agentMap.get(id);
      return !a || !a.consumedInline;
    });
    if (visibleSpawned.length > 0) {
      const agentLines = visibleSpawned.map(id => {
        const agent = agentMap.get(id);
        if (!agent) return `- **${id}**: unknown (no agent data)`;

        const finalReport = agent.reports.find(r => r.type === 'final');
        const reportToUse = finalReport ?? agent.reports[agent.reports.length - 1];
        const reportRef = reportToUse ? `@${relative(session.cwd, reportToUse.filePath)}` : '(no reports)';

        return `- **${id}** (${agent.name}) [${agent.status}]: ${reportRef}`;
      }).join('\n');

      mostRecentCycleSection = `\n### Most Recent Cycle\n\n${agentLines}\n`;
    }
  }

  // Strategy section
  const strategyFile = strategyPath(session.cwd, session.id);
  const strategyRef = existsSync(strategyFile) ? `@${relative(session.cwd, strategyFile)}` : '(empty)';

  // Roadmap section
  const roadmapRef = existsSync(roadmapFile) ? `@${relative(session.cwd, roadmapFile)}` : '(empty)';

  // Digest section
  const digestFile = digestPath(session.cwd, session.id);
  const digestRef = existsSync(digestFile) ? `@${relative(session.cwd, digestFile)}` : '(not yet created)';

  // Repositories section — always present
  const repos = detectRepos(session.cwd);
  let repositoriesSection = '\n\n## Repositories\n';

  if (repos.length === 0) {
    repositoriesSection += '\nNo git repositories detected.\n';
  } else {
    for (const repo of repos) {
      const dirtyTag = repo.isDirty ? ' (dirty)' : '';
      repositoriesSection += `\n### ${repo.name === '.' ? 'Session Root (.)' : repo.name}\n`;
      repositoriesSection += `Branch: \`${repo.branch}\`${dirtyTag}\n`;

      // Agents targeting this repo
      const repoAgents = session.agents.filter((a: Agent) => a.repo === repo.name);
      if (repoAgents.length > 0) {
        repositoriesSection += '\nAgents:\n';
        for (const a of repoAgents) {
          repositoriesSection += `- ${a.id} (${a.name}) [${a.status}]\n`;
        }
      }
    }

    // Spawn syntax hint for multi-repo
    if (repos.length > 1) {
      repositoriesSection += '\nTarget agents at specific repos:\n```bash\nsis agent spawn --name "impl" --repo <repo-name> "task"\n```\n';
    }
  }

  // Goal section: read from goal.md, fall back to session.task
  const goalFile = goalPath(session.cwd, session.id);
  const goalContent = existsSync(goalFile) ? readFileSync(goalFile, 'utf-8').trim() : session.task;

  // Mode-specific content
  const modeContent = modeContentBuilders[mode]?.(session) ?? '';

  return `## Goal

${goalContent}
${contextSection}${messagesSection}
### Cycle Log

Write your cycle summary to: ${relative(session.cwd, logFile)}
${mostRecentCycleSection}${modeContent}
## Strategy

${strategyRef}

## Roadmap

${roadmapRef}

## Digest

${digestRef}
`;
}

export async function spawnOrchestrator(sessionId: string, cwd: string, windowId: string, message?: string, forceMode?: string): Promise<void> {
  // Verify claude CLI is available before spawning
  try {
    execSync('which claude', { stdio: 'pipe', env: tmux.EXEC_ENV });
  } catch {
    throw new Error('Claude CLI not found on PATH. Run `sis admin check doctor` to diagnose.');
  }

  const session = state.getSession(cwd, sessionId);

  // Read mode and nextPrompt from last completed cycle
  const lastCycle = [...session.orchestratorCycles].reverse().find(c => c.completedAt);
  const mode = forceMode ?? (lastCycle?.mode ?? 'discovery');

  const basePrompt = loadOrchestratorPrompt(cwd, sessionId, mode);
  const formattedState = formatStateForOrchestrator(session, mode);

  // Inject available agent types into system prompt.
  // Restricted to sisyphus-extension agents: bundled `sisyphus:*` plus project-level
  // agents under `.sisyphus/agent-plugin/agents/`. Project sisyphus agents are
  // autoloaded alongside the bundled set so the orchestrator can delegate to them.
  // `.claude/agents` (project/user), user-global sisyphus, and external plugin agents
  // remain hidden to keep the curated set stable.
  const agentPluginPath = resolve(import.meta.dirname, '../templates/agent-plugin');
  const agentTypes = discoverAgentTypes(agentPluginPath, session.cwd)
    .filter(t => t.source === 'bundled' || t.source === 'project-sis');


  const agentTypeLines = agentTypes.length > 0
    ? agentTypes.map(t => {
        const tag = t.model ? `(agent, ${t.model})` : '(agent)';
        const desc = t.description ? ` — ${t.description}` : '';
        return `- \`${t.qualifiedName}\` ${tag}${desc}`;
      }).join('\n')
    : '  (none)';

  const sesDir = sessionDir(cwd, sessionId);
  const substituteEnvVars = (text: string) => text
    .replace(/\$SISYPHUS_SESSION_DIR/g, sesDir)
    .replace(/\$SISYPHUS_SESSION_ID/g, sessionId);

  // Inject available orchestrator modes into system prompt
  const modes = discoverOrchestratorModes(cwd);
  const modeLines = modes.map(m => {
    const desc = m.description ? ` — ${m.description}` : '';
    return `- \`${m.name}\`${desc}`;
  }).join('\n');

  const substitutedPrompt = substituteEnvVars(
    injectHelp(
      basePrompt
        .replace('{{AGENT_TYPES}}', agentTypeLines)
        .replace('{{ORCHESTRATOR_MODES}}', modeLines)
    )
  );
  const sessionEffort = session.effort != null ? session.effort : 'high';
  const systemPrompt = renderEffortMarkers(substitutedPrompt, sessionEffort);

  // System prompt: template + agent types (no state)
  const cycleNum = session.orchestratorCycles.length + 1;
  const promptFilePath = `${promptsDir(cwd, sessionId)}/orchestrator-system-${cycleNum}.md`;
  writeFileSync(promptFilePath, systemPrompt, 'utf-8');

  sessionWindowMap.set(sessionId, windowId);

  const npmBinDir = resolveNpmBinDir();

  const envExports = buildEnvExports([
    `export SISYPHUS_SESSION_ID=${shellQuote(sessionId)}`,
    `export SISYPHUS_AGENT_ID='${ORCHESTRATOR_ASKED_BY}'`,
    `export SISYPHUS_CWD=${shellQuote(cwd)}`,
    `export SISYPHUS_SESSION_DIR=${shellQuote(sesDir)}`,
    `export PATH="${npmBinDir}:$PATH"`,
  ]);

  // User message: session state + contextual prompt
  let userPrompt = formattedState;
  if (message) {
    userPrompt += `\n\n## Continuation Instructions\n\nThe user resumed this session with new instructions: ${message}`;
  } else {
    const storedPrompt = lastCycle?.nextPrompt;
    const continuationText = storedPrompt ? storedPrompt : 'Review the current session and delegate the next cycle of work.';
    userPrompt += `\n\n## Continuation Instructions\n\n${continuationText}`;
  }

  // Surface long human-in-the-loop waits from the prior cycle so the orchestrator
  // can decide whether to re-verify state freshness before acting on a stale answer.
  const PROMPT_BLOCK_THRESHOLD_MS = 60 * 60 * 1000; // 1h
  const priorBlockedMs = lastCycle?.userBlockedMs ?? 0;
  if (priorBlockedMs >= PROMPT_BLOCK_THRESHOLD_MS) {
    const hours = (priorBlockedMs / (60 * 60 * 1000)).toFixed(1);
    userPrompt += `\n\n## Note: Prior Cycle Included a Long Pause\n\nThe previous cycle waited ~${hours}h for a \`sis ask\` answer. Repository state and any in-flight context may have drifted during that window. Briefly verify before acting on the answer.`;
  }

  const userPromptFilePath = `${promptsDir(cwd, sessionId)}/orchestrator-user-${cycleNum}.md`;
  writeFileSync(userPromptFilePath, substituteEnvVars(userPrompt), 'utf-8');

  // Drain rendered messages so they don't reappear in future cycles
  if (session.messages && session.messages.length > 0) {
    await state.drainMessages(cwd, sessionId, session.messages.length);
  }

  // Layered plugin composition: project (.sisyphus/orchestrator-plugin) > user
  // (~/.sisyphus/orchestrator-plugin) > bundled (templates/orchestrator-plugin).
  // Higher layers shadow lower per relative path; effort markers rendered on .md files.
  const pluginPath = join(sesDir, '.orchestrator-plugin');
  const orchLayers = orchestratorPluginLayers(cwd);
  if (orchLayers.length === 0) {
    // Fallback to bundled-only via the original renderer in the unlikely case
    // that no layer resolves (mostly defensive — bundled should always be present).
    const pluginSrcPath = resolve(import.meta.dirname, '../templates/orchestrator-plugin');
    renderPluginDir(pluginSrcPath, pluginPath, sessionEffort);
  } else {
    renderLayeredPluginDir(orchLayers, pluginPath, sessionEffort);
  }

  // Layered settings: shallow-merge project > user > bundled (top-level keys).
  // Always materialize the merged JSON into the session prompts dir so Claude CLI
  // sees a single --settings target regardless of which layers contributed.
  const settingsPath = resolveOrchestratorSettings(cwd, sessionId);
  const config = loadConfig(cwd);
  const effort = config.orchestratorEffort ?? 'xhigh';
  const model = config.model;
  const modelFlag = model ? ` --model ${shellQuote(model)}` : '';
  const requiredPluginDirs = resolveRequiredPluginDirs(cwd);
  const extraPluginFlags = requiredPluginDirs.map(p => `--plugin-dir "${p}"`).join(' ');
  const claudeSessionId = randomUUID();
  const claudeCmd = `claude --dangerously-skip-permissions --disallowed-tools "Agent" --effort ${effort}${modelFlag} --session-id "${claudeSessionId}" --settings "${settingsPath}" --plugin-dir "${pluginPath}"${extraPluginFlags ? ` ${extraPluginFlags}` : ''} --name "ssph:orch ${session.name ?? sessionId.slice(0, 8)} c${cycleNum}" --system-prompt "$(cat '${promptFilePath}')" "$(cat '${userPromptFilePath}')"`;

  const paneId = tmux.createPane(windowId, cwd, 'left');

  sessionOrchestratorPane.set(sessionId, paneId);
  registerPane(paneId, sessionId, 'orchestrator');
  const sessionLabel = session.name ?? sessionId.slice(0, 8);
  tmux.setPaneTitle(paneId, `ssph:orch ${sessionLabel} c${cycleNum}`);
  tmux.setPaneStyle(paneId, ORCHESTRATOR_COLOR, { role: 'orch', session: sessionLabel, cycle: `c${cycleNum}`, mode });

  const notifyEnabled = config.notifications?.enabled !== false ? '1' : '0';
  const notifySound = config.notifications?.sound ?? '/System/Library/Sounds/Hero.aiff';
  const notifyEnvExports = buildEnvExports([
    `export SISYPHUS_NOTIFY_ENABLED=${shellQuote(notifyEnabled)}`,
    `export SISYPHUS_NOTIFY_SOUND=${shellQuote(notifySound)}`,
    `export SISYPHUS_SESSION_NAME=${shellQuote(sessionLabel)}`,
  ]);

  const bannerCmd = resolveBannerCmd();
  const notifyCmd = buildNotifyCmd(paneId);

  const scriptPath = writeRunScript(promptsDir(cwd, sessionId), `orchestrator-run-${cycleNum}`, [
    '#!/usr/bin/env bash',
    ...(bannerCmd ? [bannerCmd] : []),
    envExports,
    notifyEnvExports,
    claudeCmd,
    notifyCmd,
  ]);
  tmux.sendKeys(paneId, `bash '${scriptPath}'`);

  const resumeArgs = `--dangerously-skip-permissions --disallowed-tools "Agent" --effort ${effort} --settings "${settingsPath}" --plugin-dir "${pluginPath}"${extraPluginFlags ? ` ${extraPluginFlags}` : ''}`;
  const resumeEnv = `${envExports} && ${notifyEnvExports}`;

  // Compute inter-cycle gap from previous cycle's completedAt
  let interCycleGapMs: number | undefined;
  if (cycleNum >= 2) {
    const prevCycle = session.orchestratorCycles[session.orchestratorCycles.length - 1];
    if (prevCycle?.completedAt) {
      interCycleGapMs = Date.now() - new Date(prevCycle.completedAt).getTime();
    }
  }

  await state.addOrchestratorCycle(cwd, sessionId, {
    cycle: cycleNum,
    timestamp: new Date().toISOString(),
    activeMs: 0,
    agentsSpawned: [],
    paneId,
    claudeSessionId,
    mode,
    resumeEnv,
    resumeArgs,
    ...(interCycleGapMs !== undefined && { interCycleGapMs }),
  });
}

function resolveOrchestratorPane(sessionId: string, cwd: string): string | undefined {
  const memPane = sessionOrchestratorPane.get(sessionId);
  if (memPane) return memPane;
  const session = state.getSession(cwd, sessionId);
  const lastCycle = session.orchestratorCycles[session.orchestratorCycles.length - 1];
  return lastCycle?.paneId ?? undefined;
}

export async function handleOrchestratorYield(sessionId: string, cwd: string, nextPrompt?: string, mode?: string): Promise<void> {
  const paneId = resolveOrchestratorPane(sessionId, cwd);
  if (paneId) {
    tmux.killPane(paneId);
    unregisterPane(paneId);
    sessionOrchestratorPane.delete(sessionId);
  }

  const windowId = sessionWindowMap.get(sessionId);
  if (windowId) tmux.selectLayout(windowId);

  const session = state.getSession(cwd, sessionId);
  const prevMode = session.orchestratorCycles[session.orchestratorCycles.length - 1]?.mode;
  const cycleActiveMs = flushCycleTimer(sessionId, session.orchestratorCycles.length);

  // Snapshot prev-mode tail stats while cycle.mode still reflects the mode each
  // cycle ran in — completeOrchestratorCycle below overwrites the just-finished
  // cycle's mode to the new target.
  let prevModeStats: { cycles: number; activeMs: number } | undefined;
  if (mode && prevMode && mode !== prevMode) {
    let cycles = 0;
    let activeMs = cycleActiveMs;
    for (let i = session.orchestratorCycles.length - 1; i >= 0; i--) {
      const c = session.orchestratorCycles[i]!;
      if (c.mode !== prevMode) break;
      cycles++;
      activeMs += c.activeMs;
    }
    prevModeStats = { cycles, activeMs };
  }

  await state.completeOrchestratorCycle(cwd, sessionId, nextPrompt, mode, cycleActiveMs);
  if (mode && mode !== prevMode) {
    await emitModeTransitionNotify(cwd, sessionId, prevMode, mode, prevModeStats);
  }

  const freshSession = state.getSession(cwd, sessionId);
  const runningAgents = freshSession.agents.filter(a => a.status === 'running');
  if (runningAgents.length === 0) {
    console.log(`[sisyphus] Orchestrator yielded with no running agents for session ${sessionId}`);
  }
}

export async function handleOrchestratorComplete(sessionId: string, cwd: string, report: string): Promise<void> {
  const session = state.getSession(cwd, sessionId);
  const cycleActiveMs = flushCycleTimer(sessionId, session.orchestratorCycles.length);
  await state.completeOrchestratorCycle(cwd, sessionId, undefined, undefined, cycleActiveMs);
  await state.completeSession(cwd, sessionId, report);

  console.log(`[sisyphus] Session ${sessionId} completed: ${report}`);
}

export function cleanupSessionMaps(sessionId: string): void {
  sessionOrchestratorPane.delete(sessionId);
  sessionWindowMap.delete(sessionId);
  unregisterSessionPanes(sessionId);
}
