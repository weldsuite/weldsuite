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
 *   - PATCH /:id/approve, PATCH /:id/reject — cross-user (manager approval
 *                       workflow), so NOT scoped by userId, but restricted to
 *                       people who manage the entry's project (`canManageProject`;
 *                       `projects:scope:all` for entries without a project), and
 *                       never on your own entry.
 *   - Approved entries are locked: PATCH / DELETE answer 409 until a manager
 *                       rejects the entry again.
 *   - POST / PATCH / timer start+stop check the caller can write to the project
 *                       (and task) the hours are logged against.
 *   - /timer/*        — the caller's own running timer; one per user.
 *
 * Permissions: time:read | time:create | time:update | time:delete.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, getTableColumns, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { timeEntryAnalyticsPayload } from '../../lib/weldflow-analytics-payload';
import { canManageProject, canWriteProject } from '../../lib/project-access';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.timeEntries;
const timers = schema.activeTimers;

/**
 * A boolean query param. `z.coerce.boolean()` would turn the string "false" into
 * `true` (any non-empty string is truthy), so `?billable=false` returned the
 * billable entries.
 */
const queryBoolean = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const listFiltersSchema = z.object({
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  userId: z.string().optional(),
  status: z.string().optional(),
  billable: queryBoolean.optional(),
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
  billable: queryBoolean.optional(),
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
  });

const updateTimeEntrySchema = createTimeEntrySchema.partial();

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * Checks the caller may log hours against `projectId` / `taskId` and resolves the
 * project the entry belongs to (a task's project wins when none is given).
 * Returns the project id, or the error response to send.
 */
async function resolveEntryTarget(
  c: Ctx,
  target: { projectId?: string | null; taskId?: string | null },
): Promise<{ projectId: string | null } | Response> {
  const db = c.get('tenantDb');
  let projectId = target.projectId ?? null;

  if (target.taskId) {
    const [task] = await db
      .select({ projectId: schema.tasks.projectId })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, target.taskId), isNull(schema.tasks.deletedAt)))
      .limit(1);
    if (!task) return error.notFound(c, 'Task', target.taskId);
    if (task.projectId) {
      if (projectId && projectId !== task.projectId) {
        return error.badRequest(c, 'The task does not belong to the given project');
      }
      projectId = task.projectId;
    }
  }

  if (projectId && !(await canWriteProject(c, projectId))) {
    return error.forbidden(c, 'You do not have write access to this project');
  }
  return { projectId };
}

/** Approved hours are final: change them by having a manager reject the entry first. */
const APPROVED_LOCKED = 'Approved time entries are locked. A project manager has to reject the entry before it can change.';

function computeCost(rate?: string | number | null, duration?: string | number | null): string | null {
  if (rate === undefined || rate === null || duration === undefined || duration === null) return null;
  const r = Number(rate);
  const d = Number(duration);
  if (!Number.isFinite(r) || !Number.isFinite(d)) return null;
  return String((d / 60) * r);
}

/** A calendar day only has 24 hours; no one user can log more than that. */
const MAX_MINUTES_PER_DAY = 24 * 60;

function formatHours(minutes: number): string {
  return `${Math.round((minutes / 60) * 100) / 100}h`;
}

/**
 * Daily-limit guard for create / update. Returns a user-facing message when the
 * entry itself is not a valid duration, exceeds 24h, or would push the user's
 * total for `date` (every other live entry, `excludeId` aside) past 24h.
 * Returns null when the entry is acceptable.
 */
