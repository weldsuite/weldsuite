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
  deskAuthorFromMember,
  getDeskConversation,
  isPublicDeskMessage,
  listDeskConversations,
  toPublicDeskConversation,
  toPublicDeskMessage,
  DeskConversationNotFoundError,
  isDeskSchemaMissing,
  type DeskAuthorInfo,
  type DeskConversation,
  type DeskMessage,
} from '@weldsuite/db/lib/desk';
import * as schema from '@weldsuite/db/schema';
import { eq } from 'drizzle-orm';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { sendDeskEmailReply } from '../../lib/desk-email';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

async function loadAuthor(db: Variables['tenantDb'], userId: string | null | undefined) {
  const authors = new Map<string, DeskAuthorInfo>();
  if (!userId) return authors;
  try {
    const [member] = await db
      .select({ name: schema.workspaceMembers.name, picture: schema.workspaceMembers.picture })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, userId))
      .limit(1);
    if (member) authors.set(userId, deskAuthorFromMember(member));
  } catch (err) {
    console.error('[app-api/desk-conversations] author lookup failed:', err);
  }
  return authors;
}

/**
 * Fan a change out live:
 *   - ConversationRoom: the visitor's widget (and other agents viewing the
 *     thread). Visitors are connected to this room, so internal notes are
 *     NEVER published here.
 *   - WorkspaceHub desk_conversation / desk_message: every agent's inbox list
 *     and open thread, including notes. Published directly (not only via the
 *     entity-event queue) so the inbox updates in the same second.
 */
async function publishDeskChange(
  c: { env: Env; get: (key: 'workspaceId') => string },
  conversation: DeskConversation,
  message: DeskMessage,
  authors: Map<string, DeskAuthorInfo>,
) {
  if (!c.env.REALTIME) return;
  const rt = new RealtimePublisher(c.env.REALTIME);
  const orgId = c.get('workspaceId');
  const jobs: Promise<unknown>[] = [
    rt.publish(orgId, 'desk_conversation', 'updated', conversation, message.authorId ?? 'system'),
    rt.publish(orgId, 'desk_message', 'created', message, message.authorId ?? 'system'),
  ];

  if (isPublicDeskMessage(message)) {
    const record = toPublicDeskMessage(message, authors);
    if (message.kind === 'message') {
      jobs.push(
        rt.conversationPublish(conversation.id, {
          type: 'message',
          id: message.id,
          content: message.body ?? '',
          senderId: message.authorId ?? '',
          senderName: record.authorName ?? 'Support',
          senderAvatar: record.authorAvatar ?? undefined,
          senderType: message.authorType,
          ts: Date.now(),
          record,
        }),
      );
    } else {
      jobs.push(
        rt.conversationPublish(conversation.id, {
          type: 'system',
          event: record.eventType ?? 'event',
          data: {
            state: conversation.state,
            conversation: toPublicDeskConversation(conversation, authors),
            record,
          },
          ts: Date.now(),
        }),
      );
    }
  }

  const results = await Promise.allSettled(jobs);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[app-api/desk-conversations] realtime publish failed:', result.reason);
    }
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
    const authors = await loadAuthor(db, userId);
    c.executionCtx.waitUntil(publishDeskChange(c, conversation, message, authors));
    if (conversation.channel === 'email' && data.kind === 'message') {
      try {
        await sendDeskEmailReply(c.env, db, conversation, message);
      } catch (err) {
        console.error('[app-api/desk-conversations] outbound email failed:', err);
      }
    }
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
    const authors = await loadAuthor(db, conversation.assigneeId);
    c.executionCtx.waitUntil(publishDeskChange(c, conversation, message, authors));
    return success(c, { conversation, message });
  } catch (err) {
    if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', id);
    console.error('[app-api/desk-conversations] manage failed:', err);
    return error.internal(c, 'Failed to update conversation');
  }
});

export { app as deskConversationsRoutes };
