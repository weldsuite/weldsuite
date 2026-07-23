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
  createCalendarSchema,
  updateCalendarSchema,
} from '@weldsuite/core-api-client/schemas/calendars';

const listCalendarsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  ownerId: z.string().optional(),
});

const table = schema.calendars;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('calendars:read'), zValidator('query', listCalendarsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) where.push(like(table.name, `%${q.search}%`));
  if (q.ownerId) where.push(eq(table.ownerId, q.ownerId));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('calendars:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Calendar', id);
  return success(c, row);
});

app.post('/', requireScope('calendars:write'), zValidator('json', createCalendarSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('cal');
  const values = { ...(body as Record<string, unknown>), id, ownerId: (body as Record<string, unknown>).ownerId ?? c.get('userId'), createdAt: now, updatedAt: now };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create calendar');
  publishEntityEvent({
    c,
    entityType: 'calendar',
    entityId: id,
    action: 'created',
    data: { id, name: row.name },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('calendars:write'), zValidator('json', updateCalendarSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Calendar', id);
  publishEntityEvent({
    c,
    entityType: 'calendar',
    entityId: id,
    action: 'updated',
    data: { id, name: row.name },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('calendars:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Calendar', id);
  publishEntityEvent({
    c,
    entityType: 'calendar',
    entityId: id,
    action: 'deleted',
    data: { id, name: row.name },
  });
  return noContent(c);
});

export default app;
