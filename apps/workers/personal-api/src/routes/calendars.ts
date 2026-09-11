/**
 * Personal calendar routes — /api/calendars/*
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getPersonalDb, personalSchema } from '../db';
import { error, list, noContent, success, cursorPagination } from '../lib/response';
import { generateId } from '../lib/id';
import {
  ensureDefaultCalendar,
  getCalendarForAccount,
  listCalendarsForAccount,
} from '../services/calendar-access';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = personalSchema.personalCalendars;

const createSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(500).optional(),
  color: z.string().max(20).optional(),
});

const updateSchema = createSchema.partial();

function requireAccount(c: { get: (k: 'personalAccountId') => string | null }) {
  return c.get('personalAccountId');
}

app.get('/', async (c) => {
  const personalAccountId = requireAccount(c);
  if (!personalAccountId) return error.personalAccountRequired(c);

  try {
    const db = getPersonalDb(c.env);
    const rows = await listCalendarsForAccount(db, personalAccountId);
    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    console.error('[personal-api/calendars] list failed:', err);
    return error.internal(c, 'Failed to list calendars');
  }
});

app.post('/ensure-default', async (c) => {
  const personalAccountId = requireAccount(c);
  if (!personalAccountId) return error.personalAccountRequired(c);

  try {
    const db = getPersonalDb(c.env);
    const { calendar, created } = await ensureDefaultCalendar(db, personalAccountId, c.get('userId'));
    return success(c, { ...calendar, isOwn: true, permission: 'manage' }, created ? 201 : 200);
  } catch (err) {
    console.error('[personal-api/calendars] ensure-default failed:', err);
    return error.internal(c, 'Failed to ensure default calendar');
  }
});

app.post('/', zValidator('json', createSchema), async (c) => {
  const personalAccountId = requireAccount(c);
  if (!personalAccountId) return error.personalAccountRequired(c);

  const data = c.req.valid('json');
  const entitlements = c.get('entitlements');
  const db = getPersonalDb(c.env);

  try {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(t)
      .where(and(eq(t.personalAccountId, personalAccountId), isNull(t.deletedAt)));

    if (Number(count) >= entitlements.maxCalendars) {
      return error.planLimit(c, 'Calendar limit reached for your plan', {
        maxCalendars: entitlements.maxCalendars,
      });
    }

    const id = generateId('cal');
    const now = new Date();
    await db.insert(t).values({
      id,
      personalAccountId,
      name: data.name,
      description: data.description,
      color: data.color,
      ownerId: c.get('userId'),
      isDefault: false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[personal-api/calendars] create failed:', err);
    return error.internal(c, 'Failed to create calendar');
  }
});

app.get('/:id', async (c) => {
  const personalAccountId = requireAccount(c);
  if (!personalAccountId) return error.personalAccountRequired(c);

  const id = c.req.param('id');
  try {
    const db = getPersonalDb(c.env);
    const row = await getCalendarForAccount(db, personalAccountId, id);
    if (!row) return error.notFound(c, 'Calendar', id);
    return success(c, { ...row, isOwn: true, permission: 'manage' });
  } catch (err) {
    console.error('[personal-api/calendars] get failed:', err);
    return error.internal(c, 'Failed to fetch calendar');
  }
});

app.patch('/:id', zValidator('json', updateSchema), async (c) => {
  const personalAccountId = requireAccount(c);
  if (!personalAccountId) return error.personalAccountRequired(c);

  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const db = getPersonalDb(c.env);
    const existing = await getCalendarForAccount(db, personalAccountId, id);
    if (!existing) return error.notFound(c, 'Calendar', id);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.description !== undefined) update.description = data.description;
    if (data.color !== undefined) update.color = data.color;

    await db
      .update(t)
      .set(update)
      .where(and(eq(t.id, id), eq(t.personalAccountId, personalAccountId), isNull(t.deletedAt)));

    return success(c, { id });
  } catch (err) {
    console.error('[personal-api/calendars] update failed:', err);
    return error.internal(c, 'Failed to update calendar');
  }
});

app.delete('/:id', async (c) => {
  const personalAccountId = requireAccount(c);
  if (!personalAccountId) return error.personalAccountRequired(c);

  const id = c.req.param('id');
  try {
    const db = getPersonalDb(c.env);
    const existing = await getCalendarForAccount(db, personalAccountId, id);
    if (!existing) return error.notFound(c, 'Calendar', id);
    if (existing.isDefault) {
      return error.badRequest(c, 'Cannot delete the default calendar');
    }

    await db
      .update(t)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(t.id, id), eq(t.personalAccountId, personalAccountId)));

    return noContent(c);
  } catch (err) {
    console.error('[personal-api/calendars] delete failed:', err);
    return error.internal(c, 'Failed to delete calendar');
  }
});

export const calendarsRoutes = app;
