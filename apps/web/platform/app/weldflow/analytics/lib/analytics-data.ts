import { and, eq, gte, lte, sql, desc, asc } from 'drizzle-orm';
import { getScopedDb } from '@/lib/db';
import {
  mvProjectsSummaryDaily,
  mvTasksDaily,
  mvTimeEntriesDaily,
  mvMilestoneStats,
} from '@/lib/db/schema';

// ============ CONFIGURATION ============

const USE_MATERIALIZED_VIEWS = true;

const VALID_TRUNC_UNITS = ['hour', 'day', 'week', 'month', 'quarter', 'year'] as const;
type TruncUnit = (typeof VALID_TRUNC_UNITS)[number];

// Chart colors matching the UI palette
const CHART_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
];

// ============ TYPES ============

export interface ChartDataPoint {
  label: string;
  value: number;
  fill?: string;
  [key: string]: string | number | undefined;
}

export interface ChartQueryConfig {
  workspaceId: string;
  entity: string;
  metric: string;
  timeRange: string;
  groupBy: string;
  aggregation: string;
  sortOrder?: string;
  limit?: number;
  projectId?: string; // Optional: filter by specific project
}

// ============ HELPERS ============

function getDateRangeFromTimeRange(timeRange: string): { start: Date; end: Date } {
  const now = new Date();
  let start = new Date();
  const end = new Date();

  end.setHours(23, 59, 59, 999);

  switch (timeRange) {
    case 'today':
      start.setHours(0, 0, 0, 0);
      break;
    case 'yesterday':
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() - 1);
      break;
    case 'last_7_days':
      start.setDate(start.getDate() - 7);
      start.setHours(0, 0, 0, 0);
      break;
    case 'last_30_days':
      start.setDate(start.getDate() - 30);
      start.setHours(0, 0, 0, 0);
      break;
    case 'last_90_days':
      start.setDate(start.getDate() - 90);
      start.setHours(0, 0, 0, 0);
      break;
    case 'this_month':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'last_month':
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      end.setDate(0);
      break;
    case 'this_quarter': {
      const quarter = Math.floor(now.getMonth() / 3);
      start = new Date(now.getFullYear(), quarter * 3, 1);
      break;
    }
    case 'this_year':
      start = new Date(now.getFullYear(), 0, 1);
      break;
    case 'last_year':
      start = new Date(now.getFullYear() - 1, 0, 1);
      end.setFullYear(end.getFullYear() - 1);
      break;
    case 'all_time':
      start = new Date(2020, 0, 1);
      break;
    default:
      start.setDate(start.getDate() - 30);
      start.setHours(0, 0, 0, 0);
  }

  return { start, end };
}

function getDateTruncUnit(groupBy: string): TruncUnit {
  if (VALID_TRUNC_UNITS.includes(groupBy as TruncUnit)) {
    return groupBy as TruncUnit;
  }
  return 'day';
}

