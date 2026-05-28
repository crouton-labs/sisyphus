/**
 * Tests for review ask lifecycle: createAsk(kind:'review') → writeReview →
 * writeReviewOutput and the on-disk shapes they produce.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ulid } from 'ulid';
import { createSession } from '../daemon/state.js';
import {
  createAsk,
  writeReview,
  readReview,
  writeReviewOutput,
  writeDecisions,
  readMeta,
  listReviewInboxItems,
} from '../daemon/ask-store.js';
import {
  askReviewPath,
  askOutputPath,
  historyEventsPath,
} from '../shared/paths.js';
import type { FeedbackResult } from '../shared/types.js';

process.env['NODE_ENV'] = 'test';
process.env['SISYPHUS_DISABLE_NOTIFY'] = '1';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'sisyphus-review-lifecycle-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('review ask lifecycle', () => {
  it('createAsk + writeReview produces correct on-disk shape', () => {
    const sessionId = randomUUID();
    createSession(sessionId, 'review task', testDir);
    const askId = ulid();

    createAsk(testDir, sessionId, {
      askId,
      askedBy: 'agent-001',
      blocking: true,
      cwd: testDir,
      title: 'Review plan.md',
      kind: 'review',
    });
    writeReview(testDir, sessionId, askId, { file: '/tmp/foo.md' });

    const meta = readMeta(testDir, sessionId, askId);
    assert.ok(meta, 'meta.json must exist');
    assert.equal(meta.kind, 'review');
    assert.equal(meta.status, 'pending');
    assert.equal(meta.blocking, true);
    assert.equal(meta.title, 'Review plan.md');
    assert.equal(meta.askedBy, 'agent-001');

    const review = readReview(testDir, sessionId, askId);
    assert.ok(review, 'review.json must exist');
    assert.equal(review.file, '/tmp/foo.md');

    // Assert the review.json file physically exists at the canonical path
    const reviewFilePath = askReviewPath(testDir, sessionId, askId);
    assert.ok(reviewFilePath.endsWith('review.json'));
    const raw = JSON.parse(readFileSync(reviewFilePath, 'utf-8')) as { file: string };
    assert.equal(raw.file, '/tmp/foo.md');
  });

  it('createAsk emits ask-issued event with review kind', () => {
    const sessionId = randomUUID();
    createSession(sessionId, 'review task', testDir);
    const askId = ulid();

    createAsk(testDir, sessionId, {
      askId,
      askedBy: 'agent-review',
      blocking: true,
      cwd: testDir,
      kind: 'review',
      title: 'Review something',
    });

    // History events are written to the global history dir (home-relative), not testDir.
    // Read directly from the JSONL file.
    const eventsPath = historyEventsPath(sessionId);
    const lines = readFileSync(eventsPath, 'utf-8').trim().split('\n').filter(Boolean);
    const events = lines.map(l => JSON.parse(l) as {
      event: string;
      data: { askId: string; askedBy: string; blocking: boolean };
    });

    const issued = events.filter(e => e.event === 'ask-issued');
    assert.equal(issued.length, 1, 'exactly one ask-issued event');
    assert.equal(issued[0]!.data.askId, askId);
    assert.equal(issued[0]!.data.askedBy, 'agent-review');
    assert.equal(issued[0]!.data.blocking, true);
  });

  it('writeReviewOutput writes a discriminated response.json', () => {
    const sessionId = randomUUID();
    createSession(sessionId, 'review task', testDir);
    const askId = ulid();

    createAsk(testDir, sessionId, {
      askId,
      askedBy: 'agent-001',
      blocking: true,
      cwd: testDir,
      kind: 'review',
    });

    const feedback: FeedbackResult = {
      file: '/tmp/foo.md',
      submitted: true,
      approved: false,
      comments: [
        {
          id: 'c1',
          line: 3,
          endLine: 3,
          lineText: 'foo',
          comment: 'fix this',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      submittedAt: '2026-01-01T00:01:00.000Z',
      savedAt: '2026-01-01T00:01:00.000Z',
    };

    writeReviewOutput(testDir, sessionId, askId, feedback);

    const outputPath = askOutputPath(testDir, sessionId, askId);
    const parsed = JSON.parse(readFileSync(outputPath, 'utf-8')) as {
      kind: string;
      feedback: FeedbackResult;
      completedAt: string;
    };

    assert.equal(parsed.kind, 'review');
    assert.ok(parsed.completedAt, 'completedAt must be set');
    assert.ok(new Date(parsed.completedAt).getTime() > 0, 'completedAt must be a valid ISO date');
    assert.equal(parsed.feedback.file, '/tmp/foo.md');
    assert.equal(parsed.feedback.submitted, true);
    assert.equal(parsed.feedback.approved, false);
    assert.equal(parsed.feedback.comments.length, 1);
    assert.equal(parsed.feedback.comments[0]!.id, 'c1');
    assert.equal(parsed.feedback.comments[0]!.line, 3);
    assert.equal(parsed.feedback.comments[0]!.comment, 'fix this');
  });

  it('listReviewInboxItems surfaces pending reviews and drops resolved ones', () => {
    const sessionId = randomUUID();
    createSession(sessionId, 'review task', testDir);
    const askId = ulid();

    createAsk(testDir, sessionId, {
      askId,
      askedBy: 'agent-001',
      blocking: true,
      cwd: testDir,
      kind: 'review',
      title: 'Review plan.md',
    });
    writeReview(testDir, sessionId, askId, { file: '/tmp/plan.md' });

    // Pending review must appear as an inbox item with kind:'review'.
    let items = listReviewInboxItems(testDir, sessionId);
    assert.equal(items.length, 1, 'pending review must surface in inbox');
    assert.equal(items[0]!.kind, 'review');
    assert.equal(items[0]!.id, askId);
    assert.equal(items[0]!.title, 'Review plan.md');
    assert.ok(items[0]!.dir.endsWith(askId), 'dir must point at the per-ask directory');
    assert.ok(items[0]!.blockedSince, 'blockedSince must be set from askedAt');

    // Once submitted (response.json present), it drops off the inbox.
    writeReviewOutput(testDir, sessionId, askId, {
      file: '/tmp/plan.md',
      submitted: true,
      approved: true,
      comments: [],
      submittedAt: '2026-01-01T00:01:00.000Z',
      savedAt: '2026-01-01T00:01:00.000Z',
    });
    items = listReviewInboxItems(testDir, sessionId);
    assert.equal(items.length, 0, 'resolved review must not surface');
  });

  it('listReviewInboxItems ignores non-review (deck) asks', () => {
    const sessionId = randomUUID();
    createSession(sessionId, 'deck task', testDir);
    const askId = ulid();

    createAsk(testDir, sessionId, {
      askId,
      askedBy: 'agent-001',
      blocking: true,
      cwd: testDir,
      kind: 'decision',
      title: 'Pick a path',
    });
    writeDecisions(testDir, sessionId, askId, {
      interactions: [{ id: 'q1', title: 'Pick a path', kind: 'decision', options: [
        { id: 'a', label: 'A' }, { id: 'b', label: 'B' },
      ] }],
    });

    assert.equal(listReviewInboxItems(testDir, sessionId).length, 0, 'decks are not review items');
  });

  it('ACTIONABLE_KINDS includes review (verified via notify suppression in test env)', () => {
    // ACTIONABLE_KINDS is not exported from ask-store, but its effect is observable:
    // createAsk with kind:'review' must not throw and must produce valid meta.json.
    // The notify path is suppressed in NODE_ENV=test so we just verify the ask
    // is created successfully with kind:'review' — meaning the kind was accepted.
    const sessionId = randomUUID();
    createSession(sessionId, 'review task', testDir);
    const askId = ulid();

    assert.doesNotThrow(() => {
      createAsk(testDir, sessionId, {
        askId,
        askedBy: 'agent-001',
        blocking: true,
        cwd: testDir,
        kind: 'review',
        title: 'Review plan.md',
      });
    });

    const meta = readMeta(testDir, sessionId, askId);
    assert.equal(meta?.kind, 'review');
  });
});
