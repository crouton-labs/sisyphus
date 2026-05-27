import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { CompanionState } from '../../shared/companion-types.js';
import { createBadgeGallery } from '../../shared/companion-badges.js';
import { exitError } from '../errors.js';
import { emitJsonOk } from '../output.js';

export function registerCompanionProfile(companion: Command): void {
  companion
    .command('profile')
    .description('Print the combined companion profile (memory + context + badges)')
    .option('--name <name>', 'Set companion name (persisted on the daemon)')
    .option('--badges', 'Include full badge catalog with unlock status in output')
    .addHelpText(
      'after',
      `
companion profile: retrieve the combined companion profile.

Input
  --name    optional. Set companion name (persisted on the daemon).
  --badges  optional boolean. Include full badge catalog with unlock status in output.

Output (stdout, JSON)
  ok, data: { name, level, title, mood, xp, stats, achievements, repos, lastCommentary, badges? }

Effects
  If --name is provided, updates the companion name on the daemon.

Exit codes: 0 ok | 3 not_found.`,
    )
    .action(async (opts: { name?: string; badges?: boolean }) => {
      const res = await sendRequest({ type: 'companion', name: opts.name });
      if (!res.ok) exitError(res.error);
      const companionData = res.data as unknown as CompanionState;

      if (opts.badges) {
        const gallery = createBadgeGallery(companionData.achievements);
        const badges = gallery.achievements.map(def => ({
          ...def,
          unlocked: gallery.unlocked.get(def.id) ?? null,
        }));
        emitJsonOk({ ...companionData, badges });
      } else {
        emitJsonOk(companionData);
      }
    });
}
