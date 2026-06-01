import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildModeTransitionCommentary } from '../daemon/mode-transition.js';

let testDir: string;

before(() => {
  testDir = mkdtempSync(join(tmpdir(), 'sisyphus-mode-transition-test-'));
});

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('buildModeTransitionCommentary', () => {
  it('puts "Starting <Mode>" in the popup border title', () => {
    const { popupTitle } = buildModeTransitionCommentary(testDir, 'discovery', 'implementation', {
      cycles: 3,
      activeMs: 24 * 60 * 1000,
    });
    assert.equal(popupTitle, ' Starting Implementation ');
  });

  it('includes the new mode and the prev-mode stats in the commentary context', () => {
    const { context } = buildModeTransitionCommentary(testDir, 'discovery', 'implementation', {
      cycles: 3,
      activeMs: 24 * 60 * 1000,
    });
    assert.ok(context.includes('Implementation'), 'context names the new mode');
    assert.ok(/Discovery: 3 cycles · 24m active/.test(context), 'context reports prev-mode cycle count + duration');
  });

  it('uses singular "cycle" and second-resolution for short prev-mode segments', () => {
    const { context } = buildModeTransitionCommentary(testDir, 'planning', 'implementation', {
      cycles: 1,
      activeMs: 45 * 1000,
    });
    assert.ok(/Planning: 1 cycle\b/.test(context), 'singular cycle label');
    assert.ok(/45s active/.test(context), 'sub-minute durations render as seconds');
  });
});
