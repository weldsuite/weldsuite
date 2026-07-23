/**
 * Time entry routes — /api/time-entries/*.
 *
 * WeldFlow time tracking. Scope filters (projectId / taskId / date /
 * status / billable) come through as query params; mutations infer `userId`
 * from the Clerk session.
 *
 * OWNERSHIP MODEL (this batch):
 *   - GET /           — always scoped to the calling user's own entries.
 *                       A future `time:scope:all` grant would let managers
 *                       browse team timesheets via the `userId` query param
 *                       (out of scope here — add when the grant is wired).
 *   - GET /:id        — owner-only; 404 for another user's entry.
 *   - PATCH /:id      — owner-only; 404 for another user's entry.
 *   - DELETE /:id     — owner-only; 404 for another user's entry.
 *   - PATCH /:id/approve, PATCH /:id/reject — intentionally cross-user
 *                       (manager approval workflow); NOT scoped by userId.
 *   - /timer/*        — the caller's own running timer; one per user.
 *
 * Permissions: time:read | time:create | time:update | time:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.timeEntries;
const timers = schema.activeTimers;

const listFiltersSchema = z.object({
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  userId: z.string().optional(),
  status: z.string().optional(),
  billable: z.coerce.boolean().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  search: z.string().optional(),
});

const createTimeEntrySchema = z
  .object({
    projectId: z.string().optional(),
    taskId: z.string().optional(),
    date: z.string(),
    // Minutes — accept string (api-worker shape) or number.
    duration: z.union([z.string(), z.number()]),
    description: z.string().optional(),
    activity: z.string().optional(),
    billable: z.boolean().default(true),
    rate: z.union([z.string(), z.number()]).optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    location: z.string().optional(),
    isRemote: z.boolean().default(false),
  })
  .passthrough();

const updateTimeEntrySchema = createTimeEntrySchema.partial();

function computeCost(rate?: string | number | null, duration?: string | number | null): string | null {
  if (rate === undefined || rate === null || duration === undefined || duration === null) return null;
  const r = Number(rate);
  const d = Number(duration);
  if (!Number.isFinite(r) || !Number.isFinite(d)) return null;
  return String((d / 60) * r);
}

// ============================================================================
// GET / — list with filters + page/limit pagination (matches api-worker shape).
// Always filtered to the calling user's own entries. The `userId` query param
// is accepted for forward-compatibility but is IGNORED until a `time:scope:all`
// grant is introduced to let managers view team timesheets.
// ============================================================================

app.get('/', requirePermission('time:read'), zValidator('query', listFiltersSchema), async (c) => {
  const db = c.get('tenantDb');
  const callerId = c.get('userId');
  const f = c.req.valid('query');
  const page = f.page ?? 1;
  const limit = f.limit ?? 50;
  const offset = (page - 1) * limit;

  const conditions: any[] = [isNull(t.deletedAt), eq(t.userId, callerId)];
  if (f.projectId) conditions.push(eq(t.projectId, f.projectId));
  if (f.taskId) conditions.push(eq(t.taskId, f.taskId));
  // NOTE: f.userId is intentionally ignored here until a time:scope:all grant
  // is wired. Managers who need cross-user views should use the approve/reject
  // workflow or a future manager-summary endpoint.
  if (f.status) conditions.push(eq(t.status, f.status));
  if (f.billable !== undefined) conditions.push(eq(t.billable, f.billable));
  if (f.fromDate) conditions.push(sql`${t.date} >= ${f.fromDate}`);
  if (f.toDate) conditions.push(sql`${t.date} <= ${f.toDate}`);

  const where = and(...conditions);

  try {
    const [rows, countRes] = await Promise.all([
      db
        .select()
        .from(t)
        .where(where)
        .orderBy(desc(t.date), desc(t.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(where),
    ]);
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, rows, {
      totalCount,
      hasMore: offset + rows.length < totalCount,
      cursor: null,
    });
  } catch (err) {
    console.error('[app-api/time-entries] list failed:', err);
    return error.internal(c, 'Failed to list time entries');
  }
});

// ============================================================================
// TIMER — /api/time-entries/timer/*
//
// A running timer lives in `active_timers`, one row per user (unique index on
// user_id). Stopping it deletes the row and writes a normal `time_entries`
// row, so every time entry stays a completed entry with a non-null duration.
//
// These MUST stay registered above `GET /:id`, or Hono matches `/timer` as an
// entry id.
// ============================================================================

const startTimerSchema = z
  .object({
    projectId: z.string().optional(),
    taskId: z.string().optional(),
    description: z.string().optional(),
    activity: z.string().optional(),
    billable: z.boolean().default(true),
    rate: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

/** Elapsed minutes between two instants, rounded to 2dp to match numeric(10,2). */
function minutesBetween(from: Date, to: Date): string {
  const minutes = Math.max(0, (to.getTime() - from.getTime()) / 60000);
  return minutes.toFixed(2);
}

