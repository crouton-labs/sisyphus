import { rawSend } from '../../shared/client.js';
import type { Request, Response, FocusRequest } from '../../shared/protocol.js';
import type { InboxItem } from '../../shared/inbox-types.js';

export function send(request: Request): Promise<Response> {
  return rawSend(request, 8_000);
}

export async function inboxList(cwd: string): Promise<(InboxItem & { sessionName?: string })[]> {
  const res = await send({ type: 'inbox-list', cwd });
  if (!res.ok) return [];
  return (res.data?.items as (InboxItem & { sessionName?: string })[] | undefined) ?? [];
}

export async function focusGet(cwd: string): Promise<FocusRequest | null> {
  const res = await send({ type: 'focus-get', cwd });
  if (!res.ok) return null;
  return (res.data?.focus as FocusRequest | undefined) ?? null;
}
