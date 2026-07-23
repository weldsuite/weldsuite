/**
 * Meeting message routes — flat /api/meeting-messages/* surface backed by `meetingMessages`.
 *
 * Permissions: meetings:read | meetings:create | meetings:update | meetings:delete.
 *
 * Action endpoints (static paths registered BEFORE /:id):
 *   GET  /          (?meetingId= &before= &limit=) — list with cursor + htmlContent surfaced
 *   POST /          (body: { meetingId, content, htmlContent?, attachments? }) — send
 *   GET  /pinned    (?meetingId=) — pinned messages
 *   POST /:id/pin   — pin a message
 *   DELETE /:id/pin — unpin a message
 *   DELETE /:id     — soft-delete (author only)
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, isNotNull, lt, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createMeetingMessageSchema, updateMeetingMessageSchema } from '@weldsuite/core-api-client/schemas/meeting-messages';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import {
  publishMeetingChatMessage,
  publishMeetingChatMessageDeleted,
} from '../../services/realtime/weldmeet-chat-publisher';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.meetingMessages;

// ============================================================================
// Meeting Chat action endpoints (static paths before /:id)
// ============================================================================

/**
 * GET / - List meeting chat messages with cursor pagination.
 * ?meetingId= (required), ?before= (cursor), ?limit= (1-100, default 50)
 * Surfaces `htmlContent` from metadata.htmlContent at the top level.
 */
app.get('/', requirePermission('meetings:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();

  const meetingId = q.meetingId;
  const before = q.before;
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 50, 100);

  // If no meetingId, fall back to generic list (existing behaviour)
  if (!meetingId) {
    const cursorLimit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);
    const conditions: any[] = [isNull(t.deletedAt)];
    if (q.authorId !== undefined && q.authorId !== '') conditions.push(eq(t.authorId, q.authorId));
    if (q.cursor) {
      const [cur] = await db
        .select({ createdAt: t.createdAt, id: t.id })
        .from(t).where(eq(t.id, q.cursor)).limit(1);
      if (cur?.createdAt) {
        conditions.push(
          sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
        );
      }
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
    const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

    try {
      const [rows, countRes] = await Promise.all([
        db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(cursorLimit + 1),
        db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
      ]);
      const hasMore = rows.length > cursorLimit;
      const data = hasMore ? rows.slice(0, cursorLimit) : rows;
      const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
      const totalCount = Number(countRes[0]?.count ?? 0);
      return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
    } catch (err) {
      console.error('[app-api/meeting-messages] list failed:', err);
      return error.internal(c, 'Failed to list meeting messages');
    }
  }

  // meetingId-scoped chat list (cursor pagination, htmlContent surfaced)
  try {
    const conditions: any[] = [
      eq(t.meetingId, meetingId),
      isNull(t.deletedAt),
    ];

    if (before) {
      const [cursorMsg] = await db
        .select({ createdAt: t.createdAt })
        .from(t)
        .where(eq(t.id, before))
        .limit(1);
      if (cursorMsg) {
        conditions.push(lt(t.createdAt, cursorMsg.createdAt));
      }
    }

    const messages = await db
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(desc(t.createdAt))
      .limit(limit + 1);

    const hasMore = messages.length > limit;
    const data = hasMore ? messages.slice(0, limit) : messages;

    const withHtml = data.map((m) => ({
      ...m,
      htmlContent: (m.metadata as { htmlContent?: string } | null)?.htmlContent ?? null,
    }));

    return success(c, {
      messages: withHtml,
      hasMore,
      nextCursor: hasMore && data.length > 0 ? data[data.length - 1].id : null,
    });
  } catch (err) {
    console.error('[app-api/meeting-messages] chat list failed:', err);
    return error.internal(c, 'Failed to fetch meeting messages');
  }
});

/**
 * GET /pinned - List pinned meeting chat messages.
 * ?meetingId= (required)
 */
