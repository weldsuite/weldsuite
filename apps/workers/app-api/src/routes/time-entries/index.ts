/**
 * Time entry routes — /api/time-entries/*.
 *
 * WeldFlow time tracking. Scope filters (projectId / taskId / date /
 * status / billable) come through as query params; mutations infer `userId`
 * from the Clerk session.
 *
 * OWNERSHIP MODEL:
 *   - GET /           — scoped to the calling user's own entries by DEFAULT.
 *                       Pass `scope=team` together with a `projectId` to read
 *                       the whole team's entries for that project; that widening
 *                       requires `canManageProject` (project manager, an active
 *                       owner/admin member, or a `projects:scope:all` holder).
 *                       `userId` narrows the result and is only honoured under
 *                       `scope=team` — on the default own-scope it is ignored,
 *                       so it can never be used to read a colleague's rows.
 *   - GET /team-summary — per-member totals + billable split for one project.
 *                       Same `canManageProject` gate as `scope=team`.
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
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { timeEntryAnalyticsPayload } from '../../lib/weldflow-analytics-payload';
import { canManageProject } from '../../lib/project-access';
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
  /** 'team' widens the read to every member of `projectId` — managers only. */
  scope: z.enum(['own', 'team']).optional(),
});

/** Filters for GET /team-summary; mirrors the team-scoped list filters. */
const teamSummarySchema = z.object({
  projectId: z.string(),
  taskId: z.string().optional(),
  userId: z.string().optional(),
  status: z.string().optional(),
  billable: z.coerce.boolean().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  /** Caps the returned entry list. Totals are aggregated in SQL and stay exact. */
  limit: z.coerce.number().int().min(1).max(2000).optional(),
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
//
// Own-scope by default. `scope=team` + `projectId` reads the whole project
// team's entries and is gated by `canManageProject`, so a plain member or
// viewer can never widen past their own rows. `userId` narrows a team read to
// one colleague; on an own-scope read it stays ignored.
// ============================================================================

app.get('/', requirePermission('time:read'), zValidator('query', listFiltersSchema), async (c) => {
  const db = c.get('tenantDb');
  const callerId = c.get('userId');
  const f = c.req.valid('query');
  const page = f.page ?? 1;
  const limit = f.limit ?? 50;
  const offset = (page - 1) * limit;

  const wantsTeam = f.scope === 'team';
  if (wantsTeam) {
    if (!f.projectId) {
      return error.badRequest(c, 'scope=team requires a projectId');
    }
    if (!(await canManageProject(c, f.projectId))) {
      return error.forbidden(c, 'You cannot view the team timesheet for this project');
    }
  }

  const conditions: SQL[] = [isNull(t.deletedAt)];
  // Own-scope pins the caller. Team-scope is already bounded by the project
  // filter below, and may optionally narrow to a single member.
  if (!wantsTeam) conditions.push(eq(t.userId, callerId));
  else if (f.userId) conditions.push(eq(t.userId, f.userId));
  if (f.projectId) conditions.push(eq(t.projectId, f.projectId));
  if (f.taskId) conditions.push(eq(t.taskId, f.taskId));
  if (f.status) conditions.push(eq(t.status, f.status));
  if (f.billable !== undefined) conditions.push(eq(t.billable, f.billable));
  if (f.fromDate) conditions.push(sql`${t.date} >= ${f.fromDate}`);
  if (f.toDate) conditions.push(sql`${t.date} <= ${f.toDate}`);

  const where = and(...conditions);

  try {
    const countQuery = db
      .select({ count: sql<number>`count(*)::int` })
      .from(t)
      .where(where);
    const paginate = (countRes: { count: number }[], returned: number) => {
      const totalCount = Number(countRes[0]?.count ?? 0);
      return { totalCount, hasMore: offset + returned < totalCount, cursor: null };
    };

    // Team reads join the member/task lookups the grid needs to label a row the
    // caller did not author. Kept as a separate branch rather than a ternary so
    // each query keeps its own row type — a union of the two breaks inference.
    if (wantsTeam) {
      const [rawRows, countRes] = await Promise.all([
        db
          .select({
            id: t.id,
            projectId: t.projectId,
            taskId: t.taskId,
            userId: t.userId,
            date: t.date,
            startTime: t.startTime,
            endTime: t.endTime,
            duration: t.duration,
            description: t.description,
            activity: t.activity,
            billable: t.billable,
            status: t.status,
            approvedBy: t.approvedBy,
            approvedAt: t.approvedAt,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            userName: schema.workspaceMembers.name,
            userEmail: schema.workspaceMembers.email,
            userAvatar: schema.workspaceMembers.picture,
            taskTitle: schema.tasks.title,
          })
          .from(t)
          .leftJoin(schema.workspaceMembers, eq(t.userId, schema.workspaceMembers.userId))
          .leftJoin(schema.tasks, eq(t.taskId, schema.tasks.id))
          .where(where)
          .orderBy(desc(t.date), desc(t.createdAt))
          .limit(limit)
          .offset(offset),
        countQuery,
      ]);

      // Reshape the joined columns into the nested `user` / `task` objects the
      // timesheet grid already reads (`entry.user?.name`, `entry.task?.title`).
      const rows = rawRows.map(({ userName, userEmail, userAvatar, taskTitle, ...entry }) => ({
        ...entry,
        user: {
          id: entry.userId,
          name: userName ?? userEmail ?? entry.userId,
          email: userEmail ?? '',
          avatar: userAvatar ?? '',
        },
        task: entry.taskId && taskTitle ? { id: entry.taskId, title: taskTitle } : undefined,
      }));
      return list(c, rows, paginate(countRes, rows.length));
    }

    // Own scope keeps the plain `select()` so the personal timesheet's payload
    // shape is untouched.
    const [rows, countRes] = await Promise.all([
      db
        .select()
        .from(t)
        .where(where)
        .orderBy(desc(t.date), desc(t.createdAt))
        .limit(limit)
        .offset(offset),
      countQuery,
    ]);
    return list(c, rows, paginate(countRes, rows.length));
  } catch (err) {
    console.error('[app-api/time-entries] list failed:', err);
    return error.internal(c, 'Failed to list time entries');
  }
});

// ============================================================================
// GET /team-summary — per-member hour totals for one project, with the billable
// split, over an optional date range. Gated by `canManageProject`: the project
// manager, an active owner/admin member, or a `projects:scope:all` holder.
//
// Totals are aggregated in SQL over the FULL match set, so they stay exact even
// when the caller pages the entry list separately via `GET /?scope=team`.
// Members with no entries in range are still returned (at zero) — "who logged
// nothing" is the question a manager most often opens this view to answer.
//
// MUST stay registered above `GET /:id`, or Hono matches it as an entry id.
// ============================================================================

app.get(
  '/team-summary',
  requirePermission('time:read'),
  zValidator('query', teamSummarySchema),
  async (c) => {
    const db = c.get('tenantDb');
    const f = c.req.valid('query');

    if (!(await canManageProject(c, f.projectId))) {
      return error.forbidden(c, 'You cannot view the team timesheet for this project');
    }

    const conditions: SQL[] = [isNull(t.deletedAt), eq(t.projectId, f.projectId)];
    if (f.userId) conditions.push(eq(t.userId, f.userId));
    if (f.taskId) conditions.push(eq(t.taskId, f.taskId));
    if (f.status) conditions.push(eq(t.status, f.status));
    if (f.billable !== undefined) conditions.push(eq(t.billable, f.billable));
    if (f.fromDate) conditions.push(sql`${t.date} >= ${f.fromDate}`);
    if (f.toDate) conditions.push(sql`${t.date} <= ${f.toDate}`);
    const where = and(...conditions);

    try {
      const { projects, projectMembers, workspaceMembers, tasks } = schema;

      const [project] = await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(eq(projects.id, f.projectId), isNull(projects.deletedAt)))
        .limit(1);
      if (!project) return error.notFound(c, 'Project', f.projectId);

      const [members, totals, entries] = await Promise.all([
        // Active roster, so zero-hour members still get a row.
        db
          .select({
            userId: projectMembers.userId,
            role: projectMembers.role,
            name: workspaceMembers.name,
            email: workspaceMembers.email,
            avatar: workspaceMembers.picture,
          })
          .from(projectMembers)
          .leftJoin(workspaceMembers, eq(projectMembers.userId, workspaceMembers.userId))
          .where(
            and(
              eq(projectMembers.projectId, f.projectId),
              eq(projectMembers.isActive, true),
              isNull(projectMembers.deletedAt),
            ),
          ),
        // Exact per-member/per-billable rollup over every matching row.
        db
          .select({
            userId: t.userId,
            billable: t.billable,
            minutes: sql<number>`coalesce(sum(${t.duration}), 0)::float8`,
            entryCount: sql<number>`count(*)::int`,
          })
          .from(t)
          .where(where)
          .groupBy(t.userId, t.billable),
        db
          .select({
            id: t.id,
            projectId: t.projectId,
            taskId: t.taskId,
            userId: t.userId,
            date: t.date,
            startTime: t.startTime,
            endTime: t.endTime,
            duration: t.duration,
            description: t.description,
            activity: t.activity,
            billable: t.billable,
            status: t.status,
            taskTitle: tasks.title,
          })
          .from(t)
          .leftJoin(tasks, eq(t.taskId, tasks.id))
          .where(where)
          .orderBy(desc(t.date), desc(t.createdAt))
          .limit(f.limit ?? 1000),
      ]);

      // Roster first, then anyone with hours who has since left the project —
      // dropping those rows would silently understate the project's total.
      const byUser = new Map<
        string,
        {
          userId: string;
          name: string;
          email: string;
          avatar: string;
          initials: string;
          role: string | null;
          isActiveMember: boolean;
          totalMinutes: number;
          billableMinutes: number;
          nonBillableMinutes: number;
          entryCount: number;
        }
      >();

      const blank = (
        userId: string,
        info?: { name?: string | null; email?: string | null; avatar?: string | null; role?: string | null },
        isActiveMember = true,
      ) => {
        const name = info?.name ?? info?.email ?? userId;
        return {
          userId,
          name,
          email: info?.email ?? '',
          avatar: info?.avatar ?? '',
          initials: name.slice(0, 2).toUpperCase(),
          role: info?.role ?? null,
          isActiveMember,
          totalMinutes: 0,
          billableMinutes: 0,
          nonBillableMinutes: 0,
          entryCount: 0,
        };
      };

      for (const m of members) byUser.set(m.userId, blank(m.userId, m));

      // Contributors who are no longer on the roster have no `members` row, so
      // resolve their display names from the workspace directory rather than
      // rendering a raw user id. One extra query, and only when there are any.
      const offRoster = [...new Set(totals.map((r) => r.userId))].filter((id) => !byUser.has(id));
      if (offRoster.length) {
        const formerMembers = await db
          .select({
            userId: workspaceMembers.userId,
            name: workspaceMembers.name,
            email: workspaceMembers.email,
            avatar: workspaceMembers.picture,
          })
          .from(workspaceMembers)
          .where(inArray(workspaceMembers.userId, offRoster));
        const directory = new Map(formerMembers.map((m) => [m.userId, m]));
        for (const id of offRoster) byUser.set(id, blank(id, directory.get(id), false));
      }

      for (const row of totals) {
        const bucket = byUser.get(row.userId);
        if (!bucket) continue;
        const minutes = Number(row.minutes) || 0;
        bucket.totalMinutes += minutes;
        if (row.billable) bucket.billableMinutes += minutes;
        else bucket.nonBillableMinutes += minutes;
        bucket.entryCount += Number(row.entryCount) || 0;
      }

      const teamMembers = [...byUser.values()].sort((a, b) => b.totalMinutes - a.totalMinutes);
      const rollup = teamMembers.reduce(
        (acc, m) => ({
          totalMinutes: acc.totalMinutes + m.totalMinutes,
          billableMinutes: acc.billableMinutes + m.billableMinutes,
          nonBillableMinutes: acc.nonBillableMinutes + m.nonBillableMinutes,
          entryCount: acc.entryCount + m.entryCount,
        }),
        { totalMinutes: 0, billableMinutes: 0, nonBillableMinutes: 0, entryCount: 0 },
      );

      return success(c, {
        projectId: project.id,
        projectName: project.name,
        range: { fromDate: f.fromDate ?? null, toDate: f.toDate ?? null },
        totals: {
          ...rollup,
          memberCount: teamMembers.length,
          contributorCount: teamMembers.filter((m) => m.entryCount > 0).length,
        },
        members: teamMembers,
        entries: entries.map(({ taskTitle, ...e }) => ({
          ...e,
          duration: Number(e.duration) || 0,
          userName: byUser.get(e.userId)?.name ?? e.userId,
          task: e.taskId && taskTitle ? { id: e.taskId, title: taskTitle } : undefined,
        })),
        // Signals the entry list was capped while `totals` stayed exact.
        entriesTruncated: rollup.entryCount > entries.length,
      });
    } catch (err) {
      console.error('[app-api/time-entries] team summary failed:', err);
      return error.internal(c, 'Failed to fetch team timesheet summary');
    }
  },
);

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

      const costStr = computeCost(rate, duration);
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
        cost: costStr,
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
          ...timeEntryAnalyticsPayload({
            id,
            projectId: projectId ?? null,
            taskId: taskId ?? null,
            userId,
            durationMinutes: Number(duration),
            billable,
          }),
          startedAt: startedAt.toISOString(),
          endedAt: now.toISOString(),
          cost: costStr != null ? Number(costStr) : undefined,
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
        data: timeEntryAnalyticsPayload({
          id,
          projectId: data.projectId ?? null,
          taskId: data.taskId ?? null,
          userId,
          durationMinutes: Number(data.duration),
          billable: data.billable ?? true,
        }),
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
          ...timeEntryAnalyticsPayload({
            id,
            projectId: (data.projectId ?? existing.projectId) ?? null,
            taskId: (data.taskId ?? existing.taskId) ?? null,
            userId: existing.userId,
            durationMinutes: Number(data.duration ?? existing.duration),
            billable: (data.billable ?? existing.billable) as boolean,
          }),
          cost: update.cost != null ? Number(update.cost) : existing.cost != null ? Number(existing.cost) : undefined,
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
