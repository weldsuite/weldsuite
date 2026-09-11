/**
 * Personal booking-page routes — /api/booking-pages/*
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { getPersonalDb, personalSchema } from '../db';
import { error, list, noContent, success, cursorPagination } from '../lib/response';
import { generateId } from '../lib/id';
import {
  computeAvailableSlots,
  type WeeklyAvailability,
} from '../services/calendar-slots';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = personalSchema.personalCalendarBookingPages;

const availabilityRange = z.object({ start: z.string(), end: z.string() });
const availabilitySchema = z.object({
  monday: z.array(availabilityRange),
  tuesday: z.array(availabilityRange),
  wednesday: z.array(availabilityRange),
  thursday: z.array(availabilityRange),
  friday: z.array(availabilityRange),
  saturday: z.array(availabilityRange),
  sunday: z.array(availabilityRange),
});

const questionSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(['text', 'textarea', 'select']),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
});

const slugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase letters, numbers, and hyphens');

const createSchema = z.object({
  name: z.string().min(1).max(255),
  slug: slugSchema,
  description: z.string().optional(),
  duration: z.number().int().min(5).max(480),
  bufferBefore: z.number().int().min(0).max(240).optional(),
  bufferAfter: z.number().int().min(0).max(240).optional(),
  color: z.string().max(20).optional(),
  isActive: z.boolean().optional(),
  locationType: z.enum(['in-person', 'phone', 'video']).optional(),
  locationValue: z.string().max(500).optional(),
  availability: availabilitySchema,
  questions: z.array(questionSchema).optional(),
  minNotice: z.number().int().min(0).optional(),
  maxAdvance: z.number().int().min(1).max(365).optional(),
  confirmationMessage: z.string().optional(),
  timezone: z.string().max(100).optional(),
});

const updateSchema = createSchema.partial();

const slotsQuerySchema = z.object({
  date: z.string().min(1),
});

app.get('/', async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);
  const db = getPersonalDb(c.env);

  const conditions = [isNull(t.deletedAt), eq(t.personalAccountId, personalAccountId)];
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(t.name, term), like(t.slug, term))!);
  }
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
    console.error('[personal-api/booking-pages] list failed:', err);
    return error.internal(c, 'Failed to list booking pages');
  }
});

app.get('/:id/available-slots', zValidator('query', slotsQuerySchema), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const id = c.req.param('id');
  const { date } = c.req.valid('query');
  const db = getPersonalDb(c.env);

  try {
    const [page] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.personalAccountId, personalAccountId), isNull(t.deletedAt)))
      .limit(1);
    if (!page) return error.notFound(c, 'Booking page', id);

    const slots = await computeAvailableSlots(
      db,
      {
        personalAccountId,
        availability: page.availability as WeeklyAvailability | null,
        timezone: page.timezone,
        duration: page.duration,
        bufferBefore: page.bufferBefore,
        bufferAfter: page.bufferAfter,
        minNotice: page.minNotice,
      },
      date,
    );
    return success(c, slots);
  } catch (err) {
    console.error('[personal-api/booking-pages] available-slots failed:', err);
    return error.internal(c, 'Failed to compute available slots');
  }
});

app.patch('/:id/toggle', async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const id = c.req.param('id');
  const db = getPersonalDb(c.env);

  try {
    const [record] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.personalAccountId, personalAccountId), isNull(t.deletedAt)))
      .limit(1);
    if (!record) return error.notFound(c, 'Booking page', id);

    const isActive = !record.isActive;
    await db
      .update(t)
      .set({ isActive, updatedAt: new Date() })
      .where(and(eq(t.id, id), eq(t.personalAccountId, personalAccountId)));

    return success(c, { id, isActive });
  } catch (err) {
    console.error('[personal-api/booking-pages] toggle failed:', err);
    return error.internal(c, 'Failed to toggle booking page');
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
    if (!row) return error.notFound(c, 'Booking page', id);
    return success(c, row);
  } catch (err) {
    console.error('[personal-api/booking-pages] get failed:', err);
    return error.internal(c, 'Failed to fetch booking page');
  }
});

app.post('/', zValidator('json', createSchema), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const data = c.req.valid('json');
  const entitlements = c.get('entitlements');
  const db = getPersonalDb(c.env);

  try {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(t)
      .where(and(eq(t.personalAccountId, personalAccountId), isNull(t.deletedAt)));

    if (Number(count) >= entitlements.maxBookingPages) {
      return error.planLimit(c, 'Booking page limit reached for your plan', {
        maxBookingPages: entitlements.maxBookingPages,
      });
    }

    const [taken] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.slug, data.slug), isNull(t.deletedAt)))
      .limit(1);
    if (taken) return error.conflict(c, 'That booking slug is already taken');

    const id = generateId('bpg');
    const now = new Date();
    await db.insert(t).values({
      id,
      personalAccountId,
      name: data.name,
      slug: data.slug,
      description: data.description,
      ownerId: c.get('userId'),
      duration: data.duration,
      bufferBefore: data.bufferBefore ?? 0,
      bufferAfter: data.bufferAfter ?? 0,
      color: data.color,
      isActive: data.isActive ?? true,
      locationType: data.locationType,
      locationValue: data.locationValue,
      availability: data.availability,
      questions: data.questions,
      minNotice: data.minNotice ?? 60,
      maxAdvance: data.maxAdvance ?? 60,
      confirmationMessage: data.confirmationMessage,
      timezone: data.timezone ?? 'UTC',
      createdAt: now,
      updatedAt: now,
    });
    return success(c, { id }, 201);
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    ) {
      return error.conflict(c, 'That booking slug is already taken');
    }
    console.error('[personal-api/booking-pages] create failed:', err);
    return error.internal(c, 'Failed to create booking page');
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
    if (!existing) return error.notFound(c, 'Booking page', id);

    if (data.slug && data.slug !== existing.slug) {
      const [taken] = await db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.slug, data.slug), isNull(t.deletedAt)))
        .limit(1);
      if (taken) return error.conflict(c, 'That booking slug is already taken');
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;

    await db
      .update(t)
      .set(update)
      .where(and(eq(t.id, id), eq(t.personalAccountId, personalAccountId), isNull(t.deletedAt)));

    return success(c, { id });
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    ) {
      return error.conflict(c, 'That booking slug is already taken');
    }
    console.error('[personal-api/booking-pages] update failed:', err);
    return error.internal(c, 'Failed to update booking page');
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
    if (!existing) return error.notFound(c, 'Booking page', id);

    await db
      .update(t)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(t.id, id), eq(t.personalAccountId, personalAccountId)));

    return noContent(c);
  } catch (err) {
    console.error('[personal-api/booking-pages] delete failed:', err);
    return error.internal(c, 'Failed to delete booking page');
  }
});

export const bookingPagesRoutes = app;
