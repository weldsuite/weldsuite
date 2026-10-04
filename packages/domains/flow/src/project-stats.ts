/**
 * Project / milestone statistics, computed on read.
 *
 * The denormalised columns (`projects.total_tasks`, `completed_tasks`,
 * `open_tasks`, `total_milestones`, `completed_milestones`, `progress`,
 * `actual_hours`, `milestones.total_tasks` / `completed_tasks` / `progress`)
 * are only ever written by seed data, so every read of the raw column returns
 * the default 0. Instead of maintaining them from ~30
 * write sites across several workers, readers derive the values with grouped
 * aggregates and overlay them on the row under the same keys (same shapes:
 * `progress` / `actualHours` are numeric strings like the columns they replace,
 * counters are integers).
 *
 * Definitions:
 *  - totalTasks      non-deleted tasks of the project (subtasks and cancelled included)
 *  - completedTasks  status = 'done'
 *  - openTasks       status not in ('done', 'cancelled')
 *  - progress        completed / (total - cancelled) * 100, 2 decimals, 0 when nothing counts
 *  - totalMilestones non-deleted milestones; completedMilestones status = 'completed'
 *  - milestone task counters: same rules grouped by `tasks.milestone_id`; a milestone
 *    without countable tasks reads 100 when its status is 'completed', else 0
 *  - actualHours     sum of non-deleted, non-rejected time entry minutes / 60, 2 decimals
 *
 * Tenant scoping: the tenant DB is per workspace and these tables carry no
 * workspace id, so every query filters by ids + deleted_at IS NULL.
 */
import { and, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';

export interface ProjectStats {
  totalTasks: number;
  completedTasks: number;
  openTasks: number;
  totalMilestones: number;
  completedMilestones: number;
  /** numeric(5,2)-style string, e.g. "37.50". */
  progress: string;
  /** numeric(18,2)-style string of hours, e.g. "2.00". */
  actualHours: string;
}

export interface MilestoneStats {
  totalTasks: number;
  completedTasks: number;
  /** numeric(5,2)-style string, e.g. "50.00". */
  progress: string;
}

/** Minimal milestone shape needed to compute its stats. */
export interface MilestoneRef {
  id: string;
  status: string | null;
}

export const EMPTY_PROJECT_STATS: Readonly<ProjectStats> = Object.freeze({
  totalTasks: 0,
  completedTasks: 0,
  openTasks: 0,
  totalMilestones: 0,
  completedMilestones: 0,
  progress: '0.00',
  actualHours: '0.00',
});

const TASK_DONE = 'done';
const TASK_CANCELLED = 'cancelled';
const MILESTONE_COMPLETED = 'completed';
const TIME_ENTRY_REJECTED = 'rejected';

function unique(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.filter((id) => id.length > 0)));
}

/** completed / (total - cancelled) * 100 as a 2-decimal string; 0.00 when nothing counts. */
function percent(completed: number, countable: number): string {
  if (countable <= 0) return '0.00';
  return ((completed / countable) * 100).toFixed(2);
}

