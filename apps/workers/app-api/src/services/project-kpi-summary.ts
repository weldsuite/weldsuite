/**
 * WeldFlow portfolio / project KPI aggregates (live Postgres counts).
 */

import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import type { Database } from '../db';
import { schema } from '../db';
import type { ProjectKpiPeriod, ProjectKpiSummary } from '@weldsuite/core-api-client/schemas/project-analytics';

function periodDays(period: ProjectKpiPeriod): number {
  if (period === '7d') return 7;
  if (period === '90d') return 90;
  return 30;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function countByKey(rows: { key: string | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = row.key || 'unknown';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export async function getProjectKpiSummary(
  db: Database,
  opts: {
    period: ProjectKpiPeriod;
    /** null = all projects (caller already authorized). Empty = no access. */
    projectIds: string[] | null;
    /** When set, restrict to a single project (must be in projectIds / allowed). */
    projectId?: string;
  },
): Promise<ProjectKpiSummary> {
  const { projects, tasks, timeEntries } = schema;
  const period = opts.period;
  const now = new Date();
  const todayStart = startOfUtcDay(now);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);

  const days = periodDays(period);
  const fromDate = new Date(todayStart);
  fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1));
  const fromIso = isoDate(fromDate);
  const toIso = isoDate(todayStart);

  // Resolve project scope
  let scopedIds: string[] | null = opts.projectIds;
  if (opts.projectId) {
    if (scopedIds !== null && !scopedIds.includes(opts.projectId)) {
      return emptySummary(period, fromIso, toIso);
    }
    scopedIds = [opts.projectId];
  }
  if (scopedIds !== null && scopedIds.length === 0) {
    return emptySummary(period, fromIso, toIso);
  }

  const projectScope =
    scopedIds === null
      ? [isNull(projects.deletedAt)]
      : [isNull(projects.deletedAt), inArray(projects.id, scopedIds)];

  const taskScope =
    scopedIds === null
      ? [isNull(tasks.deletedAt), isNotNull(tasks.projectId)]
      : [isNull(tasks.deletedAt), inArray(tasks.projectId, scopedIds)];

  const timeScope =
    scopedIds === null
      ? [isNull(timeEntries.deletedAt), isNotNull(timeEntries.projectId)]
      : [isNull(timeEntries.deletedAt), inArray(timeEntries.projectId, scopedIds)];

  const [
    projectRows,
    taskRows,
    dueTodayRes,
    overdueRes,
    hoursRes,
    throughputRows,
  ] = await Promise.all([
    db
      .select({
        status: projects.status,
        health: projects.health,
        isActive: projects.isActive,
      })
      .from(projects)
      .where(and(...projectScope)),

    db
      .select({
        status: tasks.status,
        priority: tasks.priority,
      })
      .from(tasks)
      .where(and(...taskScope)),

    db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(
        and(
          ...taskScope,
          gte(tasks.dueDate, todayStart),
          lt(tasks.dueDate, tomorrowStart),
          sql`${tasks.status} not in ('done', 'cancelled')`,
        ),
      ),

    db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(
        and(
          ...taskScope,
          isNotNull(tasks.dueDate),
          lt(tasks.dueDate, todayStart),
          sql`${tasks.status} not in ('done', 'cancelled')`,
        ),
      ),

    db
      .select({
        total: sql<number>`coalesce(sum(${timeEntries.duration})::float, 0)`,
        billable: sql<number>`coalesce(sum(case when ${timeEntries.billable} then ${timeEntries.duration} else 0 end)::float, 0)`,
      })
      .from(timeEntries)
      .where(
        and(
          ...timeScope,
          gte(timeEntries.date, fromIso),
          lte(timeEntries.date, toIso),
        ),
      ),

    db
      .select({
        date: sql<string>`to_char(date_trunc('day', ${tasks.completedDate}), 'YYYY-MM-DD')`,
        completed: sql<number>`count(*)::int`,
      })
      .from(tasks)
      .where(
        and(
          ...taskScope,
          eq(tasks.status, 'done'),
          isNotNull(tasks.completedDate),
          gte(tasks.completedDate, fromDate),
          lt(tasks.completedDate, tomorrowStart),
        ),
      )
      .groupBy(sql`date_trunc('day', ${tasks.completedDate})`)
      .orderBy(sql`date_trunc('day', ${tasks.completedDate})`),
  ]);

  const activeProjects = projectRows.filter(
    (p) => p.isActive && p.status !== 'Completed' && p.status !== 'Cancelled',
  ).length;

  const totalTasks = taskRows.length;
  const completedTasks = taskRows.filter((t) => t.status === 'done').length;
  const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 1000) / 10 : 0;

  const throughputMap = new Map<string, number>();
  for (const row of throughputRows) {
    if (row.date) throughputMap.set(row.date, Number(row.completed) || 0);
  }
  const throughputByDay: { date: string; completed: number }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(fromDate);
    d.setUTCDate(fromDate.getUTCDate() + i);
    const key = isoDate(d);
    throughputByDay.push({ date: key, completed: throughputMap.get(key) ?? 0 });
  }

  const hours = hoursRes[0];

  return {
    activeProjects,
    tasksDueToday: Number(dueTodayRes[0]?.count ?? 0),
    overdueTasks: Number(overdueRes[0]?.count ?? 0),
    totalTasks,
    completedTasks,
    completionRate,
    hoursLoggedMinutes: Math.round(Number(hours?.total ?? 0)),
    billableHoursMinutes: Math.round(Number(hours?.billable ?? 0)),
    projectsByStatus: countByKey(projectRows.map((p) => ({ key: p.status }))),
    projectsByHealth: countByKey(
      projectRows.filter((p) => p.health).map((p) => ({ key: p.health })),
    ),
    tasksByPriority: countByKey(taskRows.map((t) => ({ key: t.priority }))),
    throughputByDay,
    period,
    from: fromIso,
    to: toIso,
  };
}

function emptySummary(period: ProjectKpiPeriod, from: string, to: string): ProjectKpiSummary {
  return {
    activeProjects: 0,
    tasksDueToday: 0,
    overdueTasks: 0,
    totalTasks: 0,
    completedTasks: 0,
    completionRate: 0,
    hoursLoggedMinutes: 0,
    billableHoursMinutes: 0,
    projectsByStatus: {},
    projectsByHealth: {},
    tasksByPriority: {},
    throughputByDay: [],
    period,
    from,
    to,
  };
}
