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
import { canAccessDeskConversation } from '@weldsuite/db/lib/desk-portal';
import type { Env, Variables } from '../index';
import { success, error } from '../lib/response';
import { visitorDisplayName } from '../lib/desk-live';
import { signJwt } from '../lib/tokens';

const tokenSchema = z.object({
  conversationId: z.string().min(1).max(64),
});

const TOKEN_TTL_SECONDS = 3600;

export const realtimeRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

realtimeRoutes.post('/token', zValidator('json', tokenSchema), async (c) => {
  const db = c.get('tenantDb');
  const widgetId = c.get('widgetId');
  const workspaceId = c.get('clerkOrgId');
  const data = c.req.valid('json');

  const secret = c.env.WIDGET_TOKEN_SECRET;
  if (!secret) {
    return error.internal(c, 'WIDGET_TOKEN_SECRET not configured');
  }

  const visitorId = c.get('visitor').id;
  const result = await getDeskConversation(db, data.conversationId);
  if (!result || !(await canAccessDeskConversation(db, result.conversation, c.get('principal')))) {
    return error.notFound(c, 'Conversation', data.conversationId);
  }

  const visitorName = await visitorDisplayName(db, visitorId, result.conversation);
  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt(secret, {
    sub: visitorId,
    customerId: visitorId,
    customerName: visitorName,
    workspaceId,
    widgetId,
    conversationId: data.conversationId,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  });

  return success(c, { token, expiresIn: TOKEN_TTL_SECONDS });
});
