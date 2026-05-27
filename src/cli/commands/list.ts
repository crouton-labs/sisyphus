import type { Command } from 'commander';
import { sendRequest } from '../client.js';
import type { Request } from '../../shared/protocol.js';
import { exitError, exitUsage } from '../errors.js';

interface Session {
  id: string;
  name?: string;
  task: string;
  status: string;
  agentCount: number;
  createdAt: string;
  cwd?: string;
  handoff?: {
    queuedAt: string;
    sentAt?: string;
    reclaimedAt?: string;
    target?: { provider: string; repo: string };
    lastError?: string;
  };
}

interface Cursor {
  lastCreatedAt: string;
  lastId: string;
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ lastCreatedAt: createdAt, lastId: id })).toString('base64');
}

function decodeCursor(token: string): Cursor {
  try {
    const raw = Buffer.from(token, 'base64').toString('utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)['lastCreatedAt'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['lastId'] !== 'string'
    ) {
      throw new Error('shape mismatch');
    }
    return parsed as Cursor;
  } catch {
    exitUsage('invalid_cursor', 'cursor token is malformed or corrupt; omit it to start from the beginning');
  }
}

export function registerList(program: Command): void {
  program
    .command('list')
    .description('List sessions (defaults to current project)')
    .addHelpText('after', `
session inspect list: list sessions in the requested scope with cursor pagination.

Input
  --limit N         optional. Default 20, max 100. Hard-capped at 100.
  --cursor TOKEN    optional. Opaque token from a previous response's next_cursor.
                    Omit on the first call.
  --all             optional boolean. Include sessions from all project directories.
  --cwd PATH        optional. Project directory override; default is $SISYPHUS_CWD or cwd.

Output (stdout, JSON)
  items        object[]. Sorted by createdAt ascending; stable across pages.
               Fields: {id, name?, task, status, agentCount, createdAt, cwd?, handoff?}.
  next_cursor  string | null. Pass to the next call. null on the last page.
  total        integer. Total count in the requested scope (cwd-only by default,
               global with --all). Exact — the daemon ships the full scoped list
               cheaply, so the CLI just takes .length on it.

Effects
  None. Read-only.

Exit codes: 0 ok | 2 usage | 3 not_found.`)
    .option('--all', 'List sessions across all projects')
    .option('--cwd <path>', 'Project directory override; default is $SISYPHUS_CWD or cwd')
    .option('--limit <n>', 'Page size, default 20, max 100', '20')
    .option('--cursor <token>', "Opaque cursor from prior response's next_cursor")
    .action(async (opts: { all?: boolean; cwd?: string; limit: string; cursor?: string }) => {
      const limitRaw = parseInt(opts.limit, 10);
      if (isNaN(limitRaw) || limitRaw < 1 || limitRaw > 100) {
        exitUsage('limit_out_of_range', '--limit must be an integer between 1 and 100', {
          received: opts.limit,
          expected: '1–100',
        });
      }
      const limit = limitRaw;

      const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;

      const cwd = opts.cwd ?? process.env['SISYPHUS_CWD'] ?? process.cwd();
      const request: Request = { type: 'list', cwd, all: opts.all };
      const response = await sendRequest(request);
      if (!response.ok) exitError(response.error);

      const requestedScope = (response.data?.sessions ?? []) as Session[];

      // Sort ascending by createdAt, tiebreak by id
      const sorted = [...requestedScope].sort((a, b) => {
        const cmp = a.createdAt.localeCompare(b.createdAt);
        return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
      });

      // Filter out items at or before the cursor position
      const afterCursor = cursor
        ? sorted.filter((s) => {
            const cmp = s.createdAt.localeCompare(cursor.lastCreatedAt);
            if (cmp !== 0) return cmp > 0;
            return s.id.localeCompare(cursor.lastId) > 0;
          })
        : sorted;

      // Fetch one extra to detect next page
      const page = afterCursor.slice(0, limit);
      const hasMore = afterCursor.length > limit;

      const next_cursor = hasMore
        ? encodeCursor(page[page.length - 1]!.createdAt, page[page.length - 1]!.id)
        : null;

      const total = requestedScope.length;

      process.stdout.write(
        JSON.stringify({ ok: true, data: { items: page, next_cursor, total } }) + '\n',
      );
    });
}
