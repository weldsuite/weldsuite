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
  createChannelSchema,
  updateChannelSchema,
} from '@weldsuite/core-api-client/schemas/channels';

const listChannelsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  type: z.string().optional(),
});

const table = schema.chatChannels;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('channels:read'), zValidator('query', listChannelsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) where.push(like(table.name, `%${q.search}%`));
  if (q.type) where.push(eq(table.type, q.type));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Channel', id);
  return success(c, row);
});

app.post('/', requireScope('channels:write'), zValidator('json', createChannelSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json') as Record<string, unknown>;
  const now = new Date();
  const id = generateId('ch');
  // `slug` is NOT NULL at the DB; derive from `name` when not provided.
  const slug =
    typeof body.slug === 'string' && (body.slug as string).length > 0
      ? (body.slug as string)
      : typeof body.name === 'string'
        ? (body.name as string)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 255) || id
        : id;
  const values = { ...body, id, slug, createdAt: now, updatedAt: now };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create channel');
  publishEntityEvent({
    c,
    entityType: 'chat_channel',
    entityId: id,
    action: 'created',
    data: { id, name: row.name },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('channels:write'), zValidator('json', updateChannelSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Channel', id);
  publishEntityEvent({
    c,
    entityType: 'chat_channel',
    entityId: id,
    action: 'updated',
    data: { id, name: row.name },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('channels:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Channel', id);
  publishEntityEvent({
    c,
    entityType: 'chat_channel',
    entityId: id,
    action: 'deleted',
    data: { id, name: row.name },
  });
  return noContent(c);
});

export default app;
