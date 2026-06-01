import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  agentPluginLayers,
  mergeHookManifests,
  collectReferencedHookScripts,
  collectDisabledHookScripts,
  copyLayered,
  copySkill,
  indexAvailableSkills,
  renderLayeredPluginDir,
  type PluginLayer,
} from '../daemon/extensions.js';

// Minimal manifest builder ─ always wraps groups under `hooks.<event>`.
function manifest(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function writeManifest(layerRoot: string, body: Record<string, unknown>): void {
  mkdirSync(join(layerRoot, 'hooks'), { recursive: true });
  writeFileSync(join(layerRoot, 'hooks', 'hooks.json'), manifest(body), 'utf-8');
}

describe('mergeHookManifests', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sisyphus-ext-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('filters by agentType, retaining only matching groups', () => {
    const bundled = join(tmp, 'bundled');
    mkdirSync(bundled, { recursive: true });
    writeManifest(bundled, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            agentTypes: ['plan'],
            hooks: [{ type: 'command', command: 'bash ${CLAUDE_PLUGIN_ROOT}/hooks/plan.sh' }],
          },
          {
            matcher: 'Bash',
            agentTypes: ['all'],
            hooks: [{ type: 'command', command: 'bash ${CLAUDE_PLUGIN_ROOT}/hooks/global.sh' }],
          },
          {
            matcher: 'Bash',
            agentTypes: ['review'],
            hooks: [{ type: 'command', command: 'bash ${CLAUDE_PLUGIN_ROOT}/hooks/review.sh' }],
          },
        ],
      },
    });

    const layers: PluginLayer[] = [{ source: 'bundled', root: bundled }];
    const merged = mergeHookManifests(layers, { agentType: 'plan', interactive: false });
    const cmds = (merged.PreToolUse ?? []).flatMap(g => g.hooks.map(h => h.command));
    assert.ok(cmds.some(c => c.endsWith('/plan.sh')));
    assert.ok(cmds.some(c => c.endsWith('/global.sh')));
    assert.ok(!cmds.some(c => c.endsWith('/review.sh')));
  });

  it('drops non-interactive condition entries when agent is interactive', () => {
    const bundled = join(tmp, 'bundled');
    mkdirSync(bundled, { recursive: true });
    writeManifest(bundled, {
      hooks: {
        Stop: [
          {
            agentTypes: ['all'],
            condition: 'non-interactive',
            hooks: [{ type: 'command', command: 'bash ${CLAUDE_PLUGIN_ROOT}/hooks/require-submit.sh' }],
          },
        ],
      },
    });
    const layers: PluginLayer[] = [{ source: 'bundled', root: bundled }];

    const interactive = mergeHookManifests(layers, { agentType: 'plan', interactive: true });
    assert.equal(interactive.Stop, undefined, 'Stop should be dropped when interactive');

    const nonInteractive = mergeHookManifests(layers, { agentType: 'plan', interactive: false });
    assert.equal(nonInteractive.Stop?.length, 1);
  });

  it('honors disable list across layers by script basename', () => {
    const bundled = join(tmp, 'bundled');
    const project = join(tmp, 'project');
    mkdirSync(bundled, { recursive: true });
    mkdirSync(project, { recursive: true });

    writeManifest(bundled, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            agentTypes: ['plan'],
            hooks: [{ type: 'command', command: 'bash ${CLAUDE_PLUGIN_ROOT}/hooks/plan-validate.sh' }],
          },
        ],
      },
    });
    writeManifest(project, { disable: ['plan-validate.sh'] });

    const layers: PluginLayer[] = [
      { source: 'project', root: project },
      { source: 'bundled', root: bundled },
    ];
    const merged = mergeHookManifests(layers, { agentType: 'plan', interactive: false });
    const cmds = (merged.PreToolUse ?? []).flatMap(g => g.hooks.map(h => h.command));
    assert.ok(!cmds.some(c => c.endsWith('/plan-validate.sh')), 'plan-validate.sh should be suppressed');
  });

  it('strips agentTypes/condition fields from emitted hook groups', () => {
    const bundled = join(tmp, 'bundled');
    mkdirSync(bundled, { recursive: true });
    writeManifest(bundled, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            agentTypes: ['all'],
            condition: 'non-interactive',
            hooks: [{ type: 'command', command: 'bash hooks/x.sh' }],
          },
        ],
      },
    });
    const layers: PluginLayer[] = [{ source: 'bundled', root: bundled }];
    const merged = mergeHookManifests(layers, { agentType: 'plan', interactive: false });
    const group = merged.PreToolUse![0]!;
    assert.equal((group as unknown as Record<string, unknown>).agentTypes, undefined);
    assert.equal((group as unknown as Record<string, unknown>).condition, undefined);
    assert.equal(group.matcher, 'Bash');
  });
});

