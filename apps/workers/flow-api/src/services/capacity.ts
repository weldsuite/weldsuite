/**
 * Capacity queries shared by `/api/capacity` and `/api/project-requests`
 * (design: weldflow-delivery-and-portfolio.md, "Capacity").
 *
 * The rules (load per member and week, suggestions, fit) are in
 * `@weldsuite/flow-domain/capacity`; this file is the database side: it reads
 * the bookings, open tasks and profiles of a range in a fixed order, hands them
 * to the pure function, and resolves the names the caller may see. The load
 * across every project of the workspace is two aggregates bounded by the week
 * range (bookings overlapping it, open tasks with an estimate and a date
 * overlapping it).
 */

import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { OTHER_PROJECT_NAME, type CapacityResponse } from '@weldsuite/app-api-client/schemas/flow-portfolio';
import {
  collectMembers,
  computeCapacity,
  type CapacityBooking,
  type CapacityLoad,
  type CapacityRange,
  type CapacityTask,
} from '@weldsuite/flow-domain/capacity';
import type { Context } from 'hono';
import type { Env, Variables } from '../types';
import { accessibleProjectIds } from '../lib/project-access';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const bookings = schema.resourceBookings;
const requests = schema.resourceRequests;
const profiles = schema.flowMemberProfiles;
const projectRequests = schema.projectRequests;

export type BookingRow = typeof bookings.$inferSelect;
export type NewBookingRow = typeof bookings.$inferInsert;
export type ResourceRequestRow = typeof requests.$inferSelect;
export type NewResourceRequestRow = typeof requests.$inferInsert;
export type ProfileRow = typeof profiles.$inferSelect;

/** Projects that count for the portfolio: not yet completed, cancelled or closed. */
export const CURRENT_PROJECT_STATUSES = ['Planning', 'Active', 'On Hold'] as const;

/** Whether a live (not soft-deleted) project exists. */
export async function liveProjectExists(db: Database, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)))
    .limit(1);
  return !!row;
}

