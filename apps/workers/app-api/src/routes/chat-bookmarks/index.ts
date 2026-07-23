/**
 * Chat bookmark routes — flat /api/chat-bookmarks/* surface backed by `chatBookmarks`.
 *
 * A bookmark is a personal, self-scoped resource, so every handler sits on the
 * `messages:*` tier the legacy api-worker bookmark routes used and that
 * SYSTEM_ROLES.MEMBER actually holds (messages:read/create/update/delete).
 * Gating any of these on `channels:update` / `channels:delete` — which MEMBER
 * does NOT hold — 403s a member out of a bookmark they own. Every handler
 * additionally scopes to the authenticated owner.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.chatBookmarks;

// Explicit field lists — the `@weldsuite/core-api-client` bookmark schemas are
// `.passthrough()` shells and this route feeds Drizzle directly.
const createChatBookmarkSchema = z.object({
  messageId: z.string().min(1),
  channelId: z.string().min(1),
  note: z.string().optional(),
});

const updateChatBookmarkSchema = z.object({
  note: z.string().nullable().optional(),
});

/**
 * The display shape the bookmarks page, panel and popover render. The bare
 * `chat_bookmarks` row carries only ids, so the legacy route left-joined the
 * message and channel — without this the whole bookmarks UI renders blank.
 */
const bookmarkListSelection = {
  id: t.id,
  userId: t.userId,
  messageId: t.messageId,
  channelId: t.channelId,
  note: t.note,
  createdAt: t.createdAt,
  // Message fields
  messageContent: schema.chatMessages.content,
  messageAuthorId: schema.chatMessages.authorId,
  messageAuthorName: schema.chatMessages.authorName,
  messageAuthorAvatar: schema.chatMessages.authorAvatar,
  messageCreatedAt: schema.chatMessages.createdAt,
  messageAttachments: schema.chatMessages.attachments,
  // Channel fields
  channelName: schema.chatChannels.name,
  channelSlug: schema.chatChannels.slug,
  channelType: schema.chatChannels.type,
} as const;

app.get('/', requirePermission('messages:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  // Owner boundary: a bookmark is private to its author. Always scope to the
  // caller — never trust a body/query-supplied userId.
  const conditions: any[] = [eq(t.userId, userId)];
  if (q.channelId !== undefined && q.channelId !== '') conditions.push(eq(t.channelId, q.channelId));
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
      db
        .select(bookmarkListSelection)
        .from(t)
        .leftJoin(schema.chatMessages, eq(t.messageId, schema.chatMessages.id))
        .leftJoin(schema.chatChannels, eq(t.channelId, schema.chatChannels.id))
        .where(where)
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/chat-bookmarks] list failed:', err);
    return error.internal(c, 'Failed to list chat bookmarks');
  }
});

app.get('/:id', requirePermission('messages:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [row] = await db
      .select(bookmarkListSelection)
      .from(t)
      .leftJoin(schema.chatMessages, eq(t.messageId, schema.chatMessages.id))
      .leftJoin(schema.chatChannels, eq(t.channelId, schema.chatChannels.id))
      .where(and(eq(t.id, id), eq(t.userId, userId)))
      .limit(1);
    if (!row) return error.notFound(c, 'Chat bookmark', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/chat-bookmarks] get failed:', err);
    return error.internal(c, 'Failed to fetch chat bookmark');
  }
});

app.post('/', requirePermission('messages:create'), zValidator('json', createChatBookmarkSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json');
  const now = new Date();
  try {
    // Bookmarking the same message twice is a no-op, not a 500: the table is
    // UNIQUE on (userId, messageId) and the star toggles optimistically.
    const [existing] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.userId, userId), eq(t.messageId, data.messageId)))
      .limit(1);
    if (existing) return success(c, { id: existing.id, alreadyExists: true });

    const id = generateId('cbk');
    // Stamp the authenticated caller as the owner — never trust a body userId.
    await db.insert(t).values({
      id,
      userId,
      messageId: data.messageId,
      channelId: data.channelId,
      note: data.note,
      createdAt: now,
    });
    return success(c, { id, userId, ...data, createdAt: now }, 201);
  } catch (err) {
    console.error('[app-api/chat-bookmarks] create failed:', err);
    return error.internal(c, 'Failed to create chat bookmark');
  }
});

app.patch('/:id', requirePermission('messages:update'), zValidator('json', updateChatBookmarkSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.userId, userId)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Chat bookmark', id);
    const update: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) if (v !== undefined && k !== 'userId') update[k] = v;
    if (Object.keys(update).length > 0) {
      await db.update(t).set(update).where(and(eq(t.id, id), eq(t.userId, userId)));
    }
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/chat-bookmarks] update failed:', err);
    return error.internal(c, 'Failed to update chat bookmark');
  }
});

app.delete('/:id', requirePermission('messages:delete'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.userId, userId)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Chat bookmark', id);
    await db.delete(t).where(and(eq(t.id, id), eq(t.userId, userId)));
    return noContent(c);
  } catch (err) {
    console.error('[app-api/chat-bookmarks] delete failed:', err);
    return error.internal(c, 'Failed to delete chat bookmark');
  }
});

export const chatBookmarksRoutes = app;
