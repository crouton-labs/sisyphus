/**
 * Tests for review draft-resumability semantics.
 * Simulates what humanloop writes to disk between popup opens — no nvim, no tmux.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ulid } from 'ulid';
import { createSession } from '../daemon/state.js';
import { createAsk, writeReview, writeReviewOutput, readMeta } from '../daemon/ask-store.js';
import {
  askReviewDraftPath,
  askReviewSubmitFlagPath,
  askOutputPath,
  askEntryDir,
} from '../shared/paths.js';
import type { FeedbackResult } from '../shared/types.js';

process.env['NODE_ENV'] = 'test';
process.env['SISYPHUS_DISABLE_NOTIFY'] = '1';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'sisyphus-review-draft-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('review draft resume', () => {
  it('draft.json with submitted:false survives across reads', () => {
    const sessionId = randomUUID();
    createSession(sessionId, 'draft task', testDir);
    const askId = ulid();

    createAsk(testDir, sessionId, {
      askId,
      askedBy: 'agent-001',
      blocking: true,
      cwd: testDir,
      kind: 'review',
    });

    // Simulate what humanloop's vimscript s:Save() writes on <Space>c or VimLeavePre
    const draft = {
      file: '/tmp/plan.md',
      submitted: false,
      approved: false,
      comments: [
        {
          id: 'c1',
          line: 5,
          endLine: 5,
          lineText: 'x',
          comment: 'note',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      savedAt: '2026-01-01T00:00:00.000Z',
    };
    const draftPath = askReviewDraftPath(testDir, sessionId, askId);
    writeFileSync(draftPath, JSON.stringify(draft), 'utf-8');

    // Read back — simulates s:Load() on next popup open
    const restored = JSON.parse(readFileSync(draftPath, 'utf-8')) as typeof draft;
    assert.equal(restored.submitted, false);
    assert.equal(restored.comments.length, 1);
    assert.equal(restored.comments[0]!.id, 'c1');
    assert.equal(restored.comments[0]!.line, 5);
    assert.equal(restored.comments[0]!.comment, 'note');
  });

  it('reviewSubmit flow: draft.json has comments, response.json gets submitted:true with same comments', () => {
    const sessionId = randomUUID();
    createSession(sessionId, 'submit task', testDir);
    const askId = ulid();

    createAsk(testDir, sessionId, {
      askId,
      askedBy: 'agent-001',
      blocking: true,
      cwd: testDir,
      kind: 'review',
    });
    writeReview(testDir, sessionId, askId, { file: '/tmp/foo.md' });

    // Write a draft with 2 comments and submitted:false
    const comments = [
      {
        id: 'd1',
        line: 10,
        endLine: 10,
        lineText: 'bad code',
        comment: 'refactor this',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'd2',
        line: 22,
        endLine: 23,
        lineText: 'another line',
        comment: 'nit: rename',
        createdAt: '2026-01-01T00:01:00.000Z',
      },
    ];
    const draftPath = askReviewDraftPath(testDir, sessionId, askId);
    writeFileSync(draftPath, JSON.stringify({
      file: '/tmp/foo.md',
      submitted: false,
      approved: false,
      comments,
      savedAt: '2026-01-01T00:00:00.000Z',
    }), 'utf-8');

    // Simulate sis ask review-submit: read draft, finalize with submitted:true
    const rawDraft = JSON.parse(readFileSync(draftPath, 'utf-8')) as {
      file: string;
      comments: typeof comments;
    };
    const now = new Date().toISOString();
    const finalized: FeedbackResult = {
      file: rawDraft.file,
      submitted: true,
      approved: false,
      comments: rawDraft.comments,
      submittedAt: now,
      savedAt: now,
    };
    writeReviewOutput(testDir, sessionId, askId, finalized);

    // Assert response.json has the review discriminant and both comments
    const outputPath = askOutputPath(testDir, sessionId, askId);
    const parsed = JSON.parse(readFileSync(outputPath, 'utf-8')) as {
      kind: string;
      feedback: FeedbackResult;
      completedAt: string;
    };

    assert.equal(parsed.kind, 'review');
    assert.equal(parsed.feedback.submitted, true);
    assert.equal(parsed.feedback.approved, false);
    assert.equal(parsed.feedback.comments.length, 2);
    assert.equal(parsed.feedback.comments[0]!.id, 'd1');
    assert.equal(parsed.feedback.comments[1]!.id, 'd2');
    assert.ok(parsed.completedAt);
  });

  it('submitFlagPath is scoped to the per-ask directory', () => {
    // Humanloop's launchReview writes this file on explicit <Space>s;
    // sisyphus's review-open uses its presence to gate submission.
    const sessionId = randomUUID();
    createSession(sessionId, 'flag task', testDir);
    const askId1 = ulid();
    const askId2 = ulid();

    createAsk(testDir, sessionId, {
      askId: askId1,
      askedBy: 'agent-001',
      blocking: true,
      cwd: testDir,
      kind: 'review',
    });
    createAsk(testDir, sessionId, {
      askId: askId2,
      askedBy: 'agent-001',
      blocking: true,
      cwd: testDir,
      kind: 'review',
    });

    const flagPath1 = askReviewSubmitFlagPath(testDir, sessionId, askId1);
    const flagPath2 = askReviewSubmitFlagPath(testDir, sessionId, askId2);

    // Each ask gets its own flag path ending in 'submitted'
    assert.ok(flagPath1.endsWith('submitted'), 'flag path must end with "submitted"');
    assert.ok(flagPath2.endsWith('submitted'), 'flag path must end with "submitted"');

    // Flags live inside the per-ask directory — scoped, no collision across asks
    const entryDir1 = askEntryDir(testDir, sessionId, askId1);
    const entryDir2 = askEntryDir(testDir, sessionId, askId2);
    assert.ok(flagPath1.startsWith(entryDir1), 'ask1 flag must be inside ask1 dir');
    assert.ok(flagPath2.startsWith(entryDir2), 'ask2 flag must be inside ask2 dir');
    assert.notEqual(flagPath1, flagPath2, 'flags for different asks must not collide');
  });
});
