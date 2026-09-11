/**
 * Personal booking routes — /api/bookings/*
 * Owner list/get/cancel. Guest create lives on the booking portal.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getPersonalDb, personalSchema } from '../db';
import { error, list, noContent, success, cursorPagination } from '../lib/response';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = personalSchema.personalCalendarBookings;
const events = personalSchema.personalCalendarEvents;

const cancelSchema = z.object({
  cancelReason: z.string().max(500).optional(),
});

app.get('/', async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);
  const db = getPersonalDb(c.env);

  const conditions = [isNull(t.deletedAt), eq(t.personalAccountId, personalAccountId)];
  if (q.bookingPageId) conditions.push(eq(t.bookingPageId, q.bookingPageId));
  if (q.status) conditions.push(eq(t.status, q.status));
  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: t.createdAt, id: t.id })
      .from(t)
      .where(eq(t.id, q.cursor))
      .limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
      );
    }
  }

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(and(...conditions)).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db
        .select({ count: sql<number>`count(*)` })
        .from(t)
        .where(and(isNull(t.deletedAt), eq(t.personalAccountId, personalAccountId))),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
    return list(c, data, cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor));
  } catch (err) {
    console.error('[personal-api/bookings] list failed:', err);
    return error.internal(c, 'Failed to list bookings');
  }
});

app.get('/:id', async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const id = c.req.param('id');
  const db = getPersonalDb(c.env);
  try {
    const [row] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.personalAccountId, personalAccountId), isNull(t.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'Booking', id);
    return success(c, row);
  } catch (err) {
    console.error('[personal-api/bookings] get failed:', err);
    return error.internal(c, 'Failed to fetch booking');
  }
});

app.patch('/:id/cancel', zValidator('json', cancelSchema), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const id = c.req.param('id');
  const { cancelReason } = c.req.valid('json');
  const db = getPersonalDb(c.env);
  const now = new Date();

  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.personalAccountId, personalAccountId), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Booking', id);

    await db
      .update(t)
      .set({
        status: 'cancelled',
        cancelledAt: now,
        cancelReason: cancelReason ?? null,
        updatedAt: now,
      })
      .where(and(eq(t.id, id), eq(t.personalAccountId, personalAccountId)));

    if (existing.calendarEventId) {
      await db
        .update(events)
        .set({ status: 'cancelled', updatedAt: now })
        .where(
          and(
            eq(events.id, existing.calendarEventId),
            eq(events.personalAccountId, personalAccountId),
            isNull(events.deletedAt),
          ),
        );
    }

    return success(c, { id, status: 'cancelled' });
  } catch (err) {
    console.error('[personal-api/bookings] cancel failed:', err);
    return error.internal(c, 'Failed to cancel booking');
  }
});

app.delete('/:id', async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const id = c.req.param('id');
  const db = getPersonalDb(c.env);
  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.personalAccountId, personalAccountId), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Booking', id);

    await db
      .update(t)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(t.id, id), eq(t.personalAccountId, personalAccountId)));

    return noContent(c);
  } catch (err) {
    console.error('[personal-api/bookings] delete failed:', err);
    return error.internal(c, 'Failed to delete booking');
  }
});

export const bookingsRoutes = app;