async function dailyLimitViolation(
  db: Database,
  params: { userId: string; date: string; minutes: string | number; excludeId?: string },
): Promise<string | null> {
  const raw = typeof params.minutes === 'string' ? params.minutes.trim() : params.minutes;
  const minutes = raw === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return 'Duration must be a non-negative number of minutes';
  }
  if (minutes > MAX_MINUTES_PER_DAY) {
    return `A time entry cannot be longer than 24 hours (got ${formatHours(minutes)})`;
  }

  const conditions: SQL[] = [
    isNull(t.deletedAt),
    eq(t.userId, params.userId),
    sql`${t.date} = ${params.date}`,
  ];
  if (params.excludeId) conditions.push(ne(t.id, params.excludeId));
  const [row] = await db
    .select({ minutes: sql<number>`coalesce(sum(${t.duration}), 0)::float8` })
    .from(t)
    .where(and(...conditions));
  const alreadyLogged = Number(row?.minutes ?? 0);

  if (alreadyLogged + minutes > MAX_MINUTES_PER_DAY) {
    return (
      `You cannot log more than 24 hours on a single day: ${params.date} already has ` +
      `${formatHours(alreadyLogged)} logged, and adding ${formatHours(minutes)} would exceed the limit`
    );
  }
  return null;
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

    // Both scopes join the member/task lookups the grid needs to label an entry
    // with its author and a task row with the task's title. Without them the
    // personal ("Mine") grid had only the entry description to go on, so a task
    // row was named after one entry's description and the author read "Unknown".
    const [rawRows, countRes] = await Promise.all([
      db
        .select({
          ...getTableColumns(t),
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
    // timesheet grid reads (`entry.user?.name`, `entry.task?.title`).
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
  } catch (err) {
    console.error('[app-api/time-entries] list failed:', err);
    return error.internal(c, 'Failed to list time entries');
  }
});

type TeamSummaryFilters = z.infer<typeof teamSummarySchema>;

/** WHERE clauses for GET /team-summary: one project, optionally narrowed. */
function buildTeamSummaryConditions(f: TeamSummaryFilters): SQL[] {
  const conditions: SQL[] = [isNull(t.deletedAt), eq(t.projectId, f.projectId)];
  if (f.userId) conditions.push(eq(t.userId, f.userId));
  if (f.taskId) conditions.push(eq(t.taskId, f.taskId));
  if (f.status) conditions.push(eq(t.status, f.status));
  if (f.billable !== undefined) conditions.push(eq(t.billable, f.billable));
  if (f.fromDate) conditions.push(sql`${t.date} >= ${f.fromDate}`);
  if (f.toDate) conditions.push(sql`${t.date} <= ${f.toDate}`);
  return conditions;
}

type MinutesBucket = {
  totalMinutes: number;
  billableMinutes: number;
  nonBillableMinutes: number;
  entryCount: number;
};

/** Fold the per-member/per-billable SQL rollup into each member's bucket. */
function addTotalsToBuckets(
  byUser: Map<string, MinutesBucket>,
  totals: Array<{ userId: string; billable: boolean | null; minutes: number; entryCount: number }>,
): void {
  for (const row of totals) {
    const bucket = byUser.get(row.userId);
    if (!bucket) continue;
    const minutes = Number(row.minutes) || 0;
    bucket.totalMinutes += minutes;
    if (row.billable) bucket.billableMinutes += minutes;
    else bucket.nonBillableMinutes += minutes;
    bucket.entryCount += Number(row.entryCount) || 0;
  }
}

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

    const where = and(...buildTeamSummaryConditions(f));

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

      addTotalsToBuckets(byUser, totals);

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
  });

/** An IANA time zone name such as `Europe/Amsterdam`. */
const timeZoneSchema = z
  .string()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone');

