import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq, like, type SQL } from 'drizzle-orm';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  createChatSectionSchema,
  updateChatSectionSchema,
} from '@weldsuite/core-api-client/schemas/chat-sections';

/** chat-sections has no deletedAt — hard delete. Events omitted (no registered entityType). */

const listChatSectionsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
});

const table = schema.chatSections;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('chat_sections:read'), zValidator('query', listChatSectionsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) where.push(like(table.name, `%${q.search}%`));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('chat_sections:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  if (!row) return error.notFound(c, 'ChatSection', id);
  return success(c, row);
});

app.post('/', requireScope('chat_sections:write'), zValidator('json', createChatSectionSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('csec');
  const values = { ...(body as Record<string, unknown>), id, createdAt: now, updatedAt: now };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create chat section');
  return success(c, row, 201);
});

app.patch('/:id', requireScope('chat_sections:write'), zValidator('json', updateChatSectionSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...(body as Record<string, unknown>), updatedAt: new Date() })
    .where(eq(table.id, id))
    .returning();
  if (!row) return error.notFound(c, 'ChatSection', id);
  return success(c, row);
});

app.delete('/:id', requireScope('chat_sections:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .delete(table)
    .where(eq(table.id, id))
    .returning();
  if (!row) return error.notFound(c, 'ChatSection', id);
  return noContent(c);
});

export default app;
