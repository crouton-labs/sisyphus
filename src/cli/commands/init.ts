import type { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_CONFIG = {};

const ORCHESTRATOR_TEMPLATE = `# Custom Orchestrator Prompt

<!-- This file overrides the default orchestrator system prompt. -->
<!-- Delete this file to use the built-in prompt. -->
<!-- See: https://github.com/silasrhyneer/sisyphi for details. -->
`;

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Initialize sisyphus configuration for this project')
    .option('--orchestrator', 'Also create a custom orchestrator prompt template')
    .addHelpText(
      'after',
      `
init: initialize sisyphus project configuration in the current directory.

Input
  --orchestrator    optional boolean — also create .sisyphus/orchestrator.md
                    with a custom orchestrator prompt template.

Output (stdout, plain text)
  Prints the path(s) of created files, or reports if already initialized.

Effects
  Creates .sisyphus/config.json in the current working directory.
  If --orchestrator: also creates .sisyphus/orchestrator.md.
  No-ops if .sisyphus/config.json already exists.

Exit codes: 0 ok`,
    )
    .action((opts: { orchestrator?: boolean }) => {
      const cwd = process.cwd();
      const sisDir = join(cwd, '.sisyphus');
      const configPath = join(sisDir, 'config.json');

      if (existsSync(configPath)) {
        console.log(`Already initialized: ${configPath}`);
        return;
      }

      mkdirSync(sisDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8');
      console.log(`Created ${configPath}`);

      if (opts.orchestrator) {
        const orchPath = join(sisDir, 'orchestrator.md');
        if (!existsSync(orchPath)) {
          writeFileSync(orchPath, ORCHESTRATOR_TEMPLATE, 'utf-8');
          console.log(`Created ${orchPath}`);
        }
      }

      console.log('');
      console.log('Configuration options (add to .sisyphus/config.json):');
      console.log('  orchestratorEffort  — "low" | "medium" | "high" | "xhigh" | "max" (default: "xhigh")');
      console.log('  agentEffort         — "low" | "medium" | "high" | "xhigh" | "max" (default: "medium")');
      console.log('  pollIntervalMs      — Daemon poll interval in ms (default: 5000)');
      console.log('  autoUpdate          — Auto-update daemon on restart (default: true)');
      console.log('  notifications       — { enabled: boolean, sound: string } (default: enabled, Hero.aiff)');
      console.log('  companionPopup      — Show companion commentary as tmux popup (default: true)');
    });
}
