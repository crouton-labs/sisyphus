import type { ErrorKind, ProtocolError } from '../shared/protocol.js';

/**
 * Wire `error` field may be a plain string from unmigrated daemon sites; this
 * normalizes both into a `ProtocolError` so every consumer branches on a
 * structured shape.
 */
export function normalizeError(e: string | ProtocolError | undefined): ProtocolError {
  if (e === undefined) {
    return { code: 'unknown', kind: 'permanent', message: 'unknown error' };
  }
  if (typeof e === 'string') {
    return { code: 'unknown', kind: 'permanent', message: e };
  }
  return e;
}

const EXIT_CODES: Record<ErrorKind, number> = {
  usage: 2,
  not_found: 3,
  ambiguous: 4,
  conflict: 5,
  transient: 60,
  permanent: 1,
};

export function exitForError(kind: ErrorKind): number {
  return EXIT_CODES[kind] ?? 1;
}

/**
 * Print a typed error to the right stream and exit with the kind-banded code.
 * In `--json` mode, emits a structured envelope on stdout; otherwise prose
 * lines on stderr that enumerate received/expected/next.
 *
 * Never returns. Use everywhere instead of `console.error(...); process.exit(1)`.
 */
export function exitError(err: string | ProtocolError | undefined): never {
  const e = normalizeError(err);
  process.stdout.write(
    JSON.stringify({ ok: false, schema_version: 1, error: e }) + '\n',
  );
  process.exit(exitForError(e.kind));
}

/**
 * Shorthand for the usage-error path inside command actions. Builds a
 * ProtocolError with kind:'usage', code, message, and optional fields, then
 * routes through exitError (exit code 2, --json aware).
 */
export function exitUsage(
  code: string,
  message: string,
  fields: { received?: unknown; expected?: unknown; next?: string; candidates?: string[] } = {},
): never {
  exitError({ kind: 'usage', code, message, ...fields });
}

function formatVal(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
