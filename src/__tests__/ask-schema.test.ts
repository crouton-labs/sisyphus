import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDeck } from '../shared/ask-schema.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'ask-schema-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const baseInteraction = {
  id: 'q1',
  title: 'Do you approve?',
  options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
};

function writeDeck(name: string, deck: object): string {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify({ title: 'Test deck', ...deck }), 'utf-8');
  return path;
}

// deck title is required by humanloop
it('rejects deck without a title', () => {
  const path = join(tmp, 'missing-deck-title.json');
  writeFileSync(path, JSON.stringify({ interactions: [baseInteraction] }), 'utf-8');
  assert.throws(() => parseDeck(path), /title/);
});

// recipe §1.5.a — missing title rejected (title is required in v2)
it('1.5.a: rejects interaction with empty title', () => {
  const path = writeDeck('a.json', {
    interactions: [{ ...baseInteraction, title: '' }],
  });
  assert.throws(() => parseDeck(path), /title/);
});

// recipe §1.5.b — empty subtitle rejected
it('1.5.b: rejects empty subtitle', () => {
  const path = writeDeck('b.json', {
    interactions: [{ ...baseInteraction, subtitle: '' }],
  });
  assert.throws(() => parseDeck(path), /subtitle/);
});

// recipe §1.5.c — body+bodyPath mutually exclusive
it('1.5.c: rejects both body and bodyPath set', () => {
  writeFileSync(join(tmp, 'b.md'), ':::panel\nx\n:::\n', 'utf-8');
  const path = writeDeck('c.json', {
    interactions: [{ ...baseInteraction, body: ':::panel\nx\n:::\n', bodyPath: './b.md' }],
  });
  assert.throws(() => parseDeck(path), /mutually exclusive/);
});

// recipe §1.5.d — missing bodyPath
it('1.5.d: rejects missing bodyPath file', () => {
  const path = writeDeck('d.json', {
    interactions: [{ ...baseInteraction, bodyPath: './nope.md' }],
  });
  assert.throws(() => parseDeck(path), /bodyPath/);
});

// recipe §1.5.e — body fails humanloop's checkMarkdown (wraps the directive renderer)
it('1.5.e: rejects body failing directive check', () => {
  const path = writeDeck('e.json', {
    interactions: [{ ...baseInteraction, body: ':::panel\nhi' }],
  });
  // humanloop prefixes renderer errors with "termrender: …" — match that source-of-truth string.
  assert.throws(() => parseDeck(path), /termrender/);
});

// recipe §1.5.f — duplicate ids
it('1.5.f: rejects duplicate interaction ids', () => {
  const path = writeDeck('f.json', {
    interactions: [
      { id: 'dup', title: 'First', options: [] },
      { id: 'dup', title: 'Second', options: [] },
    ],
  });
  assert.throws(() => parseDeck(path), /duplicate.*dup|dup.*duplicate/);
});

// recipe §1.5.g — invalid kind value
it('1.5.g: rejects invalid kind value', () => {
  const path = writeDeck('g.json', {
    interactions: [{ ...baseInteraction, kind: 'mystery' }],
  });
  assert.throws(() => parseDeck(path), /kind/);
});

// recipe §1.10 — bodyPath escape via ../../
it('1.10: rejects bodyPath that escapes deck dir via ../', () => {
  const outside = mkdtempSync(join(tmpdir(), 'ask-outside-'));
  try {
    const target = join(outside, 'secret.txt');
    writeFileSync(target, 'SECRET', 'utf-8');
    const rel = join('..', outside.split('/').pop()!, 'secret.txt');
    const path = writeDeck('escape.json', {
      interactions: [{ ...baseInteraction, bodyPath: rel }],
    });
    assert.throws(() => parseDeck(path), /escape|outside/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

// symlink case — bodyPath is a symlink
it('1.10b: rejects bodyPath symlink pointing outside deck dir', () => {
  const outside = mkdtempSync(join(tmpdir(), 'ask-outside-'));
  try {
    const realTarget = join(outside, 'secret.txt');
    writeFileSync(realTarget, 'SECRET', 'utf-8');
    const linkPath = join(tmp, 'evil.md');
    symlinkSync(realTarget, linkPath);
    const path = writeDeck('symlink.json', {
      interactions: [{ ...baseInteraction, bodyPath: './evil.md' }],
    });
    assert.throws(() => parseDeck(path), /regular file|escape|outside/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

// directory case — bodyPath is a directory
it('1.10c: rejects bodyPath that is a directory', () => {
  mkdirSync(join(tmp, 'somedir'));
  const path = writeDeck('dir.json', {
    interactions: [{ ...baseInteraction, bodyPath: './somedir' }],
  });
  assert.throws(() => parseDeck(path), /regular file/);
});

// happy path — bodyPath inlined into body, bodyPath dropped
it('1.8: bodyPath is inlined into body and dropped from output', () => {
  const token = 'BODY_TOKEN_' + Math.random().toString(36).slice(2);
  writeFileSync(join(tmp, 'body.md'), `:::panel\n${token}\n:::\n`, 'utf-8');
  const path = writeDeck('happy.json', {
    interactions: [{ ...baseInteraction, bodyPath: './body.md' }],
  });
  const result = parseDeck(path);
  assert.match(result.interactions[0].body!, new RegExp(token));
  assert.equal((result.interactions[0] as unknown as Record<string, unknown>).bodyPath, undefined);
});

// empty interactions array rejected
it('rejects empty interactions array', () => {
  const path = writeDeck('empty.json', {
    interactions: [],
  });
  assert.throws(() => parseDeck(path), /interactions/);
});
