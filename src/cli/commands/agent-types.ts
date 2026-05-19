import type { Command } from 'commander';
import { discoverAgentTypes } from '../../daemon/frontmatter.js';
import { resolveBundledTemplateDir } from '../../daemon/extensions.js';
import { emitJsonOk } from '../output.js';

export function registerAgentTypesList(program: Command): void {
  program
    .command('list')
    .description('List available agent types')
    .addHelpText(
      'after',
      `
agent types list: list discoverable agent types.

Input
  None.

Output (stdout, JSON)
  ok, schema_version: 1, data: { agentTypes: [{qualifiedName, source, description}, ...] }
  Sorted by qualifiedName ascending. No pagination — the catalog is bounded.

Effects
  None. Read-only.

Exit codes: 0 ok.`,
    )
    .action(() => {
      const cwd = process.env['SISYPHUS_CWD'] ?? process.cwd();
      const pluginDir = resolveBundledTemplateDir('agent-plugin');
      const types = pluginDir ? discoverAgentTypes(pluginDir, cwd) : [];
      types.sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
      emitJsonOk({ agentTypes: types });
    });
}
