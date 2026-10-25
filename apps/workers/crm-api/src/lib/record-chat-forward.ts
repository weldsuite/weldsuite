/**
 * Company and person chats live in chat-api, as the `company` and `person`
 * record chat types (`/api/chat-entity-channels/:type/:id/*`). crm-api keeps
 * the record-scoped paths the platform and weldcrm-app call
 * (`/api/companies/:id/chat/*`, `/api/people/:id/chat/*`) and forwards them
 * over the CHAT_API service binding, so these chats get the same realtime
 * events, notifications, followers and CRM activity logging as every other
 * record chat. chat-api runs its own auth and access checks on the forwarded
 * request.
 */

import { Hono, type Context } from 'hono';
import { FORWARDED_BY_HEADER } from '@weldsuite/worker-kit';
import { error } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../types';

type AppEnv = { Bindings: Env; Variables: Variables };

export type RecordChatType = 'company' | 'person';

async function forwardToChatApi(c: Context<AppEnv>, entityType: RecordChatType, action: string): Promise<Response> {
  const id = c.req.param('id');
  if (!id) return error.badRequest(c, 'Record id is required');

  const target = c.env.CHAT_API;
  if (!target) {
    console.error('[crm-api/record-chat] CHAT_API binding is missing');
    return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'chat-api is unavailable' } }, 503);
  }

  const url = new URL(c.req.url);
  url.pathname = `/api/chat-entity-channels/${entityType}/${encodeURIComponent(id)}/${action}`;
  const headers = new Headers(c.req.raw.headers);
  if (!headers.has('X-Request-Id')) headers.set('X-Request-Id', crypto.randomUUID());
  headers.set(FORWARDED_BY_HEADER, 'crm-api');
  const method = c.req.method;
  const body = method === 'GET' || method === 'HEAD' ? undefined : await c.req.raw.arrayBuffer();

  try {
    const upstream = await target.fetch(new Request(url.toString(), { method, headers, body }));
    // Re-wrap so the headers are mutable for anything that runs after us.
    return new Response(upstream.body, upstream);
  } catch (err) {
    console.error(`[crm-api/record-chat] chat-api unreachable for ${method} ${url.pathname}:`, err);
    return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'chat-api is unavailable' } }, 503);
  }
}

/** The `/:id/chat` sub-routes of a CRM record, forwarded to chat-api. */
export function recordChatRoutes(entityType: RecordChatType) {
  const app = new Hono<AppEnv>();
  /** The linked channel, or null while nobody has written. Never creates. */
  app.get('/channel', (c) => forwardToChatApi(c, entityType, 'channel'));
  /** Post; creates the channel on the first message. */
  app.post('/messages', (c) => forwardToChatApi(c, entityType, 'messages'));
  /** Follow / unfollow the record's chat (WeldChat sidebar). */
  app.post('/follow', (c) => forwardToChatApi(c, entityType, 'follow'));
  app.delete('/follow', (c) => forwardToChatApi(c, entityType, 'follow'));
  return app;
}