app.get('/pinned', requirePermission('meetings:read'), async (c) => {
  const meetingId = c.req.query('meetingId');
  if (!meetingId) return error.badRequest(c, 'meetingId query parameter is required');

  try {
    const db = c.get('tenantDb');

    const messages = await db
      .select()
      .from(t)
      .where(
        and(
          eq(t.meetingId, meetingId),
          isNull(t.deletedAt),
          isNotNull(t.pinnedAt),
        ),
      )
      .orderBy(desc(t.pinnedAt))
      .limit(50);

    return success(c, { messages });
  } catch (err) {
    console.error('[app-api/meeting-messages] pinned failed:', err);
    return error.internal(c, 'Failed to fetch pinned messages');
  }
});

/**
 * POST / - Send a meeting chat message.
 * Body: { meetingId, content, htmlContent?, attachments? }
 * Stores htmlContent in metadata.htmlContent; publishes realtime + entity event.
 */
app.post(
  '/',
  requirePermission('sessions:create'),
  zValidator(
    'json',
    z
      .object({
        meetingId: z.string().min(1),
        content: z.string(),
        htmlContent: z.string().max(20_000).optional(),
        attachments: z
          .array(
            z.object({
              id: z.string(),
              fileName: z.string(),
              fileSize: z.number(),
              mimeType: z.string(),
              url: z.string(),
              thumbnailUrl: z.string().optional(),
            }),
          )
          .optional(),
      })
      .refine((d) => d.content.length > 0 || (d.attachments?.length ?? 0) > 0, {
        message: 'Message must have content or attachments',
      }),
  ),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);

    const userId = c.get('userId');
    const data = c.req.valid('json');

    try {
      const db = c.get('tenantDb');
      const { meetings, workspaceMembers } = schema;

      const [meeting] = await db
        .select({ id: meetings.id, activeSessionId: meetings.activeSessionId })
        .from(meetings)
        .where(eq(meetings.id, data.meetingId))
        .limit(1);
      if (!meeting) return error.notFound(c, 'Meeting', data.meetingId);

      const [author] = await db
        .select({ name: workspaceMembers.name, picture: workspaceMembers.picture })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId))
        .limit(1);

      const id = generateId('mmsg');
      const now = new Date();
      const hasAttachments = !!(data.attachments && data.attachments.length > 0);
      const metadata = data.htmlContent ? { htmlContent: data.htmlContent } : null;

      await db.insert(t).values({
        id,
        meetingId: data.meetingId,
        authorId: userId,
        authorName: author?.name ?? 'Unknown',
        authorAvatar: author?.picture ?? null,
        content: data.content,
        attachments: data.attachments,
        hasAttachments,
        metadata,
        createdAt: now,
        updatedAt: now,
      });

      const message = {
        id,
        meetingId: data.meetingId,
        authorId: userId,
        authorName: author?.name ?? 'Unknown',
        authorAvatar: author?.picture ?? null,
        content: data.content,
        htmlContent: data.htmlContent ?? null,
        type: 'message' as const,
        attachments: data.attachments ?? null,
        hasAttachments,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        deletedAt: null,
        metadata,
      };

      // Realtime publish (best effort)
      try {
        await publishMeetingChatMessage(c.env, data.meetingId, {
          id,
          meetingId: data.meetingId,
          authorId: userId,
          authorName: author?.name ?? 'Unknown',
          authorAvatar: author?.picture ?? undefined,
          content: data.content,
          htmlContent: data.htmlContent,
          type: 'message',
          attachments: data.attachments,
          createdAt: now.toISOString(),
        });
      } catch (e) {
        console.error('[app-api/meeting-messages] realtime publish failed:', e);
      }

      publishEntityEvent({
        c,
        entityType: 'meeting_message',
        entityId: id,
        action: 'created',
        data: { id, meetingId: data.meetingId, authorId: userId, type: 'message' },
      });

      return success(c, message, 201);
    } catch (err) {
      console.error('[app-api/meeting-messages] send failed:', err);
      return error.internal(c, 'Failed to send message');
    }
  },
);

// ============================================================================
// /:id action endpoints — before the generic /:id CRUD handler
// ============================================================================

/**
 * POST /:id/pin - Pin a meeting chat message
 */
