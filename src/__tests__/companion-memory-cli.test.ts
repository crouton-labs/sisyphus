import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { registerCompanion, renderMemory } from '../cli/commands/companion.js';
import { registerCompanionProfile } from '../cli/commands/companion-profile.js';
import { setMemoryPathOverride, loadMemoryStrict } from '../daemon/companion-memory.js';
import { MemoryStoreParseError } from '../shared/companion-types.js';
import type { CompanionMemoryState, ObservationRecord } from '../shared/companion-types.js';

function defaultState(): CompanionMemoryState {
  return { version: 1, observations: [], prunedAt: null, firedDetectors: {} };
}

function makeObs(overrides: Partial<ObservationRecord> = {}): ObservationRecord {
  return {
    id: 'test-id',
    category: 'session-sentiments',
    source: 'rule',
    text: 'test observation',
    repo: '/home/user/sisyphus',
    sessionId: 'sess-1',
    timestamp: '2026-04-08T14:32:01.000Z',
    ...overrides,
  };
}

// ─── Skeleton tests (Phase 4) ─────────────────────────────────────────────────

describe('sisyphus companion CLI (Phase 4 skeleton)', () => {
  it('renderMemory with empty state shows zero total', () => {
    const out = renderMemory(defaultState());
    assert.ok(out.includes('0 observations total'), 'should include 0 observations total');
  });

  it('registers a companion command with a memory subcommand', () => {
    const program = new Command('sisyphus');
    registerCompanion(program);
    const companion = program.commands.find(c => c.name() === 'companion');
    assert.ok(companion, 'companion command should be registered');
    const memory = companion!.commands.find(c => c.name() === 'memory');
    assert.ok(memory, 'companion memory subcommand should be registered');
  });

  it('companion memory subcommand exposes --repo option', () => {
    const program = new Command('sisyphus');
    registerCompanion(program);
    const memory = program.commands
      .find(c => c.name() === 'companion')!
      .commands.find(c => c.name() === 'memory')!;
    const repoOption = memory.options.find(o => o.long === '--repo');
    assert.ok(repoOption, '--repo option should be present on memory subcommand');
  });

  it('bare companion command is a pure parent (no action handler)', () => {
    const program = new Command('sisyphus');
    registerCompanion(program);
    const companion = program.commands.find(c => c.name() === 'companion')!;
    const handler = (companion as unknown as Record<string, unknown>)['_actionHandler'];
    assert.ok(
      typeof handler !== 'function',
      'companion parent command should not have an action handler (spec: pure parent)',
    );
  });

  it('companion profile subcommand registers --name and --badges options', () => {
    const program = new Command('sisyphus');
    registerCompanion(program);
    const companion = program.commands.find(c => c.name() === 'companion')!;
    registerCompanionProfile(companion);
    const profile = companion.commands.find(c => c.name() === 'profile')!;
    assert.ok(profile, 'profile subcommand should be registered');
    const longFlags = profile.options.map(o => o.long);
    assert.ok(longFlags.includes('--name'), '--name should be on companion profile');
    assert.ok(longFlags.includes('--badges'), '--badges should be on companion profile');
  });
});

// ─── renderMemory unit tests ──────────────────────────────────────────────────

