import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq, type SQL } from 'drizzle-orm';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  createChatBookmarkSchema,
  updateChatBookmarkSchema,
} from '@weldsuite/core-api-client/schemas/chat-bookmarks';

/** chat-bookmarks has no deletedAt — hard delete. Events omitted (no registered entityType). */

const listChatBookmarksQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  userId: z.string().optional(),
  channelId: z.string().optional(),
});

const table = schema.chatBookmarks;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('chat_bookmarks:read'), zValidator('query', listChatBookmarksQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.userId) where.push(eq(table.userId, q.userId));
  if (q.channelId) where.push(eq(table.channelId, q.channelId));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('chat_bookmarks:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  if (!row) return error.notFound(c, 'ChatBookmark', id);
  return success(c, row);
});

app.post('/', requireScope('chat_bookmarks:write'), zValidator('json', createChatBookmarkSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json') as Record<string, unknown>;
  const now = new Date();
  const id = generateId('cbk');
  const values = {
    ...body,
    id,
    userId: (body.userId as string | undefined) ?? c.get('userId'),
    messageId: (body.messageId as string | undefined) ?? '',
    channelId: (body.channelId as string | undefined) ?? '',
    createdAt: now,
  };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create chat bookmark');
  return success(c, row, 201);
});

app.patch('/:id', requireScope('chat_bookmarks:write'), zValidator('json', updateChatBookmarkSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set(body as Partial<typeof table.$inferInsert>)
    .where(eq(table.id, id))
    .returning();
  if (!row) return error.notFound(c, 'ChatBookmark', id);
  return success(c, row);
});

app.delete('/:id', requireScope('chat_bookmarks:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .delete(table)
    .where(eq(table.id, id))
    .returning();
  if (!row) return error.notFound(c, 'ChatBookmark', id);
  return noContent(c);
});

export default app;