export async function findBooking(db: Database, id: string): Promise<BookingRow | null> {
  const [row] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, id), isNull(bookings.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function findResourceRequest(db: Database, id: string): Promise<ResourceRequestRow | null> {
  const [row] = await db
    .select()
    .from(requests)
    .where(and(eq(requests.id, id), isNull(requests.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function findProfile(db: Database, memberId: string): Promise<ProfileRow | null> {
  const [row] = await db.select().from(profiles).where(eq(profiles.memberId, memberId)).limit(1);
  return row ?? null;
}

/** Hours as the numeric column stores them (two decimals) from a request body. */
export function hours2(value: number): string {
  return value.toFixed(2);
}

// ── Load ────────────────────────────────────────────────────────────────────

/**
 * The load of every member over a range of weeks: bookings overlapping it
 * (tentative ones only when asked for; a booking held for a deleted or
 * rejected request, or on a deleted project, counts for nothing), open tasks
 * with an estimate, and the members to list (profiles, bookings, task
 * assignees and the people on current projects).
 */
export async function loadCapacity(
  db: Database,
  range: { from: string; to: string; weeks: number },
  options: { includeTentative: boolean; skill?: string },
): Promise<CapacityLoad> {
  const { from, to } = range;
  const bookingRows = await db
    .select({
      memberId: bookings.memberId,
      projectId: bookings.projectId,
      requestId: bookings.requestId,
      startsOn: bookings.startsOn,
      endsOn: bookings.endsOn,
      hoursPerWeek: bookings.hoursPerWeek,
      tentative: bookings.tentative,
    })
    .from(bookings)
    .leftJoin(schema.projects, eq(schema.projects.id, bookings.projectId))
    .leftJoin(projectRequests, eq(projectRequests.id, bookings.requestId))
    .where(
      and(
        isNull(bookings.deletedAt),
        lte(bookings.startsOn, to),
        gte(bookings.endsOn, from),
        or(isNull(bookings.projectId), isNull(schema.projects.deletedAt)),
        or(isNull(bookings.requestId), and(isNull(projectRequests.deletedAt), ne(projectRequests.status, 'rejected'))),
        options.includeTentative ? undefined : eq(bookings.tentative, false),
      ),
    )
    .orderBy(asc(bookings.startsOn), asc(bookings.id));

  const t = schema.tasks;
  const taskRows = await db
    .select({
      projectId: t.projectId,
      assigneeId: t.assigneeId,
      assigneeIds: t.assigneeIds,
      startsOn: sql<string | null>`to_char(${t.startDate}, 'YYYY-MM-DD')`,
      dueOn: sql<string | null>`to_char(${t.dueDate}, 'YYYY-MM-DD')`,
      estimatedHours: t.estimatedHours,
    })
    .from(t)
    .innerJoin(schema.projects, eq(schema.projects.id, t.projectId))
    .where(
      and(
        isNull(t.deletedAt),
        isNull(schema.projects.deletedAt),
        isNotNull(t.projectId),
        sql`${t.status} not in ('done', 'cancelled')`,
        sql`${t.estimatedHours} > 0`,
        sql`(${t.assigneeId} is not null or (case when jsonb_typeof(${t.assigneeIds}) = 'array' then jsonb_array_length(${t.assigneeIds}) else 0 end) > 0)`,
        sql`least(${t.startDate}, ${t.dueDate})::date <= ${to}::date`,
        sql`greatest(${t.startDate}, ${t.dueDate})::date >= ${from}::date`,
      ),
    )
    .orderBy(asc(t.id));

  const profileRows = await db
    .select({ memberId: profiles.memberId, weeklyHours: profiles.weeklyHours, skills: profiles.skills })
    .from(profiles)
    .orderBy(asc(profiles.memberId));

  const current = sql`${schema.projects.status} in ('Planning', 'Active', 'On Hold')`;
  const [memberRows, managerRows] = await Promise.all([
    db
      .selectDistinct({ id: schema.projectMembers.userId })
      .from(schema.projectMembers)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.projectMembers.projectId))
      .where(
        and(
          eq(schema.projectMembers.isActive, true),
          isNull(schema.projectMembers.deletedAt),
          isNull(schema.projects.deletedAt),
          current,
        ),
      ),
    db
      .selectDistinct({ id: schema.projects.projectManagerId })
      .from(schema.projects)
      .where(and(isNull(schema.projects.deletedAt), isNotNull(schema.projects.projectManagerId), current)),
  ]);

  const capacityBookings: CapacityBooking[] = bookingRows.map((row) => ({
    memberId: row.memberId,
    projectId: row.projectId,
    requestId: row.requestId,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    hoursPerWeek: Number(row.hoursPerWeek),
    tentative: row.tentative,
  }));
  const capacityTasks: CapacityTask[] = taskRows.flatMap((row) =>
    row.projectId === null
      ? []
      : [
          {
            projectId: row.projectId,
            assigneeId: row.assigneeId,
            assigneeIds: row.assigneeIds,
            startsOn: row.startsOn,
            dueOn: row.dueOn,
            estimatedHours: Number(row.estimatedHours),
          },
        ],
  );
  const members = collectMembers({
    profiles: profileRows.map((row) => ({ memberId: row.memberId, weeklyHours: Number(row.weeklyHours), skills: row.skills })),
    bookings: capacityBookings,
    tasks: capacityTasks,
    people: [...memberRows.map((row) => row.id), ...managerRows.flatMap((row) => (row.id ? [row.id] : []))],
  });
  return computeCapacity({
    from,
    weeks: range.weeks,
    members,
    bookings: capacityBookings,
    tasks: capacityTasks,
    includeTentative: options.includeTentative,
    skill: options.skill,
  });
}

// ── Names ───────────────────────────────────────────────────────────────────

export interface ProjectLabel {
  name: string;
  accessible: boolean;
}

/**
 * The names of projects the caller may see, "Other project" for the rest: the
 * membership boundary holds for the portfolio too, so a project the caller is
 * not in shows its hours and nothing else.
 */
export async function projectLabels(c: Ctx, projectIds: readonly string[]): Promise<Map<string, ProjectLabel>> {
  const labels = new Map<string, ProjectLabel>();
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return labels;
  const [rows, accessible] = await Promise.all([
    c
      .get('tenantDb')
      .select({ id: schema.projects.id, name: schema.projects.name })
      .from(schema.projects)
      .where(and(inArray(schema.projects.id, ids), isNull(schema.projects.deletedAt))),
    accessibleProjectIds(c),
  ]);
  const allowed = accessible === null ? null : new Set(accessible);
  for (const row of rows) {
    const mayAccess = allowed === null || allowed.has(row.id);
    labels.set(row.id, { name: mayAccess ? row.name : OTHER_PROJECT_NAME, accessible: mayAccess });
  }
  return labels;
}

/** A project's label, "Other project" for one that is missing or off-limits. */
export function labelOf(labels: Map<string, ProjectLabel>, projectId: string): ProjectLabel {
  return labels.get(projectId) ?? { name: OTHER_PROJECT_NAME, accessible: false };
}

/** The load as the capacity route answers it: each project row named for the caller. */
export async function presentLoad(
  c: Ctx,
  load: CapacityLoad,
  range: CapacityRange,
  includeTentative: boolean,
): Promise<CapacityResponse> {
  const db = c.get('tenantDb');
  const projectIds = load.members.flatMap((m) => m.projects.flatMap((p) => (p.projectId ? [p.projectId] : [])));
  const requestIds = [...new Set(load.members.flatMap((m) => m.projects.flatMap((p) => (p.requestId ? [p.requestId] : []))))];
  const labels = await projectLabels(c, projectIds);
  const requestTitles = new Map<string, string>();
  if (requestIds.length > 0) {
    const rows = await db
      .select({ id: projectRequests.id, title: projectRequests.title })
      .from(projectRequests)
      .where(inArray(projectRequests.id, requestIds));
    for (const row of rows) requestTitles.set(row.id, row.title);
  }
  return {
    from: range.from,
    to: range.to,
    tentative: includeTentative,
    weeks: load.weeks,
    totals: load.totals,
    summary: load.summary,
    members: load.members.map((member) => ({
      ...member,
      projects: member.projects.map((row) => {
        if (row.projectId) {
          const label = labelOf(labels, row.projectId);
          return { ...row, name: label.name, accessible: label.accessible };
        }
        return { ...row, name: requestTitles.get(row.requestId ?? '') ?? OTHER_PROJECT_NAME, accessible: true };
      }),
    })),
  };
}
