/**
 * Widget Realtime Routes
 *
 * POST /token — JWT for customer WebSocket connections.
 * POST /typing — typing indicator via ConversationRoom DO.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Env, Variables } from '../index';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { success, error } from '../lib/response';

const tokenSchema = z.object({
  visitorId: z.string().min(1).max(64),
  conversationId: z.string().optional(),
});

export const realtimeRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

realtimeRoutes.post('/token', zValidator('json', tokenSchema), async (c) => {
  const widgetId = c.get('widgetId');
  const workspaceId = c.get('workspaceId');
  const data = c.req.valid('json');

  const secret = c.env.WIDGET_TOKEN_SECRET;
  if (!secret) {
    return error.internal(c, 'WIDGET_TOKEN_SECRET not configured');
  }

  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const payload = btoa(
    JSON.stringify({
      sub: data.visitorId,
      customerId: data.visitorId,
      customerName: 'Visitor',
      workspaceId,
      widgetId,
      conversationId: data.conversationId || undefined,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return success(c, { token: `${header}.${payload}.${signature}` });
});

realtimeRoutes.post('/typing', async (c) => {
  const data = (await c.req.json()) as { conversationId: string; isTyping: boolean; visitorName?: string };

  if (!data.conversationId) {
    return error.badRequest(c, 'Missing conversationId');
  }

  try {
    if (c.env.REALTIME) {
      const rt = new RealtimePublisher(c.env.REALTIME);
      await rt.conversationPublish(data.conversationId, {
        type: 'typing',
        userId: `visitor:${data.visitorName || 'visitor'}`,
        userName: data.visitorName || 'Visitor',
        isTyping: data.isTyping,
        ts: Date.now(),
      });
    }
    return success(c, { ok: true });
  } catch (err) {
    console.error('[Realtime Typing] Error:', err);
    return error.internal(c, (err as Error).message);
  }
});
