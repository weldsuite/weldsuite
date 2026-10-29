/**
 * Shared helpers of the read tools (tasks, projects): row-level project scope,
 * display names, and the due-date cutoff the model hands over as an ISO string.
 *
 * Tenant scoping: the tenant DB is per workspace and these tables carry no
 * workspace id, so every query filters by ids and `deleted_at IS NULL`.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { dayBoundsInTimezone } from '@weldsuite/flow-domain/day-boundaries';

/** Task statuses that count as finished (the same pair WeldFlow's open-task counts use). */
export const CLOSED_TASK_STATUSES = ['done', 'cancelled'] as const;

/**
 * Projects a person manages or is an active member of. This is the
 * membership boundary WeldFlow applies to everyone without
 * `projects:scope:all` (apps/workers/flow-api/src/lib/project-access.ts).
 */
export async function accessibleProjectIds(db: Database, userId: string): Promise<string[]> {
  const { projects, projectMembers } = schema;
  const [managed, memberOf] = await Promise.all([
    db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.projectManagerId, userId), isNull(projects.deletedAt))),
    db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(
        and(
          eq(projectMembers.userId, userId),
          eq(projectMembers.isActive, true),
          isNull(projectMembers.deletedAt),
          isNull(projects.deletedAt),
        ),
      ),
  ]);
  return [...new Set([...managed.map((row) => row.id), ...memberOf.map((row) => row.projectId)])];
}

function distinct(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

/** Display names of workspace members, by user id (the email when a member has no name). */
export async function memberNames(
  db: Database,
  userIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = distinct(userIds);
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const { workspaceMembers } = schema;
  const rows = await db
    .select({ userId: workspaceMembers.userId, name: workspaceMembers.name, email: workspaceMembers.email })
    .from(workspaceMembers)
    .where(inArray(workspaceMembers.userId, ids));
  for (const row of rows) {
    const label = row.name || row.email;
    if (label) names.set(row.userId, label);
  }
  return names;
}

/** Names of projects, by id. */
export async function projectNames(
  db: Database,
  projectIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = distinct(projectIds);
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const rows = await db
    .select({ id: schema.projects.id, name: schema.projects.name })
    .from(schema.projects)
    .where(inArray(schema.projects.id, ids));
  for (const row of rows) names.set(row.id, row.name);
  return names;
}

/** Every assignee of a task: the primary assignee and the multi-assignee list, once each. */
export function taskAssigneeIds(task: { assigneeId: string | null; assigneeIds: string[] | null }): string[] {
  return distinct([task.assigneeId, ...(task.assigneeIds ?? [])]);
}

export interface DueCutoff {
  at: Date;
  /** `true`: a due date up to and including `at` matches; `false`: strictly before it. */
  inclusive: boolean;
}

const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The calendar date (`YYYY-MM-DD`) an instant falls on in a time zone. */
function localDateOf(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${field('year')}-${field('month')}-${field('day')}`;
}

function validTimezone(timezone: string | null | undefined): string {
  if (!timezone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone;
  } catch {
    return 'UTC';
  }
}

/**
 * The upper bound a due-date filter stands for. A plain date (`2026-10-27`)
 * means that whole calendar day in `timezone`, so "due today" also finds the
 * tasks due that afternoon: the bound is the next local midnight, exclusive.
 * A date-time is an exact instant, inclusive. Anything else: null.
 */
export function dueCutoff(input: string, timezone: string | null | undefined): DueCutoff | null {
  const text = input.trim();
  const plain = PLAIN_DATE.exec(text);
  if (plain) {
    const zone = validTimezone(timezone);
    const [year, month, day] = [Number(plain[1]), Number(plain[2]), Number(plain[3])];
    const given = new Date(Date.UTC(year, month - 1, day));
    // 2026-02-31 and the like roll over into the next month: never a real date.
    if (given.getUTCFullYear() !== year || given.getUTCMonth() !== month - 1 || given.getUTCDate() !== day) return null;
    const wanted = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
    // An instant on the next day in the zone, whichever side of UTC the zone is.
    const noon = new Date(Date.UTC(year, month - 1, day + 1, 12));
    const probe = localDateOf(noon, zone) === wanted ? noon : new Date(Date.UTC(year, month - 1, day + 1));
    return { at: dayBoundsInTimezone(zone, probe).startOfToday, inclusive: false };
  }
  const instant = new Date(text);
  return Number.isNaN(instant.getTime()) ? null : { at: instant, inclusive: true };
}

/** Today's calendar date (`YYYY-MM-DD`) in a time zone (UTC when it is missing or unknown). */
export function todayIn(timezone: string | null | undefined, now: Date = new Date()): string {
  return localDateOf(now, validTimezone(timezone));
}
