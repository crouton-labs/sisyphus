/**
 * Emit a structured success payload to stdout. Always wraps the data
 * in `{ ok: true, schema_version: 1, data }` so every successful invocation
 * yields a parseable line.
 *
 *   emitJsonOk({ sessionId, agentId });
 *   return;
 */
export function emitJsonOk(data: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ ok: true, schema_version: 1, data }) + '\n',
  );
}
