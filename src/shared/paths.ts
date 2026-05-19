import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export function globalDir(): string {
  return join(homedir(), '.sisyphus');
}

export function socketPath(): string {
  return join(globalDir(), 'daemon.sock');
}

export function globalConfigPath(): string {
  return join(globalDir(), 'config.json');
}

export function daemonLogPath(): string {
  return join(globalDir(), 'daemon.log');
}

export function daemonPidPath(): string {
  return join(globalDir(), 'daemon.pid');
}

export function daemonUpdatingPath(): string {
  return join(globalDir(), 'updating');
}

export function projectDir(cwd: string): string {
  return join(cwd, '.sisyphus');
}

export function projectConfigPath(cwd: string): string {
  return join(projectDir(cwd), 'config.json');
}

export function projectOrchestratorPromptPath(cwd: string): string {
  return join(projectDir(cwd), 'orchestrator.md');
}

export function userOrchestratorPromptPath(): string {
  return join(globalDir(), 'orchestrator.md');
}

export function projectOrchestratorSettingsPath(cwd: string): string {
  return join(projectDir(cwd), 'orchestrator-settings.json');
}

export function userOrchestratorSettingsPath(): string {
  return join(globalDir(), 'orchestrator-settings.json');
}

export function projectAgentPluginDir(cwd: string): string {
  return join(projectDir(cwd), 'agent-plugin');
}

export function userAgentPluginDir(): string {
  return join(globalDir(), 'agent-plugin');
}

export function projectOrchestratorPluginDir(cwd: string): string {
  return join(projectDir(cwd), 'orchestrator-plugin');
}

export function userOrchestratorPluginDir(): string {
  return join(globalDir(), 'orchestrator-plugin');
}

export function sessionsDir(cwd: string): string {
  return join(projectDir(cwd), 'sessions');
}

export function sessionDir(cwd: string, sessionId: string): string {
  return join(sessionsDir(cwd), sessionId);
}

export function statePath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), 'state.json');
}

export function reportsDir(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), 'reports');
}

export function reportFilePath(cwd: string, sessionId: string, agentId: string, suffix: string): string {
  return join(reportsDir(cwd, sessionId), `${agentId}-${suffix}.md`);
}

export function messagesDir(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), 'messages');
}

export function promptsDir(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), 'prompts');
}

export function contextDir(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), 'context');
}

export function roadmapPath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), 'roadmap.md');
}

export function goalPath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), 'goal.md');
}

export function initialPromptPath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), 'initial-prompt.md');
}

export function strategyPath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), 'strategy.md');
}

export function digestPath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), 'digest.json');
}

export function logsDir(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), 'logs');
}

export function cycleLogPath(cwd: string, sessionId: string, cycle: number): string {
  return join(logsDir(cwd, sessionId), `cycle-${String(cycle).padStart(3, '0')}.md`);
}

// Backwards compat for old sessions
export function legacyLogsPath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), 'logs.md');
}

export function snapshotsDir(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), 'snapshots');
}

export function snapshotDir(cwd: string, sessionId: string, cycle: number): string {
  return join(snapshotsDir(cwd, sessionId), `cycle-${cycle}`);
}

export function tuiScratchDir(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), '.tui');
}

// ── sisyphus ask: per-session ask directory and per-ask file paths ────────────

export function askDir(cwd: string, sessionId: string): string {
  return join(contextDir(cwd, sessionId), 'ask');
}

export function askEntryDir(cwd: string, sessionId: string, askId: string): string {
  return join(askDir(cwd, sessionId), askId);
}

export function askMetaPath(cwd: string, sessionId: string, askId: string): string {
  return join(askEntryDir(cwd, sessionId, askId), 'meta.json');
}

export function askDecisionsPath(cwd: string, sessionId: string, askId: string): string {
  return join(askEntryDir(cwd, sessionId, askId), 'deck.json');
}

export function askOutputPath(cwd: string, sessionId: string, askId: string): string {
  return join(askEntryDir(cwd, sessionId, askId), 'response.json');
}

