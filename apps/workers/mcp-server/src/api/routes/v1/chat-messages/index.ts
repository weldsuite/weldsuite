import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, like, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  createChatMessageSchema,
  updateChatMessageSchema,
} from '@weldsuite/core-api-client/schemas/chat-messages';

const listChatMessagesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  channelId: z.string().optional(),
  parentId: z.string().optional(),
});

const table = schema.chatMessages;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('chat_messages:read'), zValidator('query', listChatMessagesQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) where.push(like(table.content, `%${q.search}%`));
  if (q.channelId) where.push(eq(table.channelId, q.channelId));
  if (q.parentId) where.push(eq(table.parentId, q.parentId));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('chat_messages:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'ChatMessage', id);
  return success(c, row);
});

app.post('/', requireScope('chat_messages:write'), zValidator('json', createChatMessageSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json') as Record<string, unknown>;
  const now = new Date();
  const id = generateId('cmsg');
  // Map schema `body` to table `content`; required fields filled with defaults.
  const { body: msgBody, ...rest } = body;
  const values = {
    ...rest,
    id,
    content: typeof msgBody === 'string' ? msgBody : '',
    authorId: (rest.authorId as string | undefined) ?? c.get('userId'),
    authorName: (rest.authorName as string | undefined) ?? '',
    createdAt: now,
    updatedAt: now,
  };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create chat message');
  publishEntityEvent({
    c,
    entityType: 'chat_message',
    entityId: id,
    action: 'created',
    data: { id, channelId: row.channelId },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('chat_messages:write'), zValidator('json', updateChatMessageSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json') as Record<string, unknown>;
  const { body: msgBody, ...rest } = body;
  const setValues: Record<string, unknown> = { ...rest, updatedAt: new Date() };
  if (msgBody !== undefined) setValues.content = msgBody;
  const [row] = await db
    .update(table)
    .set(setValues as Partial<typeof table.$inferInsert>)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'ChatMessage', id);
  publishEntityEvent({
    c,
    entityType: 'chat_message',
    entityId: id,
    action: 'updated',
    data: { id, channelId: row.channelId },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('chat_messages:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'ChatMessage', id);
  publishEntityEvent({
    c,
    entityType: 'chat_message',
    entityId: id,
    action: 'deleted',
    data: { id, channelId: row.channelId },
  });
  return noContent(c);
});

export default app;