/** The calendar date (`YYYY-MM-DD`) `instant` falls on in `timeZone` (UTC when none is given). */
export function calendarDate(instant: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

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

      const target = await resolveEntryTarget(c, data);
      if (target instanceof Response) return target;

      const id = generateId('timer');
      const now = new Date();
      const [created] = await db
        .insert(timers)
        .values({
          id,
          projectId: target.projectId,
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
  zValidator('json', startTimerSchema.partial().extend({ timeZone: timeZoneSchema.optional() })),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);
    const overrides = c.req.valid('json');

    try {
      const [current] = await db.select().from(timers).where(eq(timers.userId, userId)).limit(1);
      if (!current) return error.notFound(c, 'Running timer', userId);

      // Validate the project / task the hours land on before the timer is consumed.
      const target = await resolveEntryTarget(c, {
        projectId: overrides.projectId ?? current.projectId,
        taskId: overrides.taskId ?? current.taskId,
      });
      if (target instanceof Response) return target;

      // Claim the timer atomically: DELETE ... RETURNING hands it to exactly one
      // request, so a double click or a retry cannot write the entry twice.
      const [running] = await db.delete(timers).where(eq(timers.id, current.id)).returning();
      if (!running) return error.notFound(c, 'Running timer', userId);

      const now = new Date();
      const startedAt = new Date(running.startedAt);
      const duration = minutesBetween(startedAt, now);
      const rate = overrides.rate !== undefined ? String(overrides.rate) : running.rate;
      const billable = overrides.billable ?? running.billable;
      const taskId = overrides.taskId ?? running.taskId;
      const projectId = target.projectId;
      const id = generateId('time');

      const costStr = computeCost(rate, duration);
      try {
        await db.insert(t).values({
          id,
          projectId: projectId ?? null,
          taskId: taskId ?? null,
          userId,
          // The calendar day the timer started on in the caller's time zone (UTC
          // when the client sends none), so an entry lands on the day it began.
          date: calendarDate(startedAt, overrides.timeZone),
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
      } catch (insertErr) {
        // Do not lose the running time when the entry could not be written.
        await db.insert(timers).values(running).onConflictDoNothing();
        throw insertErr;
      }

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
      const violation = await dailyLimitViolation(db, {
        userId,
        date: data.date,
        minutes: data.duration,
      });
      if (violation) return error.badRequest(c, violation);

      const target = await resolveEntryTarget(c, data);
      if (target instanceof Response) return target;

      await db.insert(t).values({
        id,
        projectId: target.projectId,
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
          projectId: target.projectId,
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

type TimeEntryPatch = z.infer<typeof updateTimeEntrySchema>;

/** PATCH fields written to the row exactly as received (no conversion needed). */
const COPIED_PATCH_FIELDS = [
  'date',
  'description',
  'activity',
  'billable',
  'location',
  'isRemote',
  'taskId',
  'projectId',
] as const;

/** Only the fields the caller sent; recomputes `cost` when rate or duration changes. */
function buildTimeEntryUpdate(
  data: TimeEntryPatch,
  existing: typeof t.$inferSelect,
): Record<string, any> {
  const update: Record<string, any> = { updatedAt: new Date() };
  for (const key of COPIED_PATCH_FIELDS) {
    if (data[key] !== undefined) update[key] = data[key];
  }
  if (data.duration !== undefined) update.duration = String(data.duration);
  if (data.rate !== undefined) update.rate = data.rate === null ? null : String(data.rate);
  if (data.startTime !== undefined) update.startTime = data.startTime ? new Date(data.startTime) : null;
  if (data.endTime !== undefined) update.endTime = data.endTime ? new Date(data.endTime) : null;

  if (data.rate !== undefined || data.duration !== undefined) {
    const rate = data.rate ?? existing.rate;
    const duration = data.duration ?? existing.duration;
    update.cost = computeCost(rate as any, duration as any);
  }
  return update;
}

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
      if (existing.status === 'approved') return error.conflict(c, APPROVED_LOCKED);

      // Re-pointing the entry at another project or task needs write access there.
      if (data.projectId !== undefined || data.taskId !== undefined) {
        const target = await resolveEntryTarget(c, {
          projectId: data.projectId ?? (data.taskId === undefined ? existing.projectId : null),
          taskId: data.taskId ?? existing.taskId,
        });
        if (target instanceof Response) return target;
        data.projectId = target.projectId ?? undefined;
      }

      // Moving an entry to another day or lengthening it can both break the
      // 24h/day cap, so re-check whenever either changes.
      if (data.duration !== undefined || (data.date !== undefined && data.date !== existing.date)) {
        const violation = await dailyLimitViolation(db, {
          userId: existing.userId,
          date: data.date ?? existing.date,
          minutes: data.duration ?? existing.duration,
          excludeId: id,
        });
        if (violation) return error.badRequest(c, violation);
      }

      const update = buildTimeEntryUpdate(data, existing);

      await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));

      let eventCost: number | undefined;
      if (update.cost != null) eventCost = Number(update.cost);
      else if (existing.cost != null) eventCost = Number(existing.cost);

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
          cost: eventCost,
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

/**
 * Who may approve or reject an entry: whoever manages its project (project
 * manager, owner/admin member, `projects:scope:all`), or a `projects:scope:all`
 * holder for an entry that is not tied to a project. Never the entry's own
 * author, so nobody signs off their own hours.
 */
async function reviewDenial(c: Ctx, entry: typeof t.$inferSelect): Promise<string | null> {
  if (entry.userId === c.get('userId')) return 'You cannot approve or reject your own time entry';
  const allowed = entry.projectId
    ? await canManageProject(c, entry.projectId)
    : await hasContextPermission(c, 'projects:scope:all');
  return allowed ? null : 'Only a project manager can approve or reject time entries';
}

type ReviewStatus = 'approved' | 'rejected';

/** Shared body of approve / reject: guard, write the status, publish both entity events. */
async function reviewTimeEntry(c: Ctx, id: string, status: ReviewStatus) {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Time entry', id);
    const denial = await reviewDenial(c, existing);
    if (denial) return error.forbidden(c, denial);

    const now = new Date();
    await db
      .update(t)
      .set(
        status === 'approved'
          ? { status, approvedBy: userId ?? null, approvedAt: now, updatedAt: now }
          : // Rejecting also withdraws an earlier approval, which unlocks the entry for its owner.
            { status, approvedBy: null, approvedAt: null, updatedAt: now },
      )
      .where(eq(t.id, id));

    const payload = {
      id,
      projectId: existing.projectId,
      taskId: existing.taskId,
      userId: existing.userId,
      duration: Number(existing.duration),
    };
    publishEntityEvent({
      c,
      entityType: 'project_time_entry',
      entityId: id,
      action: 'updated',
      data: payload,
    });
    publishEntityEvent({
      c,
      entityType: 'project_timesheet',
      entityId: id,
      action: status,
      data: { ...payload, reviewedBy: userId ?? null },
    });
    return success(c, { id, status });
  } catch (err) {
    console.error(`[app-api/time-entries] ${status} failed:`, err);
    return error.internal(c, status === 'approved' ? 'Failed to approve time entry' : 'Failed to reject time entry');
  }
}

app.patch('/:id/approve', requirePermission('time:update'), (c) => reviewTimeEntry(c, c.req.param('id'), 'approved'));

app.patch('/:id/reject', requirePermission('time:update'), (c) => reviewTimeEntry(c, c.req.param('id'), 'rejected'));

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
    if (existing.status === 'approved') return error.conflict(c, APPROVED_LOCKED);
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
