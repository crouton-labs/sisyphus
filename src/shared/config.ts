import { readFileSync } from 'node:fs';
import { globalConfigPath, projectConfigPath } from './paths.js';
import type { StatusBarConfig } from './types.js';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface NotificationConfig {
  enabled?: boolean;
  sound?: string;
}

export interface RequiredPlugin {
  name: string;
  marketplace: string;
  /** GitHub owner of the marketplace repo (`<owner>/<marketplace>`). */
  owner: string;
}

/**
 * A `crtr` (crouter) plugin sisyphus depends on for agent/orchestrator skills.
 * The bundled prompts reference these via `crtr skill show <plugin>/<skill>`;
 * `ensureRequiredCrtrPlugins` makes sure the marketplace is registered and the
 * plugin installed in the user's crtr scope.
 */
export interface RequiredCrtrPlugin {
  /** crtr marketplace name (the `name` in its `.crouter-marketplace/marketplace.json`). */
  marketplace: string;
  /** Plugin name within that marketplace. */
  plugin: string;
  /** Git URL passed to `crtr marketplace add` when the marketplace is absent. */
  gitUrl: string;
}

export interface UploadConfig {
  /** Worker base URL, e.g. https://sisyphus-upload-proxy.rhyneer-silas.workers.dev */
  url: string;
  /** Bearer token, format `sisyphus_pat_<43-char-base64url>` */
  token: string;
}

export interface Config {
  model?: string;
  tmuxSession?: string;
  orchestratorPrompt?: string;
  pollIntervalMs?: number;
  /**
   * Run the heavy status-bar work (compositor.render + recomputeDots) only on
   * every Nth pane-monitor tick. Default 4 → with the default 5s pollIntervalMs
   * the status bar redraws every ~20s. Lower for fresher dots; higher to cut
   * tmux subprocess load when you have many sessions.
   */
  statusBarRenderTicks?: number;
  autoUpdate?: boolean;
  orchestratorEffort?: EffortLevel;
  agentEffort?: EffortLevel;
  editor?: string;
  repos?: string[];
  notifications?: NotificationConfig;
  companionPopup?: boolean;
  requiredPlugins?: RequiredPlugin[];
  requiredCrtrPlugins?: RequiredCrtrPlugin[];
  statusBar?: StatusBarConfig;
  upload?: UploadConfig;
}

const DEFAULT_CONFIG: Config = {
  model: 'claude-opus-4-8[1m]',
  pollIntervalMs: 5000,
  statusBarRenderTicks: 4,
  orchestratorEffort: 'xhigh',
  agentEffort: 'high',
  notifications: {
    enabled: true,
    sound: '/System/Library/Sounds/Hero.aiff',
  },
  companionPopup: true,
  requiredPlugins: [
    { name: 'devcore', marketplace: 'crouton-kit', owner: 'crouton-labs' },
  ],
  requiredCrtrPlugins: [
    {
      marketplace: 'sisyphus',
      plugin: 'sisyphus',
      gitUrl: 'https://github.com/crouton-labs/sisyphus',
    },
  ],
};

function readJsonFile(filePath: string): Partial<Config> {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as Partial<Config>;
  } catch {
    return {};
  }
}

export function loadConfig(cwd: string): Config {
  const globalConfig = readJsonFile(globalConfigPath());
  const projectConfig = readJsonFile(projectConfigPath(cwd));
  if (projectConfig.upload !== undefined) {
    console.warn(
      'ignoring `upload` block from project-local .sisyphus/config.json — only the global config can set upload credentials',
    );
    delete projectConfig.upload;
  }
  const merged: Config = { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
  if (globalConfig.statusBar || projectConfig.statusBar) {
    merged.statusBar = {
      ...merged.statusBar,
      ...globalConfig.statusBar,
      ...projectConfig.statusBar,
      colors: {
        ...merged.statusBar?.colors,
        ...globalConfig.statusBar?.colors,
        ...projectConfig.statusBar?.colors,
      },
      segments: {
        ...merged.statusBar?.segments,
        ...globalConfig.statusBar?.segments,
        ...projectConfig.statusBar?.segments,
      },
    };
  }
  return merged;
}