describe('collectReferencedHookScripts', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'sisyphus-ext-test-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns only scripts the filtered manifest references', () => {
    const bundled = join(tmp, 'bundled');
    mkdirSync(bundled, { recursive: true });
    writeManifest(bundled, {
      hooks: {
        UserPromptSubmit: [
          { agentTypes: ['plan'], hooks: [{ type: 'command', command: 'bash ${CLAUDE_PLUGIN_ROOT}/hooks/plan-prompt.sh' }] },
          { agentTypes: ['review'], hooks: [{ type: 'command', command: 'bash ${CLAUDE_PLUGIN_ROOT}/hooks/review-prompt.sh' }] },
        ],
      },
    });
    const layers: PluginLayer[] = [{ source: 'bundled', root: bundled }];

    const planScripts = collectReferencedHookScripts(layers, { agentType: 'plan', interactive: false });
    assert.ok(planScripts.has('plan-prompt.sh'));
    assert.ok(!planScripts.has('review-prompt.sh'));
  });
});

describe('copyLayered', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'sisyphus-ext-test-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('copies higher-priority files first and skips lower-priority duplicates', () => {
    const project = join(tmp, 'project');
    const bundled = join(tmp, 'bundled');
    mkdirSync(join(project, 'hooks'), { recursive: true });
    mkdirSync(join(bundled, 'hooks'), { recursive: true });

    writeFileSync(join(project, 'hooks', 'shared.sh'), 'PROJECT', 'utf-8');
    writeFileSync(join(bundled, 'hooks', 'shared.sh'), 'BUNDLED', 'utf-8');
    writeFileSync(join(bundled, 'hooks', 'only-bundled.sh'), 'ONLY', 'utf-8');

    const layers: PluginLayer[] = [
      { source: 'project', root: project },
      { source: 'bundled', root: bundled },
    ];
    const dest = join(tmp, 'out');
    copyLayered(layers, { subdir: 'hooks', destDir: dest });

    assert.equal(readFileSync(join(dest, 'shared.sh'), 'utf-8'), 'PROJECT');
    assert.equal(readFileSync(join(dest, 'only-bundled.sh'), 'utf-8'), 'ONLY');
  });

  it('honors skipFiles set', () => {
    const bundled = join(tmp, 'bundled');
    mkdirSync(join(bundled, 'hooks'), { recursive: true });
    writeFileSync(join(bundled, 'hooks', 'a.sh'), 'A', 'utf-8');
    writeFileSync(join(bundled, 'hooks', 'b.sh'), 'B', 'utf-8');

    const layers: PluginLayer[] = [{ source: 'bundled', root: bundled }];
    const dest = join(tmp, 'out');
    copyLayered(layers, { subdir: 'hooks', destDir: dest, skipFiles: new Set(['a.sh']) });

    assert.equal(existsSync(join(dest, 'a.sh')), false);
    assert.equal(existsSync(join(dest, 'b.sh')), true);
  });
});

describe('copySkill / indexAvailableSkills', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'sisyphus-ext-test-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('resolves a skill across layers with override', () => {
    const project = join(tmp, 'project');
    const bundled = join(tmp, 'bundled');
    mkdirSync(join(project, 'skills', 'my-skill'), { recursive: true });
    mkdirSync(join(bundled, 'skills', 'my-skill'), { recursive: true });
    mkdirSync(join(bundled, 'skills', 'other-skill'), { recursive: true });
    writeFileSync(join(project, 'skills', 'my-skill', 'SKILL.md'), 'PROJECT_SKILL', 'utf-8');
    writeFileSync(join(bundled, 'skills', 'my-skill', 'SKILL.md'), 'BUNDLED_SKILL', 'utf-8');
    writeFileSync(join(bundled, 'skills', 'other-skill', 'SKILL.md'), 'OTHER', 'utf-8');

    const layers: PluginLayer[] = [
      { source: 'project', root: project },
      { source: 'bundled', root: bundled },
    ];

    const index = indexAvailableSkills(layers);
    assert.equal(index.size, 2);
    assert.ok(index.get('my-skill')!.startsWith(project), 'project layer should win');

    const dest = join(tmp, 'out');
    mkdirSync(dest, { recursive: true });
    assert.ok(copySkill(layers, 'my-skill', dest));
    assert.equal(readFileSync(join(dest, 'my-skill', 'SKILL.md'), 'utf-8'), 'PROJECT_SKILL');

    assert.equal(copySkill(layers, 'no-such-skill', dest), false);
  });
});

