/**
 * Widget Realtime Routes
 *
 * POST /token — short-lived HS256 token for the visitor's ConversationRoom
 * WebSocket. Minted only after checking the visitor owns the conversation;
 * realtime-worker rejects a token that is not bound to the room it joins.
 * Typing indicators travel over that socket, not through this API.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getDeskConversation } from '@weldsuite/db/lib/desk';
import type { Env, Variables } from '../index';
import { success, error } from '../lib/response';
import { visitorDisplayName } from '../lib/desk-live';

const tokenSchema = z.object({
  visitorId: z.string().min(1).max(64),
  conversationId: z.string().min(1).max(64),
});

const TOKEN_TTL_SECONDS = 3600;

function base64Url(input: string | ArrayBuffer): string {
  const raw =
    typeof input === 'string'
      ? btoa(unescape(encodeURIComponent(input)))
      : btoa(String.fromCharCode(...new Uint8Array(input)));
  return raw.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function signToken(secret: string, payload: Record<string, unknown>): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${base64Url(signature)}`;
}

export const realtimeRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

realtimeRoutes.post('/token', zValidator('json', tokenSchema), async (c) => {
  const db = c.get('tenantDb');
  const widgetId = c.get('widgetId');
  const workspaceId = c.get('workspaceId');
  const data = c.req.valid('json');

  const secret = c.env.WIDGET_TOKEN_SECRET;
  if (!secret) {
    return error.internal(c, 'WIDGET_TOKEN_SECRET not configured');
  }

  const result = await getDeskConversation(db, data.conversationId);
  if (!result || result.conversation.visitorId !== data.visitorId) {
    return error.notFound(c, 'Conversation', data.conversationId);
  }

  const visitorName = await visitorDisplayName(db, data.visitorId, result.conversation);
  const now = Math.floor(Date.now() / 1000);
  const token = await signToken(secret, {
    sub: data.visitorId,
    customerId: data.visitorId,
    customerName: visitorName,
    workspaceId,
    widgetId,
    conversationId: data.conversationId,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  });

  return success(c, { token, expiresIn: TOKEN_TTL_SECONDS });
});
