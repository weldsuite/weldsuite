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
  createCalendarEventSchema,
  updateCalendarEventSchema,
} from '@weldsuite/core-api-client/schemas/calendar-events';

const listCalendarEventsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  calendarId: z.string().optional(),
});

/** Coerce schema field names (startsAt/endsAt) to DB column names (startTime/endTime). */
function coerceDates(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  // Map startsAt → startTime and endsAt → endTime (schema uses different names than DB columns)
  if (typeof out.startsAt === 'string') {
    out.startTime = new Date(out.startsAt as string);
    delete out.startsAt;
  }
  if (typeof out.endsAt === 'string') {
    out.endTime = new Date(out.endsAt as string);
    delete out.endsAt;
  }
  // Also handle if already mapped
  if (typeof out.startTime === 'string') out.startTime = new Date(out.startTime as string);
  if (typeof out.endTime === 'string') out.endTime = new Date(out.endTime as string);
  return out;
}

const table = schema.calendarEvents;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('calendar_events:read'), zValidator('query', listCalendarEventsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) where.push(like(table.title, `%${q.search}%`));
  if (q.calendarId) where.push(eq(table.calendarId, q.calendarId));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('calendar_events:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'CalendarEvent', id);
  return success(c, row);
});

app.post('/', requireScope('calendar_events:write'), zValidator('json', createCalendarEventSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('evt');
  const values = {
    ...coerceDates(body as Record<string, unknown>),
    id,
    organizerId: (body as Record<string, unknown>).organizerId ?? c.get('userId'),
    type: (body as Record<string, unknown>).type ?? 'event',
    createdAt: now,
    updatedAt: now,
  };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create calendar event');
  publishEntityEvent({
    c,
    entityType: 'calendar_event',
    entityId: id,
    action: 'created',
    data: { id, title: row.title, calendarId: row.calendarId },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('calendar_events:write'), zValidator('json', updateCalendarEventSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...coerceDates(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'CalendarEvent', id);
  publishEntityEvent({
    c,
    entityType: 'calendar_event',
    entityId: id,
    action: 'updated',
    data: { id, title: row.title, calendarId: row.calendarId },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('calendar_events:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'CalendarEvent', id);
  publishEntityEvent({
    c,
    entityType: 'calendar_event',
    entityId: id,
    action: 'deleted',
    data: { id, title: row.title, calendarId: row.calendarId },
  });
  return noContent(c);
});

export default app;