export function askProgressPath(cwd: string, sessionId: string, askId: string): string {
  return join(askEntryDir(cwd, sessionId, askId), 'progress.json');
}

export function askReviewPath(cwd: string, sessionId: string, askId: string): string {
  return join(askEntryDir(cwd, sessionId, askId), 'review.json');
}

export function askReviewDraftPath(cwd: string, sessionId: string, askId: string): string {
  return join(askEntryDir(cwd, sessionId, askId), 'draft.json');
}

export function askReviewSubmitFlagPath(cwd: string, sessionId: string, askId: string): string {
  return join(askEntryDir(cwd, sessionId, askId), 'submitted');
}

export function askVisualsDir(cwd: string, sessionId: string, askId: string): string {
  return join(askEntryDir(cwd, sessionId, askId), 'visuals');
}

export function askVisualMarkdownPath(cwd: string, sessionId: string, askId: string, qid: string): string {
  return join(askVisualsDir(cwd, sessionId, askId), `${qid}.md`);
}

export function askVisualAnsiPath(cwd: string, sessionId: string, askId: string, qid: string): string {
  return join(askVisualsDir(cwd, sessionId, askId), `${qid}.ansi`);
}

export function tmuxSessionName(cwd: string, sessionLabel: string): string {
  // Use underscores as separators — slashes break tmux -t target resolution,
  // dots get silently converted to underscores by tmux (reserved for window.pane targeting)
  return `ssyph_${basename(cwd)}_${sessionLabel}`;
}

export function sessionsManifestPath(): string {
  return join(globalDir(), 'sessions-manifest.json');
}

export function sessionsManifestTsvPath(): string {
  return join(globalDir(), 'sessions-manifest.tsv');
}

export function companionPath(): string {
  return join(globalDir(), 'companion.json');
}

export function companionMemoryPath(): string {
  return join(globalDir(), 'companion-memory.json');
}

export function historyBaseDir(): string {
  return join(globalDir(), 'history');
}

export function historySessionDir(sessionId: string): string {
  return join(historyBaseDir(), sessionId);
}

export function historyEventsPath(sessionId: string): string {
  return join(historySessionDir(sessionId), 'events.jsonl');
}

export function historySessionSummaryPath(sessionId: string): string {
  return join(historySessionDir(sessionId), 'session.json');
}

// ── sisyphus deploy: per-provider Terraform state + creds ────────────────────

export function deployDir(): string {
  return join(globalDir(), 'deploy');
}

export function deployProviderDir(provider: string): string {
  return join(deployDir(), provider);
}

export function deployStatePath(provider: string): string {
  return join(deployProviderDir(provider), 'terraform.tfstate');
}

export function deployStateBackupPath(provider: string): string {
  return join(deployProviderDir(provider), 'terraform.tfstate.bak');
}

export function deployRuntimePath(provider: string): string {
  return join(deployProviderDir(provider), 'runtime.json');
}

export function deployCredsPath(provider: string): string {
  return join(deployDir(), `${provider}.env`);
}

export function deployTailscaleEnvPath(): string {
  return join(deployDir(), 'tailscale.env');
}

// ── sisyphus cloud: per-repo box-side paths (remote, not local fs) ───────────

/**
 * Path on the cloud box where a repo's working tree is rsync'd to.
 * `~/projects/<repo>` — interpreted by the box's shell, so this is a string
 * template, not for local fs use.
 */
export function boxRepoPath(repo: string): string {
  return `~/projects/${repo}`;
}

/**
 * Path on the cloud box where the per-repo cloud-state sidecar lives. Mirrors
 * the local `~/.sisyphus/deploy/<provider>/runtime.json` convention but for
 * the box's own `~/.sisyphus/cloud/<repo>.json`.
 */
export function boxCloudSidecarPath(repo: string): string {
  return `~/.sisyphus/cloud/${repo}.json`;
}

export function boxCloudSidecarDir(): string {
  return `~/.sisyphus/cloud`;
}

export function isSisyphusSession(name: string): boolean {
  return name.startsWith('ssyph_');
}

export function tmuxSessionDisplayName(name: string): string {
  return name.replace(/^ssyph_[^_]+_/, '');
}

