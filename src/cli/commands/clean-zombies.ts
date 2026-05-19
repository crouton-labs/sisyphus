import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { loadSessionRegistry } from '../../daemon/server.js';
import * as askStore from '../../daemon/ask-store.js';
import * as state from '../../daemon/state.js';
import { statePath, askOutputPath } from '../../shared/paths.js';
import type { DeckSource } from '../../shared/types.js';

const HEARTBEAT_ASKED_BY = 'system:heartbeat';
const ORPHAN_ASKED_BY = 'system:orphan-handler';

interface ZombieSummary {
  heartbeats: number;
  orphans: number;
  modeGates: number;
}

interface ZombieEntry {
  sessionId: string;
  askId: string;
  kind: 'heartbeat' | 'orphan' | 'mode-gate';
  reason: string;
}

/**
 * Check if a heartbeat ask's linked original has been answered.
 */
function isHeartbeatZombie(
  cwd: string,
  sessionId: string,
  askId: string,
): boolean {
  const meta = askStore.readMeta(cwd, sessionId, askId);
  if (!meta) return false;
  if (meta.askedBy !== HEARTBEAT_ASKED_BY) return false;
  if (meta.status === 'answered') return false;
  if (existsSync(askOutputPath(cwd, sessionId, askId))) return false;

  // Find the original ask: scan all asks for one that has this heartbeat's askId
  for (const candidateId of askStore.listAsks(cwd, sessionId)) {
    if (candidateId === askId) continue;
    const candidateMeta = askStore.readMeta(cwd, sessionId, candidateId);
    if (!candidateMeta) continue;
    if (candidateMeta.heartbeatAskId !== askId) continue;
    // Found the original — if it's answered, this heartbeat is a zombie
    if (candidateMeta.status === 'answered') return true;
    if (existsSync(askOutputPath(cwd, sessionId, candidateId))) return true;
  }
  return false;
}

/**
 * Check if an orphan ask's target agent is dead and superseded (status is not 'running').
 */
function isOrphanZombie(
  cwd: string,
  sessionId: string,
  askId: string,
): boolean {
  const meta = askStore.readMeta(cwd, sessionId, askId);
  if (!meta) return false;
  if (meta.askedBy !== ORPHAN_ASKED_BY) return false;
  if (meta.status === 'answered') return false;
  if (existsSync(askOutputPath(cwd, sessionId, askId))) return false;
  if (meta.orphanTarget?.kind !== 'agent') return false;

  let session: ReturnType<typeof state.getSession>;
  try { session = state.getSession(cwd, sessionId); } catch { return false; }

  const agentId = meta.orphanTarget.agentId;
  const agent = session.agents.find(a => a.id === agentId);
  if (!agent) return false;
  // If the agent is no longer running (lost, completed, killed, crashed) it's superseded
  return agent.status !== 'running';
}

/**
 * Check if a mode-transition ask is stale — session has advanced past its modeChain.
 */
function isModeGateZombie(
  cwd: string,
  sessionId: string,
  askId: string,
): boolean {
  const meta = askStore.readMeta(cwd, sessionId, askId);
  if (!meta) return false;
  if (meta.modeTransition !== true) return false;
  if (meta.status === 'answered') return false;
  if (existsSync(askOutputPath(cwd, sessionId, askId))) return false;

  const deck = askStore.readDecisions(cwd, sessionId, askId);
  if (!deck) return false;

  const source = deck.source as DeckSource | undefined;
  const chain = source?.modeChain;
  if (!chain || chain.length === 0) return false;

  let currentMode: string | undefined;
  try {
    const session = state.getSession(cwd, sessionId);
    currentMode = session.orchestratorCycles[session.orchestratorCycles.length - 1]?.mode;
  } catch { return false; }

  if (!currentMode) return false;
  return !chain.some(e => e.mode === currentMode);
}