// GET /timer — the caller's running timer, or null.
app.get('/timer', requirePermission('time:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  try {
    const [row] = await db.select().from(timers).where(eq(timers.userId, userId)).limit(1);
    return success(c, row ?? null);
  } catch (err) {
    console.error('[app-api/time-entries] get timer failed:', err);
    return error.internal(c, 'Failed to fetch running timer');
  }
});

// POST /timer/start — begin a timer. Conflicts if one is already running so the
// client can prompt the user to stop it first.
app.post(
  '/timer/start',
  requirePermission('time:create'),
  zValidator('json', startTimerSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);
    const data = c.req.valid('json');

    try {
      const [running] = await db.select().from(timers).where(eq(timers.userId, userId)).limit(1);
      if (running) {
        return error.conflict(c, 'A timer is already running', { timer: running });
      }

      const id = generateId('timer');
      const now = new Date();
      const [created] = await db
        .insert(timers)
        .values({
          id,
          projectId: data.projectId ?? null,
          taskId: data.taskId ?? null,
          userId,
          startedAt: now,
          description: data.description ?? null,
          activity: data.activity ?? null,
          billable: data.billable ?? true,
          rate: data.rate !== undefined ? String(data.rate) : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return success(c, created, 201);
    } catch (err) {
      console.error('[app-api/time-entries] start timer failed:', err);
      return error.internal(c, 'Failed to start timer');
    }
  },
);

// POST /timer/stop — stop the running timer and convert it into a time entry.
// Any field supplied here overrides what the timer was started with, so the
// user can name the activity on the way out.
app.post(
  '/timer/stop',
  requirePermission('time:create'),
  zValidator('json', startTimerSchema.partial()),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);
    const overrides = c.req.valid('json');

    try {
      const [running] = await db.select().from(timers).where(eq(timers.userId, userId)).limit(1);
      if (!running) return error.notFound(c, 'Running timer', userId);

      const now = new Date();
      const startedAt = new Date(running.startedAt);
      const duration = minutesBetween(startedAt, now);
      const rate = overrides.rate !== undefined ? String(overrides.rate) : running.rate;
      const billable = overrides.billable ?? running.billable;
      const projectId = overrides.projectId ?? running.projectId;
      const taskId = overrides.taskId ?? running.taskId;
      const id = generateId('time');

      await db.insert(t).values({
        id,
        projectId: projectId ?? null,
        taskId: taskId ?? null,
        userId,
        // Local calendar date of the start, so an entry lands on the day it began.
        date: startedAt.toISOString().slice(0, 10),
        startTime: startedAt,
        endTime: now,
        duration,
        description: overrides.description ?? running.description,
        activity: overrides.activity ?? running.activity,
        billable,
        rate: rate ?? null,
        cost: computeCost(rate, duration),
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      });

      await db.delete(timers).where(eq(timers.id, running.id));

      publishEntityEvent({
        c,
        entityType: 'project_time_entry',
        entityId: id,
        action: 'created',
        data: {
          id,
          projectId: projectId ?? null,
          taskId: taskId ?? null,
          userId,
          duration: Number(duration),
          startedAt: startedAt.toISOString(),
          endedAt: now.toISOString(),
        },
      });

      return success(c, { id, duration, startTime: startedAt, endTime: now }, 201);
    } catch (err) {
      console.error('[app-api/time-entries] stop timer failed:', err);
      return error.internal(c, 'Failed to stop timer');
    }
  },
);

// DELETE /timer — discard the running timer without recording anything.
app.delete('/timer', requirePermission('time:create'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  try {
    await db.delete(timers).where(eq(timers.userId, userId));
    return noContent(c);
  } catch (err) {
    console.error('[app-api/time-entries] discard timer failed:', err);
    return error.internal(c, 'Failed to discard timer');
  }
});

// ============================================================================
// GET /:id — owner-only. Another user's entry surfaces as 404.
// ============================================================================

app.get('/:id', requirePermission('time:read'), async (c) => {
  const db = c.get('tenantDb');
  const callerId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [row] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt), eq(t.userId, callerId)))
      .limit(1);
    if (!row) return error.notFound(c, 'Time entry', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/time-entries] get failed:', err);
    return error.internal(c, 'Failed to fetch time entry');
  }
});

// ============================================================================
// POST / — create. `userId` is forced from the Clerk session; `cost` is
// derived from `rate * (duration / 60)`; `status` defaults to 'draft'.
// ============================================================================

