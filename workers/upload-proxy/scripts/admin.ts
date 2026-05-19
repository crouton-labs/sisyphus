#!/usr/bin/env node
/**
 * Token admin CLI for sisyphus-upload-proxy.
 * Invoked via: pnpm admin <subcommand> [args]
 *
 * Subcommands:
 *   mint <userId> [--notes "..."]   — mint a new token; shows plaintext ONCE
 *   list                            — table of all tokens
 *   show <userId>                   — full TokenRecord JSON for userId
 *   revoke <userId>                 — soft-delete (revoked: true)
 *   delete <userId>                 — hard-delete the KV key
 */

import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

interface TokenRecord {
  tokenHash: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string | null;
  sessionsUploaded: number;
  revoked: boolean;
  notes?: string;
}

const WRANGLER = './node_modules/.bin/wrangler';
const BINDING = 'TOKENS';

function wranglerKv(...args: string[]): string {
  return execFileSync(WRANGLER, ['kv', 'key', ...args, `--binding=${BINDING}`, '--remote'], {
    encoding: 'utf8',
    cwd: new URL('..', import.meta.url).pathname,
  }).trim();
}

function wranglerKvList(): Array<{ name: string }> {
  const out = execFileSync(
    WRANGLER,
    ['kv', 'key', 'list', `--binding=${BINDING}`, '--prefix=token:', '--remote'],
    { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname },
  );
  return JSON.parse(out);
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function mintToken(userId: string): { plaintext: string; record: TokenRecord } {
  const raw = randomBytes(32);
  const plaintext = `sisyphus_pat_${raw.toString('base64url')}`;
  const tokenHash = sha256hex(plaintext);
  const record: TokenRecord = {
    tokenHash,
    userId,
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    sessionsUploaded: 0,
    revoked: false,
  };
  return { plaintext, record };
}

function getAllRecords(): TokenRecord[] {
  const keys = wranglerKvList();
  return keys.map((k) => {
    const raw = execFileSync(
      WRANGLER,
      ['kv', 'key', 'get', k.name, `--binding=${BINDING}`, '--remote'],
      { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname },
    ).trim();
    return JSON.parse(raw) as TokenRecord;
  });
}

function findRecordByUserId(userId: string): { key: string; record: TokenRecord } | null {
  const keys = wranglerKvList();
  for (const k of keys) {
    const raw = execFileSync(
      WRANGLER,
      ['kv', 'key', 'get', k.name, `--binding=${BINDING}`, '--remote'],
      { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname },
    ).trim();
    const record = JSON.parse(raw) as TokenRecord;
    if (record.userId === userId) return { key: k.name, record };
  }
  return null;
}

const [, , subcommand, ...rest] = process.argv;

switch (subcommand) {
  case 'mint': {
    const userId = rest[0];
    if (!userId) {
      console.error('Usage: pnpm admin mint <userId> [--notes "..."]');
      process.exit(1);
    }
    const notesIdx = rest.indexOf('--notes');
    const notes = notesIdx !== -1 ? rest[notesIdx + 1] : undefined;

    const { plaintext, record } = mintToken(userId);
    if (notes) record.notes = notes;

    const key = `token:${record.tokenHash}`;
    wranglerKv('put', key, JSON.stringify(record));

    console.log('');
    console.log('✓ Token minted. SAVE THIS — it will not be shown again.');
    console.log('');
    console.log(`  userId:    ${record.userId}`);
    console.log(`  tokenHash: ${record.tokenHash}`);
    console.log(`  plaintext: ${plaintext}`);
    console.log('');
    console.log('Share via:');
    console.log(`  sis admin configure-upload "https://sisyphus-upload-proxy.rhyneer-silas.workers.dev/upload?token=${plaintext}"`);
    console.log('');
    break;
  }

  case 'list': {
    const records = getAllRecords();
    if (records.length === 0) {
      console.log('No tokens found.');
      break;
    }
    console.log('');
    console.log(
      'userId'.padEnd(20) +
        'createdAt'.padEnd(28) +
        'lastSeenAt'.padEnd(28) +
        'uploads'.padEnd(10) +
        'revoked'.padEnd(10) +
        'hash[:8]',
    );
    console.log('-'.repeat(110));
    for (const r of records) {
      console.log(
        r.userId.padEnd(20) +
          r.createdAt.padEnd(28) +
          (r.lastSeenAt ? r.lastSeenAt : 'never').padEnd(28) +
          String(r.sessionsUploaded).padEnd(10) +
          String(r.revoked).padEnd(10) +
          r.tokenHash.slice(0, 8),
      );
    }
    console.log('');
    break;
  }

  case 'show': {
    const userId = rest[0];
    if (!userId) {
      console.error('Usage: pnpm admin show <userId>');
      process.exit(1);
    }
    const hit = findRecordByUserId(userId);
    if (!hit) {
      console.error(`No token found for userId: ${userId}`);
      process.exit(1);
    }
    console.log(JSON.stringify(hit.record, null, 2));
    break;
  }

  case 'revoke': {
    const userId = rest[0];
    if (!userId) {
      console.error('Usage: pnpm admin revoke <userId>');
      process.exit(1);
    }
    const hit = findRecordByUserId(userId);
    if (!hit) {
      console.error(`No token found for userId: ${userId}`);
      process.exit(1);
    }
    hit.record.revoked = true;
    wranglerKv('put', hit.key, JSON.stringify(hit.record));
    console.log(`✓ Revoked token for ${userId} (key: ${hit.key})`);
    break;
  }

  case 'delete': {
    const userId = rest[0];
    if (!userId) {
      console.error('Usage: pnpm admin delete <userId>');
      process.exit(1);
    }
    const hit = findRecordByUserId(userId);
    if (!hit) {
      console.error(`No token found for userId: ${userId}`);
      process.exit(1);
    }
    wranglerKv('delete', hit.key);
    console.log(`✓ Deleted token for ${userId} (key: ${hit.key})`);
    break;
  }

  default:
    console.error('Usage: pnpm admin <mint|list|show|revoke|delete> [args]');
    process.exit(1);
}