async function resolveZombie(
  cwd: string,
  sessionId: string,
  entry: ZombieEntry,
): Promise<void> {
  const { askId, kind } = entry;
  const completedAt = new Date().toISOString();

  let interactionId: string;
  let selectedOptionId: string;
  let freetext: string;

  switch (kind) {
    case 'heartbeat':
      interactionId = 'heartbeat';
      selectedOptionId = 'ack';
      freetext = 'auto-resolved: original ask was answered (clean-zombies sweep)';
      break;
    case 'orphan':
      interactionId = 'orphan';
      selectedOptionId = 'dismiss';
      freetext = 'auto-resolved: agent superseded by replacement (clean-zombies sweep)';
      break;
    case 'mode-gate':
      interactionId = 'mode-transition';
      selectedOptionId = 'ack';
      freetext = 'auto-resolved: session advanced past mode-transition (clean-zombies sweep)';
      break;
  }

  askStore.writeOutput(cwd, sessionId, askId, [{
    id: interactionId,
    selectedOptionId,
    freetext,
  }], completedAt);
  await askStore.updateMeta(cwd, sessionId, askId, { status: 'answered', completedAt });
}

async function sweepSession(
  cwd: string,
  sessionId: string,
): Promise<ZombieEntry[]> {
  const zombies: ZombieEntry[] = [];
  const askIds = askStore.listAsks(cwd, sessionId);

  for (const askId of askIds) {
    if (isHeartbeatZombie(cwd, sessionId, askId)) {
      zombies.push({ sessionId, askId, kind: 'heartbeat', reason: 'original ask was answered' });
    } else if (isOrphanZombie(cwd, sessionId, askId)) {
      const meta = askStore.readMeta(cwd, sessionId, askId);
      const agentId = meta?.orphanTarget?.kind === 'agent' ? meta.orphanTarget.agentId : 'unknown';
      zombies.push({ sessionId, askId, kind: 'orphan', reason: `agent ${agentId} is no longer running` });
    } else if (isModeGateZombie(cwd, sessionId, askId)) {
      zombies.push({ sessionId, askId, kind: 'mode-gate', reason: 'session advanced past mode-transition' });
    }
  }

  return zombies;
}

export function registerCleanZombies(program: Command): void {
  program
    .command('clean-zombies')
    .description('Sweep all sessions for zombie asks (heartbeats whose original is answered, orphans whose agent is superseded, stale mode-gate notifications) and dismiss them')
    .addHelpText(
      'after',
      `
clean-zombies: sweep all sessions and dismiss stale ask records.

Input
  (none)

Output (stdout, plain text — human-readable maintenance summary; not for agentic consumption)
  Reports the count of dismissed zombies by type, or "No zombie asks found."

Effects
  Mutates ask records: writes response.json and updates status to "answered" for each
  zombie found. Dismisses heartbeat asks whose original was answered, orphan asks whose
  target agent is no longer running, and mode-gate asks the session has advanced past.

Exit codes: 0 ok`,
    )
    .action(async () => {
      const reg = loadSessionRegistry();
      const entries = Object.entries(reg);

      if (entries.length === 0) {
        console.log('No sessions in registry.');
        return;
      }

      const allZombies: ZombieEntry[] = [];
      const sessionsSweept = new Set<string>();

      for (const [sessionId, cwd] of entries) {
        if (!existsSync(statePath(cwd, sessionId))) continue;
        try {
          const zombies = await sweepSession(cwd, sessionId);
          if (zombies.length > 0) {
            allZombies.push(...zombies);
            sessionsSweept.add(sessionId);
          }
        } catch (err) {
          console.warn(
            `[sisyphus] clean-zombies: sweep failed for ${sessionId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      const summary: ZombieSummary = {
        heartbeats: allZombies.filter(z => z.kind === 'heartbeat').length,
        orphans: allZombies.filter(z => z.kind === 'orphan').length,
        modeGates: allZombies.filter(z => z.kind === 'mode-gate').length,
      };
      const total = allZombies.length;

      if (total === 0) {
        console.log('No zombie asks found.');
        return;
      }

      for (const [sessionId, cwd] of entries) {
        if (!existsSync(statePath(cwd, sessionId))) continue;
        const sessionZombies = allZombies.filter(z => z.sessionId === sessionId);
        for (const zombie of sessionZombies) {
          try {
            await resolveZombie(cwd, sessionId, zombie);
          } catch (err) {
            console.warn(
              `[sisyphus] clean-zombies: failed to resolve ${zombie.askId}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      }

      console.log(`Dismissed ${total} zombie${total === 1 ? '' : 's'} across ${sessionsSweept.size} session${sessionsSweept.size === 1 ? '' : 's'}: ${summary.heartbeats} heartbeat${summary.heartbeats === 1 ? '' : 's'}, ${summary.orphans} orphan${summary.orphans === 1 ? '' : 's'}, ${summary.modeGates} mode-gate${summary.modeGates === 1 ? '' : 's'}.`);
    });
}