/** Minutes (possibly a numeric string / null from SQL) to a 2-decimal hours string. */
function minutesToHours(minutes: string | number | null | undefined): string {
  const value = Number(minutes ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '0.00';
  return (Math.round((value / 60) * 100) / 100).toFixed(2);
}

/** Computed stats for each project id. Every requested id is present in the result. */
export async function getProjectStats(
  db: Database,
  projectIds: readonly string[],
): Promise<Map<string, ProjectStats>> {
  const ids = unique(projectIds);
  const result = new Map<string, ProjectStats>();
  if (ids.length === 0) return result;

  const { tasks, milestones, timeEntries } = schema;

  const [taskRows, milestoneRows, timeRows] = await Promise.all([
    db
      .select({
        projectId: tasks.projectId,
        total: sql<number>`count(*)::int`,
        completed: sql<number>`(count(*) filter (where ${tasks.status} = ${TASK_DONE}))::int`,
        cancelled: sql<number>`(count(*) filter (where ${tasks.status} = ${TASK_CANCELLED}))::int`,
      })
      .from(tasks)
      .where(and(inArray(tasks.projectId, ids), isNull(tasks.deletedAt)))
      .groupBy(tasks.projectId),
    db
      .select({
        projectId: milestones.projectId,
        total: sql<number>`count(*)::int`,
        completed: sql<number>`(count(*) filter (where ${milestones.status} = ${MILESTONE_COMPLETED}))::int`,
      })
      .from(milestones)
      .where(and(inArray(milestones.projectId, ids), isNull(milestones.deletedAt)))
      .groupBy(milestones.projectId),
    db
      .select({
        projectId: timeEntries.projectId,
        minutes: sql<string | null>`sum(${timeEntries.duration})`,
      })
      .from(timeEntries)
      .where(
        and(
          inArray(timeEntries.projectId, ids),
          isNull(timeEntries.deletedAt),
          sql`${timeEntries.status} <> ${TIME_ENTRY_REJECTED}`,
        ),
      )
      .groupBy(timeEntries.projectId),
  ]);

  const taskByProject = new Map(taskRows.map((r) => [r.projectId, r]));
  const milestoneByProject = new Map(milestoneRows.map((r) => [r.projectId, r]));
  const minutesByProject = new Map(timeRows.map((r) => [r.projectId, r.minutes]));

  for (const id of ids) {
    const task = taskByProject.get(id);
    const milestone = milestoneByProject.get(id);
    const total = Number(task?.total ?? 0);
    const completed = Number(task?.completed ?? 0);
    const cancelled = Number(task?.cancelled ?? 0);
    result.set(id, {
      totalTasks: total,
      completedTasks: completed,
      openTasks: Math.max(total - completed - cancelled, 0),
      totalMilestones: Number(milestone?.total ?? 0),
      completedMilestones: Number(milestone?.completed ?? 0),
      progress: percent(completed, total - cancelled),
      actualHours: minutesToHours(minutesByProject.get(id)),
    });
  }
  return result;
}

/** Computed task counters + progress for each milestone. Every requested milestone is present. */
export async function getMilestoneStats(
  db: Database,
  milestoneRefs: readonly MilestoneRef[],
): Promise<Map<string, MilestoneStats>> {
  const statusById = new Map<string, string | null>();
  for (const m of milestoneRefs) if (m.id) statusById.set(m.id, m.status);
  const result = new Map<string, MilestoneStats>();
  if (statusById.size === 0) return result;

  const { tasks } = schema;
  const rows = await db
    .select({
      milestoneId: tasks.milestoneId,
      total: sql<number>`count(*)::int`,
      completed: sql<number>`(count(*) filter (where ${tasks.status} = ${TASK_DONE}))::int`,
      cancelled: sql<number>`(count(*) filter (where ${tasks.status} = ${TASK_CANCELLED}))::int`,
    })
    .from(tasks)
    .where(
      and(
        inArray(tasks.milestoneId, Array.from(statusById.keys())),
        isNotNull(tasks.milestoneId),
        isNull(tasks.deletedAt),
      ),
    )
    .groupBy(tasks.milestoneId);
  const byMilestone = new Map(rows.map((r) => [r.milestoneId, r]));

  for (const [id, status] of statusById) {
    const row = byMilestone.get(id);
    const total = Number(row?.total ?? 0);
    const completed = Number(row?.completed ?? 0);
    const cancelled = Number(row?.cancelled ?? 0);
    const countable = total - cancelled;
    result.set(id, {
      totalTasks: total,
      completedTasks: completed,
      progress:
        countable > 0
          ? percent(completed, countable)
          : status === MILESTONE_COMPLETED
            ? '100.00'
            : '0.00',
    });
  }
  return result;
}

/** Rows with the computed project stats replacing the stored columns. */
export function withProjectStats<T extends { id: string }>(
  rows: readonly T[],
  stats: ReadonlyMap<string, ProjectStats>,
): Array<T & ProjectStats> {
  return rows.map((row) => ({ ...row, ...(stats.get(row.id) ?? EMPTY_PROJECT_STATS) }));
}

/** Rows with the computed milestone stats replacing the stored columns. */
export function withMilestoneStats<T extends { id: string }>(
  rows: readonly T[],
  stats: ReadonlyMap<string, MilestoneStats>,
): Array<T & MilestoneStats> {
  return rows.map((row) => ({
    ...row,
    ...(stats.get(row.id) ?? { totalTasks: 0, completedTasks: 0, progress: '0.00' }),
  }));
}
