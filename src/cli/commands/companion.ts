import type { Command } from 'commander';
import { basename, dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildCompanionContextBlocks, renderContextDelta, renderFullContext, type CompanionContextBlocks } from '../../tui/lib/context.js';
import { globalDir } from '../../shared/paths.js';
import type { CompanionMemoryState, ObservationCategory, ObservationRecord } from '../../shared/companion-types.js';
import { MemoryStoreParseError } from '../../shared/companion-types.js';
import { loadMemoryStrict, sanitizeForDisplay } from '../../daemon/companion-memory.js';
import { showCommentaryPopup } from '../../daemon/companion-popup.js';

const CATEGORY_ORDER: Array<[ObservationCategory, string]> = [
  ['session-sentiments', 'Session Sentiments'],
  ['repo-impressions', 'Repo Impressions'],
  ['user-patterns', 'User Patterns'],
  ['notable-moments', 'Notable Moments'],
];

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mon = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${hh}:${mm}:${ss} ${yyyy}-${mon}-${dd}`;
}

async function runCompanionMemory(opts: { repo?: string }): Promise<void> {
  let state: CompanionMemoryState;
  try {
    state = loadMemoryStrict();
  } catch (err) {
    if (err instanceof MemoryStoreParseError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  console.log(renderMemory(state, opts.repo));
}

export function renderMemory(state: CompanionMemoryState, repo?: string): string {
  let observations: ObservationRecord[] = state.observations;
  if (repo !== undefined) {
    observations = observations.filter(obs => obs.repo === repo);
  }

  const grouped = new Map<ObservationCategory, ObservationRecord[]>();
  for (const [cat] of CATEGORY_ORDER) grouped.set(cat, []);
  for (const obs of observations) grouped.get(obs.category)?.push(obs);
  for (const [, recs] of grouped) recs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const lines: string[] = [];
  for (const [cat, label] of CATEGORY_ORDER) {
    const recs = grouped.get(cat) ?? [];
    if (recs.length > 0) {
      lines.push(`${label} (${recs.length})`);
      for (const rec of recs) {
        const ts = formatTimestamp(rec.timestamp);
        const src = `(${rec.source})`.padEnd(7);
        const text = sanitizeForDisplay(rec.text);
        const repoStr = rec.repo !== null ? `[${sanitizeForDisplay(basename(rec.repo))}]` : '[—]';
        lines.push(`  [${ts}] ${src}  ${text}  ${repoStr}`);
      }
    } else {
      lines.push(label);
      lines.push('  (none)');
    }
    lines.push('');
  }
  if (lines[lines.length - 1] === '') lines.pop();

  const prunedStr = state.prunedAt !== null
    ? state.prunedAt.slice(0, 10)
    : 'never';
  lines.push('');
  lines.push(`${observations.length} observations total, last pruned ${prunedStr}`);

  return lines.join('\n');
}

export function registerCompanion(program: Command): void {
  const companion = program
    .command('companion')
    .description('companion-pane helper subtree')
    .addHelpText('before', '\ncompanion: companion-pane helper. profile (combined view), memory (observations), context (hook), pane (open), popup-test (validate).\n');

  companion
    .command('memory')
    .description('Show accumulated companion observations grouped by category')
    .option('--repo <path>', 'Filter observations by repo path')
    .addHelpText('after', `
companion memory: show accumulated companion observations grouped by category.

Input
  --repo <path>    optional — filter observations to this repo path; must match the absolute path stored in the memory file.

Output (stdout, plain text — human-readable grouping; not for agentic consumption)
  Observations grouped by category (session-sentiments, repo-impressions, user-patterns, notable-moments).
  Each entry: timestamp, source, text, repo basename.
  Footer: total observation count and last-pruned date.

Effects
  None. Read-only.

