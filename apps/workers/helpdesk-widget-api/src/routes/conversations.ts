/**
 * Visitor-facing conversation + message routes.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import {
  appendDeskMessage,
  createDeskConversation,
  findOpenConversationForVisitor,
  getDeskConversation,
  listDeskMessages,
  upsertDeskVisitor,
  DeskConversationNotFoundError,
} from '@weldsuite/db/lib';
import type { Env, Variables } from '../index';
import { error, success } from '../lib/response';
import { generateId } from '../lib/id';

export const conversationsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const identifySchema = z.object({
  visitorId: z.string().min(1).max(64),
  name: z.string().max(255).optional(),
  email: z.string().email().max(255).optional(),
});

const startSchema = identifySchema.extend({
  body: z.string().min(1),
});

const sendSchema = z.object({
  visitorId: z.string().min(1).max(64),
  body: z.string().min(1),
});

async function publishRealtime(
  env: Env,
  conversationId: string,
  payload: Record<string, unknown>,
) {
  if (!env.REALTIME) return;
  try {
    const rt = new RealtimePublisher(env.REALTIME);
    await rt.conversationPublish(conversationId, { ...payload, ts: Date.now() });
    await rt.helpdeskEvent(payload.workspaceId as string, 'conversation_updated', {
      conversationId,
    });
  } catch (err) {
    console.error('[widget-api] realtime publish failed:', err);
  }
}

conversationsRoutes.post('/identify', zValidator('json', identifySchema), async (c) => {
  const db = c.get('tenantDb');
  const widgetId = c.get('widgetId');
  const data = c.req.valid('json');
  try {
    const visitor = await upsertDeskVisitor(db, {
      id: data.visitorId,
      name: data.name,
      email: data.email,
      widgetId,
    });
    const open = await findOpenConversationForVisitor(db, visitor.id);
    return success(c, { visitor, conversationId: open?.id ?? null });
  } catch (err) {
    console.error('[widget-api] identify failed:', err);
    return error.internal(c, 'Failed to identify visitor');
  }
});

conversationsRoutes.post('/', zValidator('json', startSchema), async (c) => {
  const db = c.get('tenantDb');
  const widgetId = c.get('widgetId');
  const workspaceId = c.get('workspaceId');
  const data = c.req.valid('json');
  try {
    const visitor = await upsertDeskVisitor(db, {
      id: data.visitorId,
      name: data.name,
      email: data.email,
      widgetId,
    });

    const existing = await findOpenConversationForVisitor(db, visitor.id);
    if (existing) {
      const { conversation, message } = await appendDeskMessage(db, {
        generateId,
        conversationId: existing.id,
        kind: 'message',
        authorType: 'visitor',
        authorId: visitor.id,
        body: data.body,
      });
      await publishRealtime(c.env, conversation.id, {
        type: 'message',
        id: message.id,
        content: message.body ?? '',
        senderId: visitor.id,
        senderType: 'visitor',
        workspaceId,
      });
      const messages = await listDeskMessages(db, conversation.id);
      return success(c, { conversation, messages, message }, 201);
    }

    const { conversation, message } = await createDeskConversation(db, {
      generateId,
      visitorId: visitor.id,
      name: visitor.name,
      email: visitor.email,
      body: data.body,
      authorType: 'visitor',
      authorId: visitor.id,
    });
    await publishRealtime(c.env, conversation.id, {
      type: 'message',
      id: message.id,
      content: message.body ?? '',
      senderId: visitor.id,
      senderType: 'visitor',
      workspaceId,
    });
    const messages = await listDeskMessages(db, conversation.id);
    return success(c, { conversation, messages, message }, 201);
  } catch (err) {
    console.error('[widget-api] start conversation failed:', err);
    return error.internal(c, 'Failed to start conversation');
  }
});

conversationsRoutes.get('/:id', async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const visitorId = c.req.query('visitorId');
  try {
    const result = await getDeskConversation(db, id, { includeMessages: true });
    if (!result) return error.notFound(c, 'Conversation', id);
    if (visitorId && result.conversation.visitorId && result.conversation.visitorId !== visitorId) {
      return error.forbidden(c, 'Not your conversation');
    }
    const publicMessages = result.messages.filter((m) => m.kind !== 'note');
    return success(c, { ...result.conversation, messages: publicMessages });
  } catch (err) {
    console.error('[widget-api] get conversation failed:', err);
    return error.internal(c, 'Failed to fetch conversation');
  }
});

conversationsRoutes.get('/:id/messages', async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const result = await getDeskConversation(db, id);
    if (!result) return error.notFound(c, 'Conversation', id);
    const rows = await listDeskMessages(db, id);
    const publicRows = rows.filter((m) => m.kind !== 'note');
    return success(c, publicRows);
  } catch (err) {
    console.error('[widget-api] list messages failed:', err);
    return error.internal(c, 'Failed to list messages');
  }
});

conversationsRoutes.post('/:id/messages', zValidator('json', sendSchema), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const existing = await getDeskConversation(db, id);
    if (!existing) return error.notFound(c, 'Conversation', id);
    if (existing.conversation.visitorId && existing.conversation.visitorId !== data.visitorId) {
      return error.forbidden(c, 'Not your conversation');
    }

    const { conversation, message } = await appendDeskMessage(db, {
      generateId,
      conversationId: id,
      kind: 'message',
      authorType: 'visitor',
      authorId: data.visitorId,
      body: data.body,
    });
    await publishRealtime(c.env, conversation.id, {
      type: 'message',
      id: message.id,
      content: message.body ?? '',
      senderId: data.visitorId,
      senderType: 'visitor',
      workspaceId,
    });
    return success(c, { conversation, message }, 201);
  } catch (err) {
    if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', id);
    console.error('[widget-api] send message failed:', err);
    return error.internal(c, 'Failed to send message');
  }
});
