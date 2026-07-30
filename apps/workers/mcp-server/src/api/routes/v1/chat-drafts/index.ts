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
  createChatDraftSchema,
  updateChatDraftSchema,
} from '@weldsuite/core-api-client/schemas/chat-drafts';

/** chat-drafts has no deletedAt — hard delete. Events omitted (no registered entityType). */

const listChatDraftsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  channelId: z.string().optional(),
  userId: z.string().optional(),
});

const table = schema.chatDrafts;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('chat_drafts:read'), zValidator('query', listChatDraftsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.channelId) where.push(eq(table.channelId, q.channelId));
  if (q.userId) where.push(eq(table.userId, q.userId));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('chat_drafts:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  if (!row) return error.notFound(c, 'ChatDraft', id);
  return success(c, row);
});

app.post('/', requireScope('chat_drafts:write'), zValidator('json', createChatDraftSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json') as Record<string, unknown>;
  const now = new Date();
  const id = generateId('cdft');
  const values = {
    ...body,
    id,
    workspaceId: (body.workspaceId as string | undefined) ?? c.get('workspaceId'),
    userId: (body.userId as string | undefined) ?? c.get('userId'),
    content: (body.body as string | undefined) ?? (body.content as string | undefined) ?? '',
    createdAt: now,
    updatedAt: now,
  };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create chat draft');
  return success(c, row, 201);
});

app.patch('/:id', requireScope('chat_drafts:write'), zValidator('json', updateChatDraftSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json') as Record<string, unknown>;
  const { body: msgBody, ...rest } = body;
  const setValues: Record<string, unknown> = { ...rest, updatedAt: new Date() };
  if (msgBody !== undefined) setValues.content = msgBody;
  const [row] = await db
    .update(table)
    .set(setValues as Partial<typeof table.$inferInsert>)
    .where(eq(table.id, id))
    .returning();
  if (!row) return error.notFound(c, 'ChatDraft', id);
  return success(c, row);
});

app.delete('/:id', requireScope('chat_drafts:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .delete(table)
    .where(eq(table.id, id))
    .returning();
  if (!row) return error.notFound(c, 'ChatDraft', id);
  return noContent(c);
});

export default app;