describe('renderMemory', () => {
  it('empty store renders four "(none)" sections and 0 observations total', () => {
    const out = renderMemory(defaultState());
    assert.ok(out.includes('Session Sentiments'), 'Session Sentiments header');
    assert.ok(out.includes('Repo Impressions'), 'Repo Impressions header');
    assert.ok(out.includes('User Patterns'), 'User Patterns header');
    assert.ok(out.includes('Notable Moments'), 'Notable Moments header');
    const noneCount = (out.match(/\(none\)/g) ?? []).length;
    assert.equal(noneCount, 4, 'all four sections should show (none)');
    assert.ok(out.includes('0 observations total'), '0 observations total');
    assert.ok(out.includes('last pruned never'), 'last pruned never');
  });

  it('sections render in fixed order', () => {
    const out = renderMemory(defaultState());
    const ssIdx = out.indexOf('Session Sentiments');
    const riIdx = out.indexOf('Repo Impressions');
    const upIdx = out.indexOf('User Patterns');
    const nmIdx = out.indexOf('Notable Moments');
    assert.ok(ssIdx < riIdx, 'Session Sentiments before Repo Impressions');
    assert.ok(riIdx < upIdx, 'Repo Impressions before User Patterns');
    assert.ok(upIdx < nmIdx, 'User Patterns before Notable Moments');
  });

  it('groups observations by category and sorts newest first', () => {
    const state: CompanionMemoryState = {
      ...defaultState(),
      observations: [
        makeObs({ category: 'session-sentiments', text: 'older', timestamp: '2026-04-07T11:00:00.000Z' }),
        makeObs({ category: 'session-sentiments', text: 'newer', timestamp: '2026-04-08T14:00:00.000Z' }),
        makeObs({ category: 'notable-moments', text: 'notable one', timestamp: '2026-04-06T08:00:00.000Z' }),
      ],
    };
    const out = renderMemory(state);
    assert.ok(out.includes('Session Sentiments (2)'), 'session sentiments count');
    assert.ok(out.includes('Notable Moments (1)'), 'notable moments count');
    const newerIdx = out.indexOf('newer');
    const olderIdx = out.indexOf('older');
    assert.ok(newerIdx < olderIdx, 'newest observation first within group');
    // User Patterns should still show (none)
    const upIdx = out.indexOf('User Patterns');
    const noneAfterUp = out.indexOf('(none)', upIdx);
    assert.ok(noneAfterUp > upIdx, 'user patterns shows (none)');
  });

  it('--repo filter includes only matching repos; repo: null entries excluded', () => {
    const state: CompanionMemoryState = {
      ...defaultState(),
      observations: [
        makeObs({ text: 'match', repo: '/projects/myapp' }),
        makeObs({ text: 'no match', repo: '/projects/other' }),
        makeObs({ text: 'null repo', repo: null }),
      ],
    };
    const out = renderMemory(state, '/projects/myapp');
    assert.ok(out.includes('match'), 'matching repo observation included');
    assert.ok(!out.includes('no match'), 'non-matching repo excluded');
    assert.ok(!out.includes('null repo'), 'null repo entry excluded when filtering');
    assert.ok(out.includes('1 observations total'), '1 observation matches filter');
  });

  it('observation with repo: null renders [—]', () => {
    const state: CompanionMemoryState = {
      ...defaultState(),
      observations: [makeObs({ repo: null, text: 'cross-repo obs' })],
    };
    const out = renderMemory(state);
    assert.ok(out.includes('[—]'), 'null repo renders em-dash bracket');
  });

  it('observation text with control characters is sanitized', () => {
    const state: CompanionMemoryState = {
      ...defaultState(),
      observations: [makeObs({ text: 'evil\x1b[31mred\x1b[0m text' })],
    };
    const out = renderMemory(state);
    assert.ok(!out.includes('\x1b'), 'no raw escape sequences in output');
    assert.ok(out.includes('evil'), 'visible text is preserved');
  });

  it('repo basename with control characters is sanitized', () => {
    const state: CompanionMemoryState = {
      ...defaultState(),
      observations: [makeObs({ repo: '/projects/evil\x1brepo', text: 'sanitize repo test' })],
    };
    const out = renderMemory(state);
    assert.ok(!out.includes('\x1b'), 'no raw escape sequences from repo basename');
  });

  it('prunedAt date is shown when present', () => {
    const state: CompanionMemoryState = {
      ...defaultState(),
      prunedAt: '2026-03-15T10:00:00.000Z',
    };
    const out = renderMemory(state);
    assert.ok(out.includes('last pruned 2026-03-15'), 'prunedAt date shown');
  });
});

// ─── loadMemoryStrict integration tests (verifies runCompanionMemory error path) ──

describe('loadMemoryStrict (corrupt store path)', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'companion-memory-cli-test-'));
  });

  after(() => {
    setMemoryPathOverride(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    setMemoryPathOverride(null);
  });

  it('corrupt store throws MemoryStoreParseError (runCompanionMemory catches and exits 1)', () => {
    const corruptPath = join(tmpDir, 'corrupt.json');
    writeFileSync(corruptPath, 'not valid json', 'utf-8');
    setMemoryPathOverride(corruptPath);

    assert.throws(
      () => loadMemoryStrict(),
      (err: unknown) => err instanceof MemoryStoreParseError,
      'loadMemoryStrict throws MemoryStoreParseError on corrupt file',
    );
  });

  it('missing file returns default state (no error)', () => {
    const missingPath = join(tmpDir, 'nonexistent.json');
    setMemoryPathOverride(missingPath);
    const state = loadMemoryStrict();
    assert.equal(state.observations.length, 0, 'default state has no observations');
    assert.equal(state.prunedAt, null, 'default state has null prunedAt');
  });
});