Exit codes: 0 ok | 1 memory file parse error.`)
    .action(async (opts: { repo?: string }) => {
      await runCompanionMemory(opts);
    });

  companion
    .command('context')
    .description('Emit per-prompt context for the companion plugin hook. Caches the last emission per claude session and writes only the delta on subsequent calls (or nothing, when unchanged).')
    .requiredOption('--cwd <path>', 'Project directory whose sessions to summarise')
    .requiredOption('--session-id <id>', 'Claude session id (from the UserPromptSubmit stdin payload) — keys the per-session cache')
    .addHelpText('after', `
companion context: emit per-prompt companion context for the UserPromptSubmit hook.

Input
  --cwd <path>          required — absolute path to the project directory whose sessions to summarise.
  --session-id <id>     required — Claude session id from the UserPromptSubmit stdin payload; keys the per-session delta cache.

Output (stdout, plain text — not JSON; consumed as hook context for companion-context)
  First call per session: full context block.
  Subsequent calls: delta of changed blocks only; no output when unchanged.

Effects
  Writes/updates ~/.sisyphus/companion-context-cache/<session-id>.json on each call that produces output.

Exit codes: 0 ok.`)
    .action((opts: { cwd: string; sessionId: string }) => {
      // Cache lives at ~/.sisyphus/companion-context-cache/<sessionId>.json.
      // No cleanup yet — blobs are tiny; `rm -rf` the dir to reset.
      const cachePath = join(globalDir(), 'companion-context-cache', `${opts.sessionId}.json`);
      let prev: CompanionContextBlocks = {};
      try {
        prev = JSON.parse(readFileSync(cachePath, 'utf-8')) as CompanionContextBlocks;
      } catch {
        prev = {};
      }

      const next = buildCompanionContextBlocks(opts.cwd);
      const hadPrev = Object.keys(prev).length > 0;

      if (hadPrev) {
        const delta = renderContextDelta(prev, next);
        if (delta === null) return;
        process.stdout.write(delta); // hook ABI — plaintext for UserPromptSubmit
      } else {
        process.stdout.write(renderFullContext(next)); // hook ABI — plaintext for UserPromptSubmit
      }

      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(next), 'utf-8');
    });

  companion
    .command('pane')
    .description('Open (or focus) a side claude pane next to the dashboard')
    .option('--cwd <path>', 'Project directory (default: current directory)')
    .addHelpText('after', `
companion pane: open (or focus) the companion side pane next to the dashboard.

Input
  --cwd <path>    optional — project directory; defaults to the current working directory.

Output (stdout, none — this command opens a tmux pane; no structured output is emitted)

Effects
  Opens or focuses the companion tmux side pane for the given project directory.

Exit codes: 0 ok.`)
    .action(async (opts: { cwd?: string }) => {
      const { openCompanionPane } = await import('../../tui/lib/tmux.js');
      openCompanionPane(opts.cwd ?? process.cwd());
    });

  companion
    .command('popup-test')
    .description('Show a test commentary popup to validate feedback key handling')
    .option('--text <text>', 'Custom popup text', 'Cycle complete. Everything went exactly as planned. Nothing suspicious here.')
    .addHelpText('after', `
companion popup-test: show a test commentary popup to validate feedback key handling.

Input
  --text <text>    optional — popup body text; defaults to a canned placeholder string.

Output (stdout, plain text — interactive popup result; human-driven test, not for agentic consumption)
  rating: <thumbs_up|thumbs_down|comment>  [comment: "<text>"]
  Nothing on success when popup is suppressed.

Effects
  Spawns a tmux popup; blocks until the user dismisses it.

Exit codes: 0 ok | 1 popup suppressed or not in tmux.`)
    .action((opts: { text: string }) => {
      const feedback = showCommentaryPopup(opts.text);
      if (feedback === null) {
        console.error('No feedback received (popup suppressed or not in tmux).');
        process.exitCode = 1;
        return;
      }
      if (feedback.rating === 'comment' && feedback.comment !== undefined) {
        console.log(`rating: comment  "${feedback.comment}"`);
      } else {
        console.log(`rating: ${feedback.rating}${feedback.comment !== undefined ? `  comment: ${feedback.comment}` : ''}`);
      }
    });
}