function formatDateLabel(date: Date | string, truncUnit: TruncUnit): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return String(date);

  switch (truncUnit) {
    case 'hour':
      return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' });
    case 'day':
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    case 'week':
      return `Week ${Math.ceil(d.getDate() / 7)}, ${d.toLocaleDateString('en-US', { month: 'short' })}`;
    case 'month':
      return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    case 'quarter':
      return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`;
    case 'year':
      return d.getFullYear().toString();
    default:
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}

function formatStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    // Project statuses
    planning: 'Planning',
    active: 'Active',
    on_hold: 'On Hold',
    completed: 'Completed',
    cancelled: 'Cancelled',
    // Task statuses
    backlog: 'Backlog',
    todo: 'To Do',
    in_progress: 'In Progress',
    in_review: 'In Review',
    testing: 'Testing',
    done: 'Done',
    // Time entry statuses
    draft: 'Draft',
    submitted: 'Submitted',
    approved: 'Approved',
    rejected: 'Rejected',
    billed: 'Billed',
    // Milestone statuses
    pending: 'Pending',
    missed: 'Missed',
    postponed: 'Postponed',
  };
  return labels[status] || status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatPriorityLabel(priority: string): string {
  const labels: Record<string, string> = {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
    none: 'None',
  };
  return labels[priority] || priority;
}

function formatTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    task: 'Task',
    bug: 'Bug',
    story: 'Story',
    epic: 'Epic',
    feature: 'Feature',
    improvement: 'Improvement',
    subtask: 'Subtask',
  };
  return labels[type] || type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatHealthLabel(health: string): string {
  const labels: Record<string, string> = {
    on_track: 'On Track',
    at_risk: 'At Risk',
    off_track: 'Off Track',
    completed: 'Completed',
  };
  return labels[health] || health.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ============ PROJECT METRICS ============

async function getProjectMetrics(config: ChartQueryConfig): Promise<ChartDataPoint[]> {
  // workspaceId is not destructured here — mvProjectsSummaryDaily has no workspaceId
  // column, since getScopedDb() already connects to this workspace's own tenant DB.
  const { metric, timeRange, groupBy, sortOrder, limit, projectId } = config;
  const { start, end } = getDateRangeFromTimeRange(timeRange);
  const truncUnit = getDateTruncUnit(groupBy);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const { db } = await getScopedDb();

  if (USE_MATERIALIZED_VIEWS) {
    // Build base conditions with optional projectId filter
    const mvBaseConditions = and(
      gte(mvProjectsSummaryDaily.period, sql`${startIso}::timestamp`),
      lte(mvProjectsSummaryDaily.period, sql`${endIso}::timestamp`),
      projectId ? eq(mvProjectsSummaryDaily.projectId, projectId) : undefined
    );

    switch (metric) {
      case 'total_projects':
      case 'projects_by_day': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvProjectsSummaryDaily.period})`;
        const results = await db
          .select({
            period: periodExpr,
            count: sql<number>`SUM(${mvProjectsSummaryDaily.projectCount})`,
          })
          .from(mvProjectsSummaryDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, i) => ({
          label: formatDateLabel(row.period as Date, truncUnit),
          value: Number(row.count) || 0,
          fill: CHART_COLORS[i % CHART_COLORS.length],
        }));
      }

      case 'active_projects': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvProjectsSummaryDaily.period})`;
        const results = await db
          .select({
            period: periodExpr,
            count: sql<number>`SUM(${mvProjectsSummaryDaily.activeCount})`,
          })
          .from(mvProjectsSummaryDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, i) => ({
          label: formatDateLabel(row.period as Date, truncUnit),
          value: Number(row.count) || 0,
          fill: CHART_COLORS[i % CHART_COLORS.length],
        }));
      }

      case 'projects_by_status': {
        const results = await db
          .select({
            status: mvProjectsSummaryDaily.status,
            count: sql<number>`SUM(${mvProjectsSummaryDaily.projectCount})`,
          })
          .from(mvProjectsSummaryDaily)
          .where(mvBaseConditions)
          .groupBy(mvProjectsSummaryDaily.status)
          .orderBy(sortOrder === 'desc' ? desc(sql`SUM(${mvProjectsSummaryDaily.projectCount})`) : asc(sql`SUM(${mvProjectsSummaryDaily.projectCount})`))
          .limit(limit || 10);

        return results.map((row, i) => ({
          label: formatStatusLabel(row.status),
          value: Number(row.count) || 0,
          fill: CHART_COLORS[i % CHART_COLORS.length],
        }));
      }

      case 'projects_by_health': {
        const results = await db
          .select({
            health: mvProjectsSummaryDaily.health,
            count: sql<number>`SUM(${mvProjectsSummaryDaily.projectCount})`,
          })
          .from(mvProjectsSummaryDaily)
          .where(and(mvBaseConditions, sql`${mvProjectsSummaryDaily.health} IS NOT NULL`))
          .groupBy(mvProjectsSummaryDaily.health)
          .orderBy(sortOrder === 'desc' ? desc(sql`SUM(${mvProjectsSummaryDaily.projectCount})`) : asc(sql`SUM(${mvProjectsSummaryDaily.projectCount})`))
          .limit(limit || 10);

        const healthColorMap: Record<string, string> = {
          on_track: 'hsl(var(--chart-2))',
          at_risk: 'hsl(var(--chart-3))',
          off_track: 'hsl(var(--destructive))',
          completed: 'hsl(var(--chart-5))',
        };

        return results.map((row, i) => ({
          label: formatHealthLabel(row.health || 'Unknown'),
          value: Number(row.count) || 0,
          fill: healthColorMap[row.health || ''] || CHART_COLORS[i % CHART_COLORS.length],
        }));
      }

      case 'completion_rate': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvProjectsSummaryDaily.period})`;
        const results = await db
          .select({
            period: periodExpr,
            completed: sql<number>`SUM(${mvProjectsSummaryDaily.completedTasks})`,
            total: sql<number>`SUM(${mvProjectsSummaryDaily.totalTasks})`,
          })
          .from(mvProjectsSummaryDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, i) => {
          const total = Number(row.total);
          const rate = total > 0 ? Math.round((Number(row.completed) / total) * 100) : 0;
          return {
            label: formatDateLabel(row.period as Date, truncUnit),
            value: rate,
            fill: CHART_COLORS[i % CHART_COLORS.length],
          };
        });
      }

      case 'budget_utilization': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvProjectsSummaryDaily.period})`;
        const results = await db
          .select({
            period: periodExpr,
            actual: sql<number>`SUM(${mvProjectsSummaryDaily.totalActualAmount})`,
            budgeted: sql<number>`SUM(${mvProjectsSummaryDaily.totalBudgetedAmount})`,
          })
          .from(mvProjectsSummaryDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, i) => {
          const budgeted = Number(row.budgeted);
          const rate = budgeted > 0 ? Math.round((Number(row.actual) / budgeted) * 100) : 0;
          return {
            label: formatDateLabel(row.period as Date, truncUnit),
            value: rate,
            fill: CHART_COLORS[i % CHART_COLORS.length],
          };
        });
      }

      case 'hours_utilization': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvProjectsSummaryDaily.period})`;
        const results = await db
          .select({
            period: periodExpr,
            actual: sql<number>`SUM(${mvProjectsSummaryDaily.totalActualHours})`,
            budgeted: sql<number>`SUM(${mvProjectsSummaryDaily.totalBudgetedHours})`,
          })
          .from(mvProjectsSummaryDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, i) => {
          const budgeted = Number(row.budgeted);
          const rate = budgeted > 0 ? Math.round((Number(row.actual) / budgeted) * 100) : 0;
          return {
            label: formatDateLabel(row.period as Date, truncUnit),
            value: rate,
            fill: CHART_COLORS[i % CHART_COLORS.length],
          };
        });
      }

      case 'avg_progress': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvProjectsSummaryDaily.period})`;
        const results = await db
          .select({
            period: periodExpr,
            avgProgress: sql<number>`SUM(${mvProjectsSummaryDaily.avgProgress}::numeric * ${mvProjectsSummaryDaily.projectCount}) / NULLIF(SUM(${mvProjectsSummaryDaily.projectCount}), 0)`,
          })
          .from(mvProjectsSummaryDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, i) => ({
          label: formatDateLabel(row.period as Date, truncUnit),
          value: Math.round(Number(row.avgProgress) || 0),
          fill: CHART_COLORS[i % CHART_COLORS.length],
        }));
      }

      default:
        return [];
    }
  }

  return [];
}

// ============ TASK METRICS ============

async function getTaskMetrics(config: ChartQueryConfig): Promise<ChartDataPoint[]> {
  // workspaceId is not destructured here — mvTasksDaily has no workspaceId column,
  // since getScopedDb() already connects to this workspace's own tenant DB.
  const { metric, timeRange, groupBy, sortOrder, limit, projectId } = config;
  const { start, end } = getDateRangeFromTimeRange(timeRange);
  const truncUnit = getDateTruncUnit(groupBy);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const { db } = await getScopedDb();

  if (USE_MATERIALIZED_VIEWS) {
    const mvBaseConditions = and(
      gte(mvTasksDaily.period, sql`${startIso}::timestamp`),
      lte(mvTasksDaily.period, sql`${endIso}::timestamp`),
      projectId ? eq(mvTasksDaily.projectId, projectId) : undefined
    );

    switch (metric) {
      case 'total_tasks':
      case 'tasks_by_day': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvTasksDaily.period})`;
        const results = await db
          .select({
            period: periodExpr,
            count: sql<number>`SUM(${mvTasksDaily.taskCount})`,
          })
          .from(mvTasksDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, i) => ({
          label: formatDateLabel(row.period as Date, truncUnit),
          value: Number(row.count) || 0,
          fill: CHART_COLORS[i % CHART_COLORS.length],
        }));
      }

      case 'completed_tasks': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvTasksDaily.period})`;
        const results = await db
          .select({
            period: periodExpr,
            count: sql<number>`SUM(${mvTasksDaily.completedCount})`,
          })
          .from(mvTasksDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, i) => ({
          label: formatDateLabel(row.period as Date, truncUnit),
          value: Number(row.count) || 0,
          fill: CHART_COLORS[i % CHART_COLORS.length],
        }));
      }

      case 'overdue_tasks': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvTasksDaily.period})`;
        const results = await db
          .select({
            period: periodExpr,
            count: sql<number>`SUM(${mvTasksDaily.overdueCount})`,
          })
          .from(mvTasksDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, i) => ({
          label: formatDateLabel(row.period as Date, truncUnit),
          value: Number(row.count) || 0,
          fill: CHART_COLORS[i % CHART_COLORS.length],
        }));
      }

      case 'tasks_by_status': {
        const results = await db
          .select({
            status: mvTasksDaily.status,
            count: sql<number>`SUM(${mvTasksDaily.taskCount})`,
          })
          .from(mvTasksDaily)
          .where(mvBaseConditions)
          .groupBy(mvTasksDaily.status)
          .orderBy(sortOrder === 'desc' ? desc(sql`SUM(${mvTasksDaily.taskCount})`) : asc(sql`SUM(${mvTasksDaily.taskCount})`))
          .limit(limit || 10);

        return results.map((row, i) => ({
          label: formatStatusLabel(row.status),
          value: Number(row.count) || 0,
          fill: CHART_COLORS[i % CHART_COLORS.length],
        }));
      }

      case 'tasks_by_priority': {
        const results = await db
          .select({
            priority: mvTasksDaily.priority,
            count: sql<number>`SUM(${mvTasksDaily.taskCount})`,
          })
          .from(mvTasksDaily)
          .where(mvBaseConditions)
          .groupBy(mvTasksDaily.priority)
          .orderBy(sortOrder === 'desc' ? desc(sql`SUM(${mvTasksDaily.taskCount})`) : asc(sql`SUM(${mvTasksDaily.taskCount})`))
          .limit(limit || 10);

        const priorityColorMap: Record<string, string> = {
          critical: 'hsl(var(--destructive))',
          high: 'hsl(var(--chart-1))',
          medium: 'hsl(var(--chart-3))',
          low: 'hsl(var(--chart-2))',
          none: 'hsl(var(--chart-5))',
        };

        return results.map((row, i) => ({
          label: formatPriorityLabel(row.priority),
          value: Number(row.count) || 0,
          fill: priorityColorMap[row.priority] || CHART_COLORS[i % CHART_COLORS.length],
        }));
      }

      case 'tasks_by_type': {
        const results = await db
          .select({
            type: mvTasksDaily.type,
            count: sql<number>`SUM(${mvTasksDaily.taskCount})`,
          })
          .from(mvTasksDaily)
          .where(and(mvBaseConditions, sql`${mvTasksDaily.type} IS NOT NULL`))
          .groupBy(mvTasksDaily.type)
          .orderBy(sortOrder === 'desc' ? desc(sql`SUM(${mvTasksDaily.taskCount})`) : asc(sql`SUM(${mvTasksDaily.taskCount})`))
          .limit(limit || 10);

        return results.map((row, i) => ({
          label: formatTypeLabel(row.type || 'Unknown'),
          value: Number(row.count) || 0,
          fill: CHART_COLORS[i % CHART_COLORS.length],
        }));
      }

      case 'throughput': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvTasksDaily.period})`;
        const results = await db
          .select({
            period: periodExpr,
            count: sql<number>`SUM(${mvTasksDaily.completedCount})`,
          })
          .from(mvTasksDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, i) => ({
          label: formatDateLabel(row.period as Date, truncUnit),
          value: Number(row.count) || 0,
          fill: CHART_COLORS[i % CHART_COLORS.length],
        }));
      }

      case 'estimation_accuracy': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvTasksDaily.period})`;
        const results = await db
          .select({
            period: periodExpr,
            actual: sql<number>`SUM(${mvTasksDaily.totalActualHours})`,
            estimated: sql<number>`SUM(${mvTasksDaily.totalEstimatedHours})`,
          })
          .from(mvTasksDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, i) => {
          const estimated = Number(row.estimated);
          const accuracy = estimated > 0 ? Math.round((Number(row.actual) / estimated) * 100) : 0;
          return {
            label: formatDateLabel(row.period as Date, truncUnit),
            value: accuracy,
            fill: CHART_COLORS[i % CHART_COLORS.length],
          };
        });
      }

      default:
        return [];
    }
  }

  return [];
}

