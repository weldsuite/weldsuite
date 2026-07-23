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
  createChannelMemberSchema,
  updateChannelMemberSchema,
} from '@weldsuite/core-api-client/schemas/channel-members';

/** channel-members has no deletedAt — hard delete. Events omitted (no registered entityType). */

const listChannelMembersQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  channelId: z.string().optional(),
  userId: z.string().optional(),
});

const table = schema.chatChannelMembers;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('channel_members:read'), zValidator('query', listChannelMembersQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.channelId) where.push(eq(table.channelId, q.channelId));
  if (q.userId) where.push(eq(table.userId, q.userId));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('channel_members:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  if (!row) return error.notFound(c, 'ChannelMember', id);
  return success(c, row);
});

app.post('/', requireScope('channel_members:write'), zValidator('json', createChannelMemberSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('chm');
  const values = { ...(body as Record<string, unknown>), id, createdAt: now };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create channel member');
  return success(c, row, 201);
});

app.patch('/:id', requireScope('channel_members:write'), zValidator('json', updateChannelMemberSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set(body as Partial<typeof table.$inferInsert>)
    .where(eq(table.id, id))
    .returning();
  if (!row) return error.notFound(c, 'ChannelMember', id);
  return success(c, row);
});

app.delete('/:id', requireScope('channel_members:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .delete(table)
    .where(eq(table.id, id))
    .returning();
  if (!row) return error.notFound(c, 'ChannelMember', id);
  return noContent(c);
});

export default app;