app.post('/:id/pin', requirePermission('sessions:create'), async (c) => {
  const userId = c.get('userId');
  const messageId = c.req.param('id');
  const meetingId = c.req.query('meetingId') ?? '';

  try {
    const db = c.get('tenantDb');

    const conditions: any[] = [
      eq(t.id, messageId),
      isNull(t.deletedAt),
    ];
    if (meetingId) conditions.push(eq(t.meetingId, meetingId));

    const [msg] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!msg) return error.notFound(c, 'Message', messageId);

    await db
      .update(t)
      .set({ pinnedAt: new Date(), pinnedBy: userId, updatedAt: new Date() })
      .where(eq(t.id, messageId));

    return success(c, { pinned: true });
  } catch (err) {
    console.error('[app-api/meeting-messages] pin failed:', err);
    return error.internal(c, 'Failed to pin message');
  }
});

/**
 * DELETE /:id/pin - Unpin a meeting chat message
 */
app.delete('/:id/pin', requirePermission('sessions:create'), async (c) => {
  const messageId = c.req.param('id');
  const meetingId = c.req.query('meetingId') ?? '';

  try {
    const db = c.get('tenantDb');

    const conditions: any[] = [eq(t.id, messageId)];
    if (meetingId) conditions.push(eq(t.meetingId, meetingId));

    await db
      .update(t)
      .set({ pinnedAt: null, pinnedBy: null, updatedAt: new Date() })
      .where(and(...conditions));

    return success(c, { pinned: false });
  } catch (err) {
    console.error('[app-api/meeting-messages] unpin failed:', err);
    return error.internal(c, 'Failed to unpin message');
  }
});

/**
 * DELETE /:id - Soft-delete a meeting chat message (author only)
 * Overrides the generic CRUD delete below to enforce author check + realtime publish.
 */
app.delete('/:id', requirePermission('sessions:create'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const userId = c.get('userId');
  const messageId = c.req.param('id');
  const meetingId = c.req.query('meetingId') ?? '';

  try {
    const db = c.get('tenantDb');

    const conditions: any[] = [eq(t.id, messageId), isNull(t.deletedAt)];
    if (meetingId) conditions.push(eq(t.meetingId, meetingId));

    const [msg] = await db
      .select({ authorId: t.authorId, meetingId: t.meetingId })
      .from(t)
      .where(and(...conditions))
      .limit(1);

    if (!msg) return error.notFound(c, 'Message', messageId);
    if (msg.authorId !== userId) return error.forbidden(c, 'You can only delete your own messages');

    await db
      .update(t)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(t.id, messageId));

    try {
      await publishMeetingChatMessageDeleted(c.env, msg.meetingId, messageId);
    } catch (e) {
      console.error('[app-api/meeting-messages] delete realtime publish failed:', e);
    }

    publishEntityEvent({
      c,
      entityType: 'meeting_message',
      entityId: messageId,
      action: 'deleted',
      data: { id: messageId },
    });

    return new Response(null, { status: 204 });
  } catch (err) {
    console.error('[app-api/meeting-messages] delete failed:', err);
    return error.internal(c, 'Failed to delete message');
  }
});

// ============================================================================
// Generic CRUD — /:id (get/patch) and sub-resources
// ============================================================================

app.get('/:id', requirePermission('meetings:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Meeting message', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/meeting-messages] get failed:', err);
    return error.internal(c, 'Failed to fetch meeting message');
  }
});

// NOTE: POST / is handled by the meeting-chat action handler above.

app.patch('/:id', requirePermission('meetings:update'), zValidator('json', updateMeetingMessageSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Meeting message', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'meeting_message',
      entityId: id,
      action: 'updated',
      data: {
        id,
        meetingId: (update.meetingId as string | undefined) ?? existing.meetingId,
        authorId: (update.authorId as string | undefined) ?? existing.authorId,
        type: (update.type as string | undefined) ?? existing.type,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/meeting-messages] update failed:', err);
    return error.internal(c, 'Failed to update meeting message');
  }
});

// NOTE: DELETE /:id is handled by the meeting-chat action handler above (author check + realtime publish).
// The generic CRUD export follows.
/* istanbul ignore next */
app.delete('/:id/_generic', requirePermission('meetings:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Meeting message', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'meeting_message',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/meeting-messages] delete failed:', err);
    return error.internal(c, 'Failed to delete meeting message');
  }
});

export const meetingMessagesRoutes = app;
