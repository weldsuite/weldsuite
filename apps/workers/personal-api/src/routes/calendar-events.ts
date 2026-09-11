/**
 * Personal calendar event routes — /api/calendar-events/*
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, isNull, like, lte, or, sql } from 'drizzle-orm';
import { getPersonalDb, personalSchema } from '../db';
import { error, list, noContent, success, cursorPagination } from '../lib/response';
import { generateId } from '../lib/id';
import { getCalendarForAccount, resolveRequestedCalendarIds } from '../services/calendar-access';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = personalSchema.personalCalendarEvents;

const attendeeSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  status: z.string().optional(),
  role: z.string().optional(),
});

const createSchema = z.object({
  calendarId: z.string().min(1),
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  type: z.enum(['meeting', 'call', 'appointment', 'event', 'reminder', 'other']).default('meeting'),
  startTime: z.string().min(1),
  endTime: z.string().optional(),
  allDay: z.boolean().optional(),
  timezone: z.string().optional(),
  location: z.string().optional(),
  isVirtual: z.boolean().optional(),
  meetingUrl: z.string().optional(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  color: z.string().optional(),
  recurrenceRule: z.string().optional(),
  recurrenceId: z.string().optional(),
  attendees: z.array(attendeeSchema).optional(),
  reminders: z
    .array(z.object({ type: z.enum(['email', 'notification']), minutes: z.number() }))
    .optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const updateSchema = createSchema.partial().omit({ calendarId: true, recurrenceId: true });

const listQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(25),
  cursor: z.string().optional(),
  search: z.string().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  calendarIds: z.string().optional(),
});

const rangeQuerySchema = z.object({
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  calendarIds: z.string().optional(),
});

app.get('/', zValidator('query', listQuerySchema), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const q = c.req.valid('query');
  const db = getPersonalDb(c.env);

  try {
    const calendarIds = await resolveRequestedCalendarIds(db, personalAccountId, q.calendarIds);
    if (calendarIds.length === 0) {
      return list(c, [], cursorPagination(0, false, null));
    }

    const conditions = [
      isNull(t.deletedAt),
      eq(t.personalAccountId, personalAccountId),
      inArray(t.calendarId, calendarIds),
    ];
    if (q.type) conditions.push(eq(t.type, q.type));
    if (q.status) conditions.push(eq(t.status, q.status));
    if (q.startDate) conditions.push(gte(t.startTime, new Date(q.startDate)));
    if (q.endDate) conditions.push(lte(t.startTime, new Date(q.endDate)));
    if (q.search) {
      const term = `%${q.search}%`;
      conditions.push(or(like(t.title, term), like(t.description, term))!);
    }

    const filterConditions = [...conditions];
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

    const [rows, countRes] = await Promise.all([
      db
        .select()
        .from(t)
        .where(and(...conditions))
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(q.limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(and(...filterConditions)),
    ]);

    const hasMore = rows.length > q.limit;
    const data = hasMore ? rows.slice(0, q.limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
    return list(c, data, cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor));
  } catch (err) {
    console.error('[personal-api/calendar-events] list failed:', err);
    return error.internal(c, 'Failed to list calendar events');
  }
});

app.get('/range', zValidator('query', rangeQuerySchema), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const q = c.req.valid('query');
  const db = getPersonalDb(c.env);

  try {
    const calendarIds = await resolveRequestedCalendarIds(db, personalAccountId, q.calendarIds);
    if (calendarIds.length === 0) return success(c, []);

    const rows = await db
      .select()
      .from(t)
      .where(
        and(
          isNull(t.deletedAt),
          eq(t.personalAccountId, personalAccountId),
          inArray(t.calendarId, calendarIds),
          gte(t.startTime, new Date(q.startDate)),
          lte(t.startTime, new Date(q.endDate)),
        ),
      )
      .orderBy(asc(t.startTime));

    return success(c, rows);
  } catch (err) {
    console.error('[personal-api/calendar-events] range failed:', err);
    return error.internal(c, 'Failed to fetch events');
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
    if (!row) return error.notFound(c, 'Calendar event', id);
    return success(c, row);
  } catch (err) {
    console.error('[personal-api/calendar-events] get failed:', err);
    return error.internal(c, 'Failed to fetch calendar event');
  }
});

app.post('/', zValidator('json', createSchema), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const data = c.req.valid('json');
  const db = getPersonalDb(c.env);
  const userId = c.get('userId');

  try {
    const calendar = await getCalendarForAccount(db, personalAccountId, data.calendarId);
    if (!calendar) return error.forbidden(c);

    const id = generateId('evt');
    const now = new Date();
    await db.insert(t).values({
      id,
      personalAccountId,
      calendarId: data.calendarId,
      title: data.title,
      description: data.description,
      type: data.type,
      startTime: new Date(data.startTime),
      endTime: data.endTime ? new Date(data.endTime) : null,
      allDay: data.allDay,
      timezone: data.timezone,
      location: data.location,
      isVirtual: data.isVirtual,
      meetingUrl: data.meetingUrl,
      status: data.status || 'confirmed',
      priority: data.priority || 'normal',
      color: data.color,
      recurrenceRule: data.recurrenceRule,
      recurrenceId: data.recurrenceId,
      organizerId: userId,
      attendees: data.attendees,
      reminders: data.reminders,
      notes: data.notes,
      tags: data.tags,
      createdAt: now,
      updatedAt: now,
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[personal-api/calendar-events] create failed:', err);
    return error.internal(c, 'Failed to create calendar event');
  }
});

app.patch('/:id', zValidator('json', updateSchema), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const id = c.req.param('id');
  const data = c.req.valid('json');
  const db = getPersonalDb(c.env);

  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.personalAccountId, personalAccountId), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Calendar event', id);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (k === 'startTime' || k === 'endTime') update[k] = new Date(v as string);
      else update[k] = v;
    }

    await db
      .update(t)
      .set(update)
      .where(and(eq(t.id, id), eq(t.personalAccountId, personalAccountId), isNull(t.deletedAt)));

    return success(c, { id, ...data });
  } catch (err) {
    console.error('[personal-api/calendar-events] update failed:', err);
    return error.internal(c, 'Failed to update calendar event');
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
    if (!existing) return error.notFound(c, 'Calendar event', id);

    await db
      .update(t)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(t.id, id), eq(t.personalAccountId, personalAccountId), isNull(t.deletedAt)));

    return noContent(c);
  } catch (err) {
    console.error('[personal-api/calendar-events] delete failed:', err);
    return error.internal(c, 'Failed to delete calendar event');
  }
});

app.patch('/:id/cancel', async (c) => {
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
    if (!existing) return error.notFound(c, 'Calendar event', id);

    await db
      .update(t)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(t.id, id), eq(t.personalAccountId, personalAccountId), isNull(t.deletedAt)));

    return success(c, { id, status: 'cancelled' });
  } catch (err) {
    console.error('[personal-api/calendar-events] cancel failed:', err);
    return error.internal(c, 'Failed to cancel calendar event');
  }
});

export const calendarEventsRoutes = app;
