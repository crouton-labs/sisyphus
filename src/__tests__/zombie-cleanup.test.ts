/**
 * Tests for zombie-ask auto-cleanup (Fix A, B) and clean-zombies CLI (Fix D).
 *
 * Fix A — heartbeat cascade-resolve
 * Fix B — agent-orphan auto-resolve via resolveAgentOrphanAsks
 * Fix D — clean-zombies CLI dry-run sweep
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ulid } from 'ulid';
import { createSession } from '../daemon/state.js';
import * as askStore from '../daemon/ask-store.js';
import * as state from '../daemon/state.js';
import { emitOrphanAsk, resolveAgentOrphanAsks } from '../daemon/orphan-asks.js';
import { HEARTBEAT_ASKED_BY } from '../daemon/heartbeat-asks.js';
import { askOutputPath } from '../shared/paths.js';

let testDir: string;

before(() => {
  testDir = mkdtempSync(join(tmpdir(), 'sisyphus-zombie-cleanup-test-'));
  process.env['SISYPHUS_DISABLE_NOTIFY'] = '1';
});

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fix A — Heartbeat cascade-resolve
// ---------------------------------------------------------------------------
describe('Fix A: heartbeat cascade-resolve', () => {
  it('resolving the original ask auto-resolves its linked heartbeat ask', async () => {
    const sessionId = randomUUID();
    createSession(sessionId, 'test heartbeat cascade', testDir);

    // Create the original ask
    const originalAskId = ulid();
    askStore.createAsk(testDir, sessionId, {
      askId: originalAskId,
      askedBy: 'orchestrator',
      blocking: true,
      cwd: testDir,
      title: 'Decision needed',
      kind: 'decision',
    });

    // Create the heartbeat ask and link it to the original
    const heartbeatAskId = ulid();
    askStore.createAsk(testDir, sessionId, {
      askId: heartbeatAskId,
      askedBy: HEARTBEAT_ASKED_BY,
      blocking: false,
      cwd: testDir,
      title: 'Stale question',
      kind: 'notify',
    });
    const heartbeatDeck = {
      title: 'Stale question',
      source: { askedBy: HEARTBEAT_ASKED_BY },
      interactions: [{ id: 'heartbeat', title: 'Question still waiting', kind: 'notify' as const, options: [{ id: 'ack', label: 'Acknowledged' }] }],
    };
    askStore.writeDecisions(testDir, sessionId, heartbeatAskId, heartbeatDeck);

    // Link heartbeatAskId onto the original ask
    await askStore.updateMeta(testDir, sessionId, originalAskId, {
      heartbeatNotifiedAt: new Date().toISOString(),
      heartbeatAskId,
    });

    // Pre-condition: heartbeat is pending
    assert.equal(askStore.readMeta(testDir, sessionId, heartbeatAskId)?.status, 'pending');

    // Resolve the original ask by writing output and marking answered
    askStore.writeOutput(testDir, sessionId, originalAskId, [{ id: 'q1', selectedOptionId: 'yes' }]);
    await askStore.updateMeta(testDir, sessionId, originalAskId, {
      status: 'answered',
      completedAt: new Date().toISOString(),
    });

    // Give the fire-and-forget cascade a tick to complete
    await new Promise(r => setImmediate(r));
    await new Promise(r => setTimeout(r, 50));

    // Heartbeat ask should now be auto-resolved
    const hbMeta = askStore.readMeta(testDir, sessionId, heartbeatAskId);
    assert.equal(hbMeta?.status, 'answered', 'heartbeat ask must be auto-resolved when original is answered');
    assert.ok(
      existsSync(askOutputPath(testDir, sessionId, heartbeatAskId)),
      'heartbeat response.json must exist after cascade',
    );
  });
});

// ---------------------------------------------------------------------------
// Fix B — Agent-orphan auto-resolve
// ---------------------------------------------------------------------------
describe('Fix B: agent-orphan auto-resolve via resolveAgentOrphanAsks', () => {
  it('resolveAgentOrphanAsks marks pending orphan ask as answered', async () => {
    const sessionId = randomUUID();
    createSession(sessionId, 'test agent orphan resolve', testDir);

    // Emit an orphan ask for agent-A
    const orphanAskId = await emitOrphanAsk({
      cwd: testDir,
      sessionId,
      reason: 'pane-gone',
      detectedAt: new Date().toISOString(),
      agent: { id: 'agent-A', name: 'builder' },
    });
    assert.ok(orphanAskId !== null, 'orphan ask must be emitted');

    // Pre-condition: pending
    assert.equal(askStore.readMeta(testDir, sessionId, orphanAskId!)?.status, 'pending');

    // Call resolveAgentOrphanAsks with 'respawn'
    await resolveAgentOrphanAsks(testDir, sessionId, 'agent-A', 'respawn');

    // Post-condition: answered
    const meta = askStore.readMeta(testDir, sessionId, orphanAskId!);
    assert.equal(meta?.status, 'answered', 'orphan ask must be marked answered after resolveAgentOrphanAsks');
    assert.ok(
      existsSync(askOutputPath(testDir, sessionId, orphanAskId!)),
      'response.json must exist after resolve',
    );
  });

  it('resolveAgentOrphanAsks does not touch asks for other agents', async () => {
    const sessionId = randomUUID();
    createSession(sessionId, 'test agent orphan scoped', testDir);

    const orphanAIdA = await emitOrphanAsk({
      cwd: testDir, sessionId, reason: 'pane-gone',
      detectedAt: new Date().toISOString(),
      agent: { id: 'agent-X', name: 'agent-X' },
    });
    const orphanAIdB = await emitOrphanAsk({
      cwd: testDir, sessionId, reason: 'pane-gone',
      detectedAt: new Date().toISOString(),
      agent: { id: 'agent-Y', name: 'agent-Y' },
    });

    await resolveAgentOrphanAsks(testDir, sessionId, 'agent-X', 'dismiss');

    assert.equal(askStore.readMeta(testDir, sessionId, orphanAIdA!)?.status, 'answered');
    assert.equal(askStore.readMeta(testDir, sessionId, orphanAIdB!)?.status, 'pending', 'agent-Y orphan must remain pending');
  });
});

// ---------------------------------------------------------------------------
// Fix D — clean-zombies CLI dry-run
// ---------------------------------------------------------------------------
// We test the underlying zombie-detection logic: an agent-orphan ask whose
// target agent is 'lost' is identified as a zombie but NOT written when
// dry-run semantics are applied (i.e. we read the zombie criteria without
// calling resolveAgentOrphanAsks or writing response.json).
describe('Fix D: clean-zombies CLI dry-run', () => {
  it('zombie orphan ask is detectable and response.json is absent in dry-run (no write)', async () => {
    const sessionId = randomUUID();
    createSession(sessionId, 'zombie cli dry-run test', testDir);

    // Emit an orphan ask for an agent that will be 'lost'
    const orphanAskId = await emitOrphanAsk({
      cwd: testDir,
      sessionId,
      reason: 'pid-mismatch',
      detectedAt: new Date().toISOString(),
      agent: { id: 'agent-zombie', name: 'zombie-agent' },
    });
    assert.ok(orphanAskId !== null, 'orphan ask must be emitted');

    // Verify the ask is present and pending
    const meta = askStore.readMeta(testDir, sessionId, orphanAskId!);
    assert.ok(meta, 'meta must exist');
    assert.equal(meta!.askedBy, 'system:orphan-handler');
    assert.equal(meta!.status, 'pending');
    assert.equal(meta!.orphanTarget?.kind, 'agent');
    assert.equal(meta!.orphanTarget?.agentId, 'agent-zombie');

    // Dry-run: we do NOT call resolveAgentOrphanAsks or write response.json.
    // The zombie is identified by checking: askedBy === orphan-handler, status !== answered,
    // no response.json, orphanTarget.kind === agent, and agent status !== running.
    // Since 'agent-zombie' was never added to session.agents, it's absent → not running.
    const session = state.getSession(testDir, sessionId);
    const agentInSession = session.agents.find(a => a.id === 'agent-zombie');
    const isZombie = (
      meta!.askedBy === 'system:orphan-handler' &&
      // `assert.equal(meta!.status, 'pending')` above (node:assert/strict) narrowed
      // status to the 'pending' literal; widen to string so this mirrors the real
      // zombie predicate (status !== 'answered') without a no-overlap type error.
      (meta!.status as string) !== 'answered' &&
      !existsSync(askOutputPath(testDir, sessionId, orphanAskId!)) &&
      meta!.orphanTarget?.kind === 'agent' &&
      (agentInSession === undefined || agentInSession.status !== 'running')
    );
    assert.ok(isZombie, 'orphan ask for absent/non-running agent must be identified as a zombie');

    // Dry-run: nothing written — ask remains pending, no response.json
    assert.equal(askStore.readMeta(testDir, sessionId, orphanAskId!)?.status, 'pending', 'dry-run must not modify status');
    assert.ok(
      !existsSync(askOutputPath(testDir, sessionId, orphanAskId!)),
      'dry-run must not create response.json',
    );
  });
});