// ============ TIME ENTRY METRICS ============

async function getTimeEntryMetrics(config: ChartQueryConfig): Promise<ChartDataPoint[]> {
  // workspaceId is not destructured here — mvTimeEntriesDaily has no workspaceId
  // column, since getScopedDb() already connects to this workspace's own tenant DB.
  const { metric, timeRange, groupBy, sortOrder, limit, projectId } = config;
  const { start, end } = getDateRangeFromTimeRange(timeRange);
  const truncUnit = getDateTruncUnit(groupBy);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const { db } = await getScopedDb();

  if (USE_MATERIALIZED_VIEWS) {
    const mvBaseConditions = and(
      gte(mvTimeEntriesDaily.period, sql`${startIso}::timestamp`),
      lte(mvTimeEntriesDaily.period, sql`${endIso}::timestamp`),
      projectId ? eq(mvTimeEntriesDaily.projectId, projectId) : undefined
    );

    switch (metric) {
      case 'total_hours':
      case 'hours_by_day': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvTimeEntriesDaily.period})`;
        const results = await db
          .select({
            period: periodExpr,
            hours: sql<number>`SUM(${mvTimeEntriesDaily.totalDuration}) / 60`, // Convert minutes to hours
          })
          .from(mvTimeEntriesDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, i) => ({
          label: formatDateLabel(row.period as Date, truncUnit),
          value: Math.round((Number(row.hours) || 0) * 10) / 10,
          fill: CHART_COLORS[i % CHART_COLORS.length],
        }));
      }

      case 'billable_hours': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvTimeEntriesDaily.period})`;
        const results = await db
          .select({
            period: periodExpr,
            hours: sql<number>`SUM(${mvTimeEntriesDaily.billableDuration}) / 60`,
          })
          .from(mvTimeEntriesDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, i) => ({
          label: formatDateLabel(row.period as Date, truncUnit),
          value: Math.round((Number(row.hours) || 0) * 10) / 10,
          fill: CHART_COLORS[i % CHART_COLORS.length],
        }));
      }

      case 'non_billable_hours': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvTimeEntriesDaily.period})`;
        const results = await db
          .select({
            period: periodExpr,
            hours: sql<number>`SUM(${mvTimeEntriesDaily.nonBillableDuration}) / 60`,
          })
          .from(mvTimeEntriesDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, i) => ({
          label: formatDateLabel(row.period as Date, truncUnit),
          value: Math.round((Number(row.hours) || 0) * 10) / 10,
          fill: CHART_COLORS[i % CHART_COLORS.length],
        }));
      }

      case 'utilization_rate': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvTimeEntriesDaily.period})`;
        const results = await db
          .select({
            period: periodExpr,
            billable: sql<number>`SUM(${mvTimeEntriesDaily.billableDuration})`,
            total: sql<number>`SUM(${mvTimeEntriesDaily.totalDuration})`,
          })
          .from(mvTimeEntriesDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, i) => {
          const total = Number(row.total);
          const rate = total > 0 ? Math.round((Number(row.billable) / total) * 100) : 0;
          return {
            label: formatDateLabel(row.period as Date, truncUnit),
            value: rate,
            fill: CHART_COLORS[i % CHART_COLORS.length],
          };
        });
      }

      case 'total_cost': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvTimeEntriesDaily.period})`;
        const results = await db
          .select({
            period: periodExpr,
            cost: sql<number>`SUM(${mvTimeEntriesDaily.totalCost})`,
          })
          .from(mvTimeEntriesDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, i) => ({
          label: formatDateLabel(row.period as Date, truncUnit),
          value: Math.round(Number(row.cost) || 0),
          fill: CHART_COLORS[i % CHART_COLORS.length],
        }));
      }

      default:
        return [];
    }
  }

  return [];
}

// ============ MILESTONE METRICS ============

async function getMilestoneMetrics(config: ChartQueryConfig): Promise<ChartDataPoint[]> {
  // workspaceId is not destructured here — mvMilestoneStats has no workspaceId
  // column, since getScopedDb() already connects to this workspace's own tenant DB.
  const { metric, sortOrder, limit, projectId } = config;
  const { db } = await getScopedDb();

  if (USE_MATERIALIZED_VIEWS) {
    const mvBaseConditions = projectId ? eq(mvMilestoneStats.projectId, projectId) : undefined;

    switch (metric) {
      case 'total_milestones': {
        const results = await db
          .select({
            status: mvMilestoneStats.status,
            count: sql<number>`COUNT(*)`,
          })
          .from(mvMilestoneStats)
          .where(mvBaseConditions)
          .groupBy(mvMilestoneStats.status)
          .orderBy(sortOrder === 'desc' ? desc(sql`COUNT(*)`) : asc(sql`COUNT(*)`))
          .limit(limit || 10);

        return results.map((row, i) => ({
          label: formatStatusLabel(row.status),
          value: Number(row.count) || 0,
          fill: CHART_COLORS[i % CHART_COLORS.length],
        }));
      }

      case 'milestones_by_status': {
        const results = await db
          .select({
            status: mvMilestoneStats.status,
            count: sql<number>`COUNT(*)`,
          })
          .from(mvMilestoneStats)
          .where(mvBaseConditions)
          .groupBy(mvMilestoneStats.status)
          .orderBy(sortOrder === 'desc' ? desc(sql`COUNT(*)`) : asc(sql`COUNT(*)`))
          .limit(limit || 10);

        return results.map((row, i) => ({
          label: formatStatusLabel(row.status),
          value: Number(row.count) || 0,
          fill: CHART_COLORS[i % CHART_COLORS.length],
        }));
      }

      case 'completed_milestones': {
        const completed = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(mvMilestoneStats)
          .where(and(mvBaseConditions, eq(mvMilestoneStats.status, 'completed')));

        const total = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(mvMilestoneStats)
          .where(mvBaseConditions);

        return [
          { label: 'Completed', value: Number(completed[0]?.count) || 0, fill: CHART_COLORS[0] },
          { label: 'Remaining', value: (Number(total[0]?.count) || 0) - (Number(completed[0]?.count) || 0), fill: CHART_COLORS[2] },
        ];
      }

      case 'overdue_milestones': {
        const overdue = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(mvMilestoneStats)
          .where(and(mvBaseConditions, eq(mvMilestoneStats.isOverdue, true)));

        const onTime = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(mvMilestoneStats)
          .where(and(mvBaseConditions, eq(mvMilestoneStats.isOverdue, false)));

        return [
          { label: 'Overdue', value: Number(overdue[0]?.count) || 0, fill: 'hsl(var(--destructive))' },
          { label: 'On Time', value: Number(onTime[0]?.count) || 0, fill: 'hsl(var(--chart-2))' },
        ];
      }

      case 'on_time_milestones': {
        const onTime = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(mvMilestoneStats)
          .where(and(mvBaseConditions, eq(mvMilestoneStats.isOnTime, true)));

        const late = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(mvMilestoneStats)
          .where(and(mvBaseConditions, eq(mvMilestoneStats.status, 'completed'), eq(mvMilestoneStats.isOnTime, false)));

        return [
          { label: 'On Time', value: Number(onTime[0]?.count) || 0, fill: 'hsl(var(--chart-2))' },
          { label: 'Late', value: Number(late[0]?.count) || 0, fill: 'hsl(var(--chart-3))' },
        ];
      }

      case 'avg_milestone_progress': {
        const results = await db
          .select({
            avgProgress: sql<number>`AVG(${mvMilestoneStats.progress})`,
          })
          .from(mvMilestoneStats)
          .where(mvBaseConditions);

        return [{ label: 'Average Progress', value: Math.round(Number(results[0]?.avgProgress) || 0), fill: CHART_COLORS[0] }];
      }

      default:
        return [];
    }
  }

  return [];
}

// ============ MAIN DISPATCHER ============

export async function getChartDataByConfig(config: ChartQueryConfig): Promise<ChartDataPoint[]> {
  const { entity } = config;

  switch (entity) {
    case 'projects':
      return getProjectMetrics(config);
    case 'tasks':
      return getTaskMetrics(config);
    case 'time_entries':
      return getTimeEntryMetrics(config);
    case 'milestones':
      return getMilestoneMetrics(config);
    default:
      console.warn(`Unknown entity: ${entity}`);
      return [];
  }
}