describe('renderLayeredPluginDir', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'sisyphus-ext-test-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('overlays project files over bundled, copies non-md verbatim, renders md', () => {
    const project = join(tmp, 'project');
    const bundled = join(tmp, 'bundled');
    mkdirSync(join(project, 'commands', 'sisyphus'), { recursive: true });
    mkdirSync(join(bundled, 'commands', 'sisyphus'), { recursive: true });
    mkdirSync(join(bundled, 'hooks'), { recursive: true });

    writeFileSync(join(project, 'commands', 'sisyphus', 'cmd.md'), '# project', 'utf-8');
    writeFileSync(join(bundled, 'commands', 'sisyphus', 'cmd.md'), '# bundled', 'utf-8');
    writeFileSync(join(bundled, 'commands', 'sisyphus', 'only.md'), '# only', 'utf-8');
    writeFileSync(join(bundled, 'hooks', 'gate.sh'), '#!/bin/sh', 'utf-8');

    const layers: PluginLayer[] = [
      { source: 'project', root: project },
      { source: 'bundled', root: bundled },
    ];
    const dest = join(tmp, 'rendered');
    renderLayeredPluginDir(layers, dest, 'high');

    assert.equal(readFileSync(join(dest, 'commands', 'sisyphus', 'cmd.md'), 'utf-8'), '# project');
    assert.equal(readFileSync(join(dest, 'commands', 'sisyphus', 'only.md'), 'utf-8'), '# only');
    assert.equal(readFileSync(join(dest, 'hooks', 'gate.sh'), 'utf-8'), '#!/bin/sh');
  });
});

describe('regression: bundled hooks.json reproduces pre-refactor behavior', () => {
  // The bundled manifest at templates/agent-plugin/hooks/hooks.json is the
  // mechanical translation of the previous hardcoded createAgentPlugin map.
  // For each known agent type, the merged output should contain the same
  // commands the old code produced.
  const repoRoot = join(import.meta.dirname, '..', '..');
  const bundledRoot = join(repoRoot, 'templates', 'agent-plugin');
  const layers: PluginLayer[] = [{ source: 'bundled', root: bundledRoot }];

  function commandsFor(agentType: string, interactive: boolean): Record<string, string[]> {
    const merged = mergeHookManifests(layers, { agentType, interactive });
    const out: Record<string, string[]> = {};
    for (const [event, groups] of Object.entries(merged)) {
      out[event] = groups.flatMap(g => g.hooks.map(h => h.command));
    }
    return out;
  }

  it('plan agent gets all expected hooks', () => {
    const cmds = commandsFor('plan', false);
    assert.ok(cmds.PreToolUse?.some(c => c.endsWith('/intercept-send-message.sh')));
    assert.ok(cmds.PreToolUse?.some(c => c.endsWith('/ask-background-guard.sh')));
    assert.ok(cmds.PreToolUse?.some(c => c.endsWith('/plan-validate.sh')));
    assert.ok(cmds.PreToolUse?.some(c => c.endsWith('/plan-write-path.sh')));
    assert.ok(cmds.PostToolUse?.some(c => c.endsWith('/register-bg-task.sh')));
    assert.ok(cmds.Stop?.some(c => c.endsWith('/require-submit.sh')));
    assert.ok(cmds.UserPromptSubmit?.some(c => c.endsWith('/plan-user-prompt.sh')));
  });

  it('review agent does NOT get plan-specific hooks', () => {
    const cmds = commandsFor('review', false);
    assert.ok(cmds.UserPromptSubmit?.some(c => c.endsWith('/review-user-prompt.sh')));
    assert.ok(!cmds.PreToolUse?.some(c => c.endsWith('/plan-validate.sh')));
    assert.ok(!cmds.PreToolUse?.some(c => c.endsWith('/plan-write-path.sh')));
  });

  it('interactive agents drop the require-submit Stop hook', () => {
    const cmds = commandsFor('plan', true);
    assert.equal(cmds.Stop, undefined);
  });

  it('explore agent gets explore-user-prompt.sh', () => {
    const cmds = commandsFor('explore', false);
    assert.ok(cmds.UserPromptSubmit?.some(c => c.endsWith('/explore-user-prompt.sh')));
  });

  it('agents without a user-prompt hook entry omit UserPromptSubmit', () => {
    const cmds = commandsFor('implementor', false);
    assert.equal(cmds.UserPromptSubmit, undefined);
  });
});

describe('agentPluginLayers', () => {
  it('always includes bundled layer when templates/ exists in the repo', () => {
    const repoRoot = join(import.meta.dirname, '..', '..');
    const layers = agentPluginLayers(repoRoot);
    const bundled = layers.find(l => l.source === 'bundled');
    assert.ok(bundled, 'bundled layer should be present when run from repo');
    assert.ok(bundled!.root.endsWith('agent-plugin'));
  });
});

// Sanity: ensure homedir() is referenced — silences lint about unused imports
// in ESM environments where the import is required for type hoisting.
describe('extensions module shape', () => {
  it('export surface is stable', () => {
    assert.equal(typeof homedir, 'function');
    assert.equal(typeof collectDisabledHookScripts, 'function');
  });
});
