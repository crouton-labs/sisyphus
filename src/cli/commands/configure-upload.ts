import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import { globalConfigPath } from '../../shared/paths.js';

async function readUrlFromInput(interactive: boolean): Promise<string> {
  if (interactive) {
    return new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question('Paste the upload URL (with embedded ?token=): ', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }
  return new Promise((resolve) => {
    const chunks: string[] = [];
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => { chunks.push(chunk); });
    process.stdin.on('end', () => { resolve(chunks.join('').trim()); });
  });
}

export function registerConfigureUpload(program: Command): void {
  program
    .command('configure-upload')
    .description('Configure the upload proxy from a token-bearing URL (writes ~/.sisyphus/config.json)')
    .argument('[url]', 'Worker URL with embedded ?token= query (https://worker/upload?token=sisyphus_pat_...); omit to read from stdin')
    .option('--stdin', 'Read URL from stdin (pipe-friendly: pbpaste | sis admin report configure-upload --stdin)')
    .addHelpText(
      'after',
      `
configure-upload: write upload endpoint + token to ~/.sisyphus/config.json.

Input
  [url]      optional — Worker URL with embedded ?token=sisyphus_pat_... query param.
             Omit to read interactively (TTY) or from stdin (non-TTY / --stdin).
  --stdin    read URL from stdin; pipe-friendly: pbpaste | sis admin report configure-upload --stdin.

Output (stdout, plain text — human maintenance op; not for agentic consumption)
  ✓ upload configured (<path>) on success.
  Error messages on validation failure.

Effects
  Parses and validates the URL and token prefix (must start with sisyphus_pat_).
  Strips the token from the URL, writes { url, token } to the \`upload\` key in
  ~/.sisyphus/config.json (mode 0600). Creates the directory if absent.
  Warns if the URL is passed on argv (token exposed in ps / shell history).

Exit codes: 0 ok | 1 validation or write error`,
    )
    .action(async (urlArg: string | undefined, opts: { stdin?: boolean }) => {
      let rawUrl: string;

      const fromStdin = opts.stdin || urlArg === '-' || (!urlArg && process.stdin.isTTY === false);
      const fromInteractive = !urlArg && !opts.stdin && process.stdin.isTTY === true;

      if (fromStdin || fromInteractive) {
        rawUrl = await readUrlFromInput(fromInteractive);
      } else {
        rawUrl = urlArg!;
        console.warn(
          'warning: passing the token on argv exposes it via `ps` and shell history; pipe it on stdin instead: `pbpaste | sis admin report configure-upload --stdin`',
        );
      }

      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        console.error('Error: Invalid URL');
        process.exit(1);
      }

      const token = parsed.searchParams.get('token');
      if (!token) {
        console.error('Error: URL is missing ?token=... query param');
        process.exit(1);
      }

      if (!token.startsWith('sisyphus_pat_')) {
        console.error('Error: token does not start with sisyphus_pat_ — refusing to write');
        process.exit(1);
      }

      parsed.searchParams.delete('token');

      // Strip /upload if it's the trailing segment — upload.ts appends /upload itself
      const strippedPath = parsed.pathname.replace(/\/upload\/?$/, '');
      const url = parsed.origin + (strippedPath.length > 0 ? strippedPath : '');

      // Always write to ~/.sisyphus/config.json — `loadConfig` only honors `upload`
      // from the global config (project-local upload blocks are silently stripped
      // as a security measure; see src/shared/config.ts).
      const configPath = globalConfigPath();

      let existing: Record<string, unknown> = {};
      if (existsSync(configPath)) {
        try {
          existing = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        } catch {
          console.error(`Error: ${configPath} could not be parsed — fix or delete it first`);
          process.exit(1);
        }
      }

      const merged = { ...existing, upload: { url, token } };
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
      chmodSync(configPath, 0o600);

      console.log(`✓ upload configured (${configPath})`);
    });
}
