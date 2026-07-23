/**
 * WeldChat activity routes — flat /api/chat-activity/* surface.
 *
 * Surfaces the WeldChat activity feed from chat-category notifications.
 *
 *   GET  /                 — cursor-paginated list (filter: all|mentions|replies|dms)
 *   POST /read             — mark one or all as read (204)
 *   GET  /unread-count     — { data: { count: number } }
 *
 * Scope note: the notifications table has no workspaceId column — rows are
 * intrinsically per-user (scoped by the Clerk userId). Queries filter by
 * userId only.
 *
 * WeldChat streams over its own ChatRoom DO, not the entity-event bus — no
 * entity events are published here.
 *
 * Permissions: messages:read (read feed) | messages:update (mark read).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.notifications;

type ActivityFilter = 'all' | 'mentions' | 'replies' | 'dms';

const FILTER_TYPES: Record<ActivityFilter, string[]> = {
  all: ['chat_mention', 'chat_dm', 'chat_thread_reply', 'chat_missed_call'],
  mentions: ['chat_mention'],
  replies: ['chat_thread_reply'],
  dms: ['chat_dm'],
};

const listActivityQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  filter: z.enum(['all', 'mentions', 'replies', 'dms']).default('all'),
});

const markReadBodySchema = z.object({
  notificationId: z.string().optional(),
});

app.get('/', requirePermission('messages:read'), zValidator('query', listActivityQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const { cursor, limit, filter } = c.req.valid('query');
  const { chatChannels, chatMessages } = schema;
  const types = FILTER_TYPES[filter];

  // Decode cursor: base64 JSON { createdAt, id }, ordering createdAt DESC, id DESC.
  let cursorCreatedAt: Date | null = null;
  let cursorId: string | null = null;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as {
        createdAt: string;
        id: string;
      };
      cursorCreatedAt = new Date(decoded.createdAt);
      cursorId = decoded.id;
    } catch {
      // Ignore malformed cursors
    }
  }

  const baseConditions = [
    eq(t.userId, userId),
    eq(t.category, 'weldchat'),
    isNull(t.deletedAt),
    inArray(t.notificationType, types),
  ];
  const conditions = [...baseConditions];
  if (cursorCreatedAt && cursorId) {
    conditions.push(
      sql`(${t.createdAt} < ${cursorCreatedAt} OR (${t.createdAt} = ${cursorCreatedAt} AND ${t.id} < ${cursorId}))`,
    );
  }

  try {
    const [rows, countResult] = await Promise.all([
      db
        .select({
          id: t.id,
          notificationType: t.notificationType,
          title: t.title,
          body: t.body,
          entityType: t.entityType,
          entityId: t.entityId,
          actorId: t.actorId,
          actionUrl: t.actionUrl,
          readAt: t.readAt,
          createdAt: t.createdAt,
          channelId: sql<string | null>`(${t.data}->>'channelId')`,
          channelName: chatChannels.name,
          messageContent: sql<
            string | null
          >`CASE WHEN ${t.entityType} = 'message' THEN ${chatMessages.content} ELSE NULL END`,
        })
        .from(t)
        .leftJoin(chatChannels, sql`${chatChannels.id} = (${t.data}->>'channelId')`)
        .leftJoin(
          chatMessages,
          and(eq(t.entityType, 'message'), eq(chatMessages.id, sql<string>`COALESCE(${t.entityId}, '')`)),
        )
        .where(and(...conditions))
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(and(...baseConditions)),
    ]);

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = data[data.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? Buffer.from(
            JSON.stringify({ createdAt: lastRow.createdAt.toISOString(), id: lastRow.id }),
          ).toString('base64')
        : null;
    const totalCount = Number(countResult[0]?.count ?? 0);

    const items = data.map((row) => ({
      id: row.id,
      type: row.notificationType,
      title: row.title,
      body: row.body ?? null,
      channelId: row.channelId ?? null,
      channelName: row.channelName ?? null,
      messageId: row.entityType === 'message' ? (row.entityId ?? null) : null,
      actorId: row.actorId ?? null,
      actorName: null,
      actorAvatarUrl: null,
      actionUrl: row.actionUrl ?? null,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    }));

    return list(c, items, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/chat-activity] list failed:', err);
    return error.internal(c, 'Failed to fetch activity');
  }
});

// Marking your own activity feed read is a personal, self-scoped action —
// gate on messages:read (which VIEWER-tier roles hold), not messages:update
// (message editing); the legacy core-api route was ungated and userId-scoped.
app.post('/read', requirePermission('messages:read'), zValidator('json', markReadBodySchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const { notificationId } = c.req.valid('json');

  try {
    const conditions = [
      eq(t.userId, userId),
      eq(t.category, 'weldchat'),
      isNull(t.readAt),
      isNull(t.deletedAt),
    ];
    if (notificationId) conditions.push(eq(t.id, notificationId));

    await db.update(t).set({ readAt: new Date(), isRead: true }).where(and(...conditions));
    return noContent(c);
  } catch (err) {
    console.error('[app-api/chat-activity] mark read failed:', err);
    return error.internal(c, 'Failed to mark activity as read');
  }
});

app.get('/unread-count', requirePermission('messages:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');

  try {
    const [result] = await db
      .select({ count: sql<number>`count(*)` })
      .from(t)
      .where(
        and(
          eq(t.userId, userId),
          eq(t.category, 'weldchat'),
          isNull(t.readAt),
          isNull(t.deletedAt),
        ),
      );
    return success(c, { count: Number(result?.count ?? 0) });
  } catch (err) {
    console.error('[app-api/chat-activity] unread count failed:', err);
    return error.internal(c, 'Failed to get unread count');
  }
});

export const chatActivityRoutes = app;
