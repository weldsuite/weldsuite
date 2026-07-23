/**
 * Widget Realtime Routes
 *
 * - POST /token — Generate JWT for customer WebSocket connections to the realtime-worker.
 * - POST /typing — Publish typing indicator via realtime-worker.
 * - GET /health — Realtime service health check.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, ne, eq, sql } from 'drizzle-orm';
import type { Env, Variables } from '../index';
import { schema } from '../db';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { success, error } from '../lib/response';

const tokenSchema = z.object({
  customerId: z.string().nullish(),
  conversationId: z.string().nullish(),
});

export const realtimeRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST /token - Generate a widget JWT for the realtime-worker.
 *
 * The token is a simple JWT signed with WIDGET_TOKEN_SECRET that contains
 * the customer ID, workspace ID, and widget ID. The realtime-worker's
 * verifyWidgetToken() decodes and validates it.
 */
realtimeRoutes.post('/token', zValidator('json', tokenSchema), async (c) => {
  const widgetId = c.get('widgetId');
  const workspaceId = c.get('workspaceId');
  const data = c.req.valid('json');

  const secret = c.env.WIDGET_TOKEN_SECRET;
  if (!secret) {
    return error.internal(c, 'WIDGET_TOKEN_SECRET not configured');
  }

  const customerId = data.customerId || `temp_${Date.now()}`;

  // Create a simple JWT (header.payload.signature)
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const payload = btoa(JSON.stringify({
    sub: customerId,
    customerId,
    customerName: 'Customer',
    workspaceId,
    widgetId,
    conversationId: data.conversationId || undefined,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
  })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  // HMAC-SHA256 signature
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
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const token = `${header}.${payload}.${signature}`;

  // Piggyback unread count (realtime token endpoint)
  let unreadCount = 0;
  if (data.conversationId) {
    try {
      const db = c.get('tenantDb');
      const result = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.helpdeskConversationMessages)
        .where(and(
          eq(schema.helpdeskConversationMessages.conversationId, data.conversationId),
          ne(schema.helpdeskConversationMessages.authorType, 'customer'),
          eq(schema.helpdeskConversationMessages.isRead, false),
          eq(schema.helpdeskConversationMessages.isPublic, true),
        ));
      unreadCount = Number(result[0]?.count || 0);
    } catch {
      // Non-critical
    }
  }

  return success(c, { token, unreadCount });
});

/**
 * POST /typing - Publish typing indicator via realtime-worker
 */
realtimeRoutes.post('/typing', async (c) => {
  const data = await c.req.json() as { conversationId: string; isTyping: boolean; customerName?: string };

  if (!data.conversationId) {
    return c.json({ success: false, error: 'Missing conversationId' }, 400);
  }

  try {
    if (c.env.REALTIME) {
      const rt = new RealtimePublisher(c.env.REALTIME);
      await rt.conversationPublish(data.conversationId, {
        type: 'typing',
        userId: `customer:${data.customerName || 'visitor'}`,
        userName: data.customerName || 'Customer',
        isTyping: data.isTyping,
        ts: Date.now(),
      });
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('[Realtime Typing] Error:', err);
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

/**
 * GET /health - Health check for realtime service
 */
realtimeRoutes.get('/health', async (c) => {
  return c.json({
    status: c.env.REALTIME ? 'ok' : 'unconfigured',
    configured: !!c.env.REALTIME,
    provider: 'realtime-worker',
    timestamp: new Date().toISOString(),
  });
});
