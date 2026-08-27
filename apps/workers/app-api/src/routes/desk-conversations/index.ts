/**
 * WeldDesk webchat — /api/desk/conversations/*
 *
 * Mutations go through appendDeskMessage / createDeskConversation
 * (@weldsuite/db/lib). Realtime: conversation room + entity events.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import {
  listConversationsQuerySchema,
  getConversationQuerySchema,
  replyToConversationSchema,
  manageConversationSchema,
} from '@weldsuite/core-api-client/schemas/desk-conversations';
import {
  appendDeskMessage,
  getDeskConversation,
  listDeskConversations,
  DeskConversationNotFoundError,
  isDeskSchemaMissing,
} from '@weldsuite/db/lib/desk';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, success } from '../../lib/response';
import { generateId } from '../../lib/id';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

async function publishRealtime(
  c: { env: Env },
  conversationId: string,
  payload: Record<string, unknown>,
) {
  if (!c.env.REALTIME) return;
  try {
    const rt = new RealtimePublisher(c.env.REALTIME);
    await rt.conversationPublish(conversationId, { ...payload, ts: Date.now() });
  } catch (err) {
    console.error('[app-api/desk-conversations] realtime publish failed:', err);
  }
}

app.get('/', requirePermission('conversations:read'), zValidator('query', listConversationsQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const query = c.req.valid('query');
  try {
    const result = await listDeskConversations(db, query);
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/desk-conversations] list failed:', err);
    if (isDeskSchemaMissing(err)) {
      return error.unavailable(c, 'WeldDesk schema is not applied. Run tenant migration 0185_welddesk_webchat.');
    }
    return error.internal(c, 'Failed to list conversations');
  }
});

app.get('/:id', requirePermission('conversations:read'), zValidator('query', getConversationQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { include } = c.req.valid('query');
  try {
    const result = await getDeskConversation(db, id, { includeMessages: include === 'messages' });
    if (!result) return error.notFound(c, 'Conversation', id);
    return success(c, include === 'messages' ? { ...result.conversation, messages: result.messages } : result.conversation);
  } catch (err) {
    console.error('[app-api/desk-conversations] get failed:', err);
    return error.internal(c, 'Failed to fetch conversation');
  }
});

app.post('/:id/reply', requirePermission('conversations:update'), zValidator('json', replyToConversationSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const { conversation, message } = await appendDeskMessage(db, {
      generateId,
      conversationId: id,
      kind: data.kind,
      authorType: 'agent',
      authorId: userId,
      body: data.body,
      attachments: data.attachments,
    });
    publishEntityEvent({
      c,
      entityType: 'desk_conversation',
      action: 'updated',
      entityId: conversation.id,
      data: conversation as unknown as Record<string, unknown>,
    });
    publishEntityEvent({
      c,
      entityType: 'desk_message',
      action: 'created',
      entityId: message.id,
      data: message as unknown as Record<string, unknown>,
    });
    await publishRealtime(c, conversation.id, {
      type: 'message',
      id: message.id,
      content: message.body ?? '',
      senderId: userId,
      senderType: 'agent',
      kind: message.kind,
    });
    return success(c, { conversation, message }, 201);
  } catch (err) {
    if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', id);
    console.error('[app-api/desk-conversations] reply failed:', err);
    return error.internal(c, 'Failed to reply');
  }
});

app.post('/:id/manage', requirePermission('conversations:update'), zValidator('json', manageConversationSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    let eventType: 'closed' | 'reopened' | 'assigned' | 'unassigned';
    let assigneeId: string | null | undefined;
    if (data.action === 'close') eventType = 'closed';
    else if (data.action === 'open') eventType = 'reopened';
    else if (data.assigneeId) {
      eventType = 'assigned';
      assigneeId = data.assigneeId;
    } else {
      eventType = 'unassigned';
      assigneeId = null;
    }

    const { conversation, message } = await appendDeskMessage(db, {
      generateId,
      conversationId: id,
      kind: 'event',
      authorType: 'agent',
      authorId: userId,
      metadata: { eventType, assigneeId: assigneeId ?? null },
      assigneeId,
    });

    const action = data.action === 'assign' ? 'assigned' : 'state_changed';
    publishEntityEvent({
      c,
      entityType: 'desk_conversation',
      action,
      entityId: conversation.id,
      data: conversation as unknown as Record<string, unknown>,
    });
    publishEntityEvent({
      c,
      entityType: 'desk_message',
      action: 'created',
      entityId: message.id,
      data: message as unknown as Record<string, unknown>,
    });
    await publishRealtime(c, conversation.id, {
      type: 'system',
      event: eventType,
      data: { assigneeId: conversation.assigneeId, state: conversation.state },
    });
    return success(c, { conversation, message });
  } catch (err) {
    if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', id);
    console.error('[app-api/desk-conversations] manage failed:', err);
    return error.internal(c, 'Failed to update conversation');
  }
});

export { app as deskConversationsRoutes };
