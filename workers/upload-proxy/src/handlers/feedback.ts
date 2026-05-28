import type { Env, TokenRecord } from '../schemas';
import { jsonErr } from './health';

// Loose free-text feedback about sisyphus. Capped well below the upload limit —
// this is a note, not a bundle.
const MAX_MESSAGE_BYTES = 64 * 1024;

export async function handleFeedback(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  token: TokenRecord,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonErr(400, 'invalid JSON body');
  }
  if (typeof body !== 'object' || body === null) {
    return jsonErr(400, 'body must be a JSON object');
  }

  const b = body as Record<string, unknown>;
  const message = b.message;
  if (typeof message !== 'string' || !message.trim()) {
    return jsonErr(400, 'message missing or empty');
  }
  if (new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES) {
    return jsonErr(413, 'message too large');
  }

  const receivedAt = new Date().toISOString();
  const feedbackId = crypto.randomUUID();
  const { userId } = token;

  const record = {
    feedbackId,
    userId,
    receivedAt,
    message: message.trim(),
    sisyphusVersion: typeof b.sisyphusVersion === 'string' ? b.sisyphusVersion : null,
    platform: typeof b.platform === 'string' ? b.platform : null,
    session: typeof b.session === 'object' && b.session !== null ? b.session : null,
  };

  const key = `feedback/${userId}/${receivedAt}-${feedbackId}.json`;
  try {
    await env.BUCKET.put(key, JSON.stringify(record, null, 2), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { userId, feedbackId },
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'feedback_write_fail', userId, feedbackId, err: String(err) }));
    return jsonErr(502, 'r2 write failed');
  }

  ctx.waitUntil(
    env.TOKENS.put(
      `token:${token.tokenHash}`,
      JSON.stringify({ ...token, lastSeenAt: receivedAt }),
    ),
  );

  console.log(JSON.stringify({ event: 'feedback', userId, feedbackId }));

  return Response.json({ feedbackId, receivedAt });
}