app.post(
  '/',
  requirePermission('time:create'),
  zValidator('json', createTimeEntrySchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);
    const data = c.req.valid('json');
    const id = generateId('time');
    const now = new Date();

    try {
      await db.insert(t).values({
        id,
        projectId: data.projectId ?? null,
        taskId: data.taskId ?? null,
        userId,
        date: data.date,
        duration: String(data.duration),
        description: data.description ?? null,
        activity: data.activity ?? null,
        billable: data.billable ?? true,
        rate: data.rate !== undefined ? String(data.rate) : null,
        cost: computeCost(data.rate, data.duration),
        startTime: data.startTime ? new Date(data.startTime) : null,
        endTime: data.endTime ? new Date(data.endTime) : null,
        location: data.location ?? null,
        isRemote: data.isRemote ?? false,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      });

      publishEntityEvent({
        c,
        entityType: 'project_time_entry',
        entityId: id,
        action: 'created',
        data: {
          id,
          projectId: data.projectId ?? null,
          taskId: data.taskId ?? null,
          userId,
          duration: Number(data.duration),
        },
      });

      return success(c, { id }, 201);
    } catch (err) {
      console.error('[app-api/time-entries] create failed:', err);
      return error.internal(c, 'Failed to create time entry');
    }
  },
);

// ============================================================================
// PATCH /:id — partial update, owner-only. Recomputes cost when rate or
// duration changes.
// ============================================================================

app.patch(
  '/:id',
  requirePermission('time:update'),
  zValidator('json', updateTimeEntrySchema),
  async (c) => {
    const db = c.get('tenantDb');
    const callerId = c.get('userId');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    try {
      const [existing] = await db
        .select()
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt), eq(t.userId, callerId)))
        .limit(1);
      if (!existing) return error.notFound(c, 'Time entry', id);

      const update: Record<string, any> = { updatedAt: new Date() };
      if (data.date !== undefined) update.date = data.date;
      if (data.duration !== undefined) update.duration = String(data.duration);
      if (data.description !== undefined) update.description = data.description;
      if (data.activity !== undefined) update.activity = data.activity;
      if (data.billable !== undefined) update.billable = data.billable;
      if (data.rate !== undefined) update.rate = data.rate === null ? null : String(data.rate);
      if (data.startTime !== undefined) update.startTime = data.startTime ? new Date(data.startTime) : null;
      if (data.endTime !== undefined) update.endTime = data.endTime ? new Date(data.endTime) : null;
      if (data.location !== undefined) update.location = data.location;
      if (data.isRemote !== undefined) update.isRemote = data.isRemote;
      if (data.taskId !== undefined) update.taskId = data.taskId;
      if (data.projectId !== undefined) update.projectId = data.projectId;

      if (data.rate !== undefined || data.duration !== undefined) {
        const rate = data.rate ?? existing.rate;
        const duration = data.duration ?? existing.duration;
        update.cost = computeCost(rate as any, duration as any);
      }

      await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));

      publishEntityEvent({
        c,
        entityType: 'project_time_entry',
        entityId: id,
        action: 'updated',
        data: {
          id,
          projectId: (data.projectId ?? existing.projectId) ?? null,
          taskId: (data.taskId ?? existing.taskId) ?? null,
          userId: existing.userId,
          duration: Number(data.duration ?? existing.duration),
        },
      });

      return success(c, { id, ...data });
    } catch (err) {
      console.error('[app-api/time-entries] update failed:', err);
      return error.internal(c, 'Failed to update time entry');
    }
  },
);

// ============================================================================
// PATCH /:id/approve  and  PATCH /:id/reject — timesheet status workflow
// ============================================================================

app.patch('/:id/approve', requirePermission('time:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const userId = c.get('userId');
  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Time entry', id);
    const now = new Date();
    await db
      .update(t)
      .set({ status: 'approved', approvedBy: userId ?? null, approvedAt: now, updatedAt: now })
      .where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'project_time_entry',
      entityId: id,
      action: 'updated',
      data: {
        id,
        projectId: existing.projectId,
        taskId: existing.taskId,
        userId: existing.userId,
        duration: Number(existing.duration),
      },
    });
    return success(c, { id, status: 'approved' });
  } catch (err) {
    console.error('[app-api/time-entries] approve failed:', err);
    return error.internal(c, 'Failed to approve time entry');
  }
});

app.patch('/:id/reject', requirePermission('time:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Time entry', id);
    await db
      .update(t)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'project_time_entry',
      entityId: id,
      action: 'updated',
      data: {
        id,
        projectId: existing.projectId,
        taskId: existing.taskId,
        userId: existing.userId,
        duration: Number(existing.duration),
      },
    });
    return success(c, { id, status: 'rejected' });
  } catch (err) {
    console.error('[app-api/time-entries] reject failed:', err);
    return error.internal(c, 'Failed to reject time entry');
  }
});

// ============================================================================
// DELETE /:id — owner-only.
// ============================================================================

app.delete('/:id', requirePermission('time:delete'), async (c) => {
  const db = c.get('tenantDb');
  const callerId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt), eq(t.userId, callerId)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Time entry', id);
    await db
      .update(t)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'project_time_entry',
      entityId: id,
      action: 'deleted',
      data: {
        id,
        projectId: existing.projectId,
        taskId: existing.taskId,
        userId: existing.userId,
        duration: Number(existing.duration),
      },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/time-entries] delete failed:', err);
    return error.internal(c, 'Failed to delete time entry');
  }
});

export const timeEntriesRoutes = app;
