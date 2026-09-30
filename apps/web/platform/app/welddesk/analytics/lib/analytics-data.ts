import { getScopedDb } from '@/lib/db';
import { helpdeskTickets } from '@/lib/db/schema/helpdesk-tickets';
import { helpdeskConversations } from '@/lib/db/schema/helpdesk-conversations';
import { helpdeskAgents } from '@/lib/db/schema/helpdesk-agents';
import { helpdeskSatisfactionSurveys } from '@/lib/db/schema/helpdesk-satisfaction-surveys';
import { people as contacts } from '@weldsuite/db/schema/people';
import {
  mvHelpdeskTicketsDaily,
  mvHelpdeskConversationsDaily,
  mvHelpdeskSatisfactionDaily,
  mvHelpdeskAgentStats,
} from '@/lib/db/schema/helpdesk-analytics-views';
import { and, eq, gte, lte, isNull, count, avg, sql, inArray, desc, asc, type SQL, type SQLWrapper } from 'drizzle-orm';

// Flag to use materialized views (set to false to fallback to base tables)
const USE_MATERIALIZED_VIEWS = true;

// ============ TYPES ============

export interface ChartQueryConfig {
  workspaceId: string;
  entity: string;
  metric: string;
  timeRange: string;
  groupBy: string;
  aggregation: string;
  sortOrder?: string;
  limit?: number;
}

export interface ChartDataPoint {
  label: string;
  value: number;
  fill?: string;
  [key: string]: string | number | undefined;
}

// ============ TIME RANGE HELPERS ============

export function getDateRangeFromTimeRange(timeRange: string): { start: Date; end: Date } {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  let start: Date;

  switch (timeRange) {
    case 'today':
      start = new Date(now);
      start.setHours(0, 0, 0, 0);
      break;
    case 'yesterday':
      start = new Date(now);
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() - 1);
      end.setHours(23, 59, 59, 999);
      break;
    case 'last_7_days':
      start = new Date(now);
      start.setDate(start.getDate() - 7);
      start.setHours(0, 0, 0, 0);
      break;
    case 'last_90_days':
      start = new Date(now);
      start.setDate(start.getDate() - 90);
      start.setHours(0, 0, 0, 0);
      break;
    case 'this_month':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'last_year':
      start = new Date(now);
      start.setFullYear(start.getFullYear() - 1);
      start.setHours(0, 0, 0, 0);
      break;
    case 'all_time':
      start = new Date(2020, 0, 1); // Reasonable start date
      break;
    case 'last_30_days':
    default:
      start = new Date(now);
      start.setDate(start.getDate() - 30);
      start.setHours(0, 0, 0, 0);
  }

  return { start, end };
}

// ============ GROUPING HELPERS ============

// Valid date truncation units (whitelisted to prevent SQL injection)
type TruncUnit = 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

// Returns validated date truncation unit
export function getDateTruncUnit(groupBy: string): TruncUnit {
  switch (groupBy) {
    case 'hour':
      return 'hour';
    case 'day':
      return 'day';
    case 'week':
      return 'week';
    case 'month':
      return 'month';
    case 'quarter':
      return 'quarter';
    case 'year':
      return 'year';
    default:
      return 'day';
  }
}

/**
 * `date_trunc('<unit>', column)`. The unit is embedded as a literal (not a parameter) so PostgreSQL can
 * match the SELECT and GROUP BY expressions; it is safe because TruncUnit is a whitelisted union.
 */
function dateTrunc<T = unknown>(unit: TruncUnit, column: SQLWrapper): SQL<T> {
  const quotedUnit = `'${unit}'`;
  return sql<T>`date_trunc(${sql.raw(quotedUnit)}, ${column})`;
}

// Format Date object based on groupBy type
export function formatDateLabel(date: Date | null, groupBy: string): string {
  if (!date) return '';

  try {
    const d = new Date(date);
    switch (groupBy) {
      case 'hour':
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
               d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
      case 'day':
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      case 'week': {
        // Get ISO week number
        const startOfYear = new Date(d.getFullYear(), 0, 1);
        const days = Math.floor((d.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
        const weekNum = Math.ceil((days + startOfYear.getDay() + 1) / 7);
        return `Week ${weekNum}`;
      }
      case 'month':
        return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      case 'quarter': {
        const quarter = Math.floor(d.getMonth() / 3) + 1;
        return `Q${quarter} ${d.getFullYear()}`;
      }
      case 'year':
        return d.getFullYear().toString();
      default:
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  } catch {
    return String(date);
  }
}

// Legacy format for string-based periods (kept for compatibility)
export function formatGroupLabel(value: string, groupBy: string): string {
  if (!value) return '';

  switch (groupBy) {
    case 'hour':
      try {
        const date = new Date(value);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
               date.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
      } catch {
        return value;
      }
    case 'day':
      try {
        const date = new Date(value);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      } catch {
        return value;
      }
    case 'week':
      return `Week ${value.split('-')[1]}`;
    case 'month':
      try {
        const [year, month] = value.split('-');
        const date = new Date(Number.parseInt(year), Number.parseInt(month) - 1, 1);
        return date.toLocaleDateString('en-US', { month: 'short' });
      } catch {
        return value;
      }
    case 'quarter':
      return value.split('-')[1] || value;
    case 'year':
      return value;
    default:
      return value;
  }
}

// Chart color palette
const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
];

function getChartColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length];
}

// ============ QUERY HELPERS ============

type ScopedDb = Awaited<ReturnType<typeof getScopedDb>>['db'];

interface MetricQuery {
  db: ScopedDb;
  metric: string;
  groupBy: string;
  sortOrder?: string;
  limit?: number;
  start: Date;
  end: Date;
  truncUnit: TruncUnit;
}

type AgentMetricQuery = Pick<MetricQuery, 'db' | 'metric' | 'sortOrder' | 'limit'>;

/** Picks the descending or ascending ORDER BY expression for the requested sort order. */
function pickOrder(sortOrder: string | undefined, descExpr: SQL, ascExpr: SQL): SQL {
  return sortOrder === 'desc' ? descExpr : ascExpr;
}

function limitOr(limit: number | undefined, fallback: number): number {
  return limit || fallback;
}

function toNumber(value: unknown): number {
  return Number(value) || 0;
}

function orZero(value: number | null | undefined): number {
  return value || 0;
}

function orEmpty(value: string | null | undefined): string {
  return value || '';
}

/** Rounded percentage of `part` in `total`, 0 when there is no total. */
function percentOf(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

// ============ TICKET METRICS ============

export async function getTicketMetrics(config: ChartQueryConfig): Promise<ChartDataPoint[]> {
  const { metric, timeRange, groupBy, sortOrder, limit } = config;
  const { start, end } = getDateRangeFromTimeRange(timeRange);
  const truncUnit = getDateTruncUnit(groupBy);
  const { db } = await getScopedDb();
  const query: MetricQuery = { db, metric, groupBy, sortOrder, limit, start, end, truncUnit };

  // Use materialized views for better performance
  if (USE_MATERIALIZED_VIEWS) {
    const fromViews = await getTicketMetricsFromViews(query);
    if (fromViews) return fromViews;
  }

  // Fallback to base tables if MVs not enabled or metric not covered
  return getTicketMetricsFromTables(query);
}

async function getTicketMetricsFromViews(q: MetricQuery): Promise<ChartDataPoint[] | null> {
  const { db, metric, groupBy, sortOrder, limit, start, end, truncUnit } = q;
  // Convert dates to ISO strings for proper PostgreSQL serialization
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const mvBaseConditions = and(
    gte(mvHelpdeskTicketsDaily.period, sql`${startIso}::timestamp`),
    lte(mvHelpdeskTicketsDaily.period, sql`${endIso}::timestamp`)
  );

  switch (metric) {
    case 'total_tickets':
    case 'tickets_by_day': {
      // Query MV and re-aggregate by the requested groupBy period
      // Use sql.raw for truncUnit to embed as literal (not parameter) so PostgreSQL can match SELECT/GROUP BY
      const periodExpr = dateTrunc(truncUnit, mvHelpdeskTicketsDaily.period);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, mvHelpdeskTicketsDaily.period).as('period'),
          count: sql<number>`SUM(${mvHelpdeskTicketsDaily.ticketCount})`,
        })
        .from(mvHelpdeskTicketsDaily)
        .where(mvBaseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: toNumber(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'open_tickets': {
      const openStatuses = ['new', 'open', 'pending', 'in_progress'];
      const periodExpr = dateTrunc(truncUnit, mvHelpdeskTicketsDaily.period);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, mvHelpdeskTicketsDaily.period).as('period'),
          count: sql<number>`SUM(${mvHelpdeskTicketsDaily.ticketCount})`,
        })
        .from(mvHelpdeskTicketsDaily)
        .where(and(
          mvBaseConditions,
          inArray(mvHelpdeskTicketsDaily.status, openStatuses)
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: toNumber(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'closed_tickets': {
      const closedStatuses = ['resolved', 'closed'];
      const periodExpr = dateTrunc(truncUnit, mvHelpdeskTicketsDaily.period);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, mvHelpdeskTicketsDaily.period).as('period'),
          count: sql<number>`SUM(${mvHelpdeskTicketsDaily.ticketCount})`,
        })
        .from(mvHelpdeskTicketsDaily)
        .where(and(
          mvBaseConditions,
          inArray(mvHelpdeskTicketsDaily.status, closedStatuses)
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: toNumber(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'tickets_by_status': {
      const results = await db
        .select({
          status: mvHelpdeskTicketsDaily.status,
          count: sql<number>`SUM(${mvHelpdeskTicketsDaily.ticketCount})`,
        })
        .from(mvHelpdeskTicketsDaily)
        .where(mvBaseConditions)
        .groupBy(mvHelpdeskTicketsDaily.status)
        .orderBy(pickOrder(sortOrder, desc(sql`SUM(${mvHelpdeskTicketsDaily.ticketCount})`), asc(sql`SUM(${mvHelpdeskTicketsDaily.ticketCount})`)))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: formatStatusLabel(orEmpty(row.status)),
        value: toNumber(row.count),
        fill: getChartColor(index),
        name: formatStatusLabel(orEmpty(row.status)),
      }));
    }

    case 'tickets_by_priority': {
      const results = await db
        .select({
          priority: mvHelpdeskTicketsDaily.priority,
          count: sql<number>`SUM(${mvHelpdeskTicketsDaily.ticketCount})`,
        })
        .from(mvHelpdeskTicketsDaily)
        .where(mvBaseConditions)
        .groupBy(mvHelpdeskTicketsDaily.priority)
        .orderBy(pickOrder(sortOrder, desc(sql`SUM(${mvHelpdeskTicketsDaily.ticketCount})`), asc(sql`SUM(${mvHelpdeskTicketsDaily.ticketCount})`)))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: formatPriorityLabel(orEmpty(row.priority)),
        value: toNumber(row.count),
        fill: getPriorityColor(orEmpty(row.priority), index),
        name: formatPriorityLabel(orEmpty(row.priority)),
      }));
    }

    case 'escalated_tickets': {
      const periodExpr = dateTrunc(truncUnit, mvHelpdeskTicketsDaily.period);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, mvHelpdeskTicketsDaily.period).as('period'),
          count: sql<number>`SUM(${mvHelpdeskTicketsDaily.escalatedCount})`,
        })
        .from(mvHelpdeskTicketsDaily)
        .where(mvBaseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: toNumber(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'tickets_by_channel': {
      const results = await db
        .select({
          channel: mvHelpdeskTicketsDaily.channel,
          count: sql<number>`SUM(${mvHelpdeskTicketsDaily.ticketCount})`,
        })
        .from(mvHelpdeskTicketsDaily)
        .where(mvBaseConditions)
        .groupBy(mvHelpdeskTicketsDaily.channel)
        .orderBy(pickOrder(sortOrder, desc(sql`SUM(${mvHelpdeskTicketsDaily.ticketCount})`), asc(sql`SUM(${mvHelpdeskTicketsDaily.ticketCount})`)))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: formatChannelLabel(orEmpty(row.channel)),
        value: toNumber(row.count),
        fill: getChartColor(index),
        name: formatChannelLabel(orEmpty(row.channel)),
      }));
    }

    case 'resolution_rate': {
      // Resolution rate = closed tickets / total tickets as percentage
      const periodExpr = dateTrunc(truncUnit, mvHelpdeskTicketsDaily.period);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, mvHelpdeskTicketsDaily.period).as('period'),
          closed: sql<number>`SUM(CASE WHEN ${mvHelpdeskTicketsDaily.status} IN ('resolved', 'closed') THEN ${mvHelpdeskTicketsDaily.ticketCount} ELSE 0 END)`,
          total: sql<number>`SUM(${mvHelpdeskTicketsDaily.ticketCount})`,
        })
        .from(mvHelpdeskTicketsDaily)
        .where(mvBaseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => {
        const rate = percentOf(Number(row.closed), Number(row.total));
        return {
          label: formatDateLabel(row.period, groupBy),
          value: rate,
          fill: getChartColor(index),
        };
      });
    }

    case 'avg_handling_time': {
      // Average handling time (response + resolution time)
      const periodExpr = dateTrunc(truncUnit, mvHelpdeskTicketsDaily.period);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, mvHelpdeskTicketsDaily.period).as('period'),
          avgHandling: sql<number>`
            (SUM(COALESCE(${mvHelpdeskTicketsDaily.avgResponseTime}::numeric, 0) * ${mvHelpdeskTicketsDaily.ticketCount}) +
             SUM(COALESCE(${mvHelpdeskTicketsDaily.avgResolutionTime}::numeric, 0) * ${mvHelpdeskTicketsDaily.ticketCount}))
            / NULLIF(SUM(${mvHelpdeskTicketsDaily.ticketCount}), 0)
          `,
        })
        .from(mvHelpdeskTicketsDaily)
        .where(mvBaseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Math.round(toNumber(row.avgHandling)),
        fill: getChartColor(index),
      }));
    }
  }
  return null;
}

async function getTicketMetricsFromTables(q: MetricQuery): Promise<ChartDataPoint[]> {
  const { db, metric, groupBy, sortOrder, limit, start, end, truncUnit } = q;
  // Fallback to base tables if MVs not enabled or metric not covered
  const baseConditions = and(
    isNull(helpdeskTickets.deletedAt),
    gte(helpdeskTickets.createdAt, start),
    lte(helpdeskTickets.createdAt, end)
  );

  switch (metric) {
    case 'total_tickets':
    case 'tickets_by_day': {
      const periodExpr = dateTrunc(truncUnit, helpdeskTickets.createdAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskTickets.createdAt).as('period'),
          count: count(),
        })
        .from(helpdeskTickets)
        .where(baseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Number(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'open_tickets': {
      const openStatuses = ['new', 'open', 'pending', 'in_progress'];
      const periodExpr = dateTrunc(truncUnit, helpdeskTickets.createdAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskTickets.createdAt).as('period'),
          count: count(),
        })
        .from(helpdeskTickets)
        .where(and(
          baseConditions,
          inArray(helpdeskTickets.status, openStatuses)
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Number(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'closed_tickets': {
      const closedStatuses = ['resolved', 'closed'];
      const periodExpr = dateTrunc(truncUnit, helpdeskTickets.createdAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskTickets.createdAt).as('period'),
          count: count(),
        })
        .from(helpdeskTickets)
        .where(and(
          baseConditions,
          inArray(helpdeskTickets.status, closedStatuses)
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Number(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'tickets_by_status': {
      const results = await db
        .select({
          status: helpdeskTickets.status,
          count: count(),
        })
        .from(helpdeskTickets)
        .where(baseConditions)
        .groupBy(helpdeskTickets.status)
        .orderBy(pickOrder(sortOrder, desc(count()), asc(count())))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: formatStatusLabel(row.status),
        value: Number(row.count),
        fill: getChartColor(index),
        name: formatStatusLabel(row.status),
      }));
    }

    case 'tickets_by_priority': {
      const results = await db
        .select({
          priority: helpdeskTickets.priority,
          count: count(),
        })
        .from(helpdeskTickets)
        .where(baseConditions)
        .groupBy(helpdeskTickets.priority)
        .orderBy(pickOrder(sortOrder, desc(count()), asc(count())))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: formatPriorityLabel(row.priority),
        value: Number(row.count),
        fill: getPriorityColor(row.priority, index),
        name: formatPriorityLabel(row.priority),
      }));
    }

    case 'escalated_tickets': {
      const periodExpr = dateTrunc(truncUnit, helpdeskTickets.createdAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskTickets.createdAt).as('period'),
          count: count(),
        })
        .from(helpdeskTickets)
        .where(and(
          baseConditions,
          eq(helpdeskTickets.isEscalated, true)
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Number(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'tickets_by_channel': {
      const results = await db
        .select({
          channel: helpdeskTickets.channel,
          count: count(),
        })
        .from(helpdeskTickets)
        .where(baseConditions)
        .groupBy(helpdeskTickets.channel)
        .orderBy(pickOrder(sortOrder, desc(count()), asc(count())))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: formatChannelLabel(row.channel),
        value: Number(row.count),
        fill: getChartColor(index),
        name: formatChannelLabel(row.channel),
      }));
    }

    case 'resolution_rate': {
      const periodExpr = dateTrunc(truncUnit, helpdeskTickets.createdAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskTickets.createdAt).as('period'),
          closed: sql<number>`COUNT(*) FILTER (WHERE ${helpdeskTickets.status} IN ('resolved', 'closed'))`,
          total: count(),
        })
        .from(helpdeskTickets)
        .where(baseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => {
        const rate = percentOf(Number(row.closed), Number(row.total));
        return {
          label: formatDateLabel(row.period, groupBy),
          value: rate,
          fill: getChartColor(index),
        };
      });
    }

    case 'avg_handling_time': {
      const periodExpr = dateTrunc(truncUnit, helpdeskTickets.createdAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskTickets.createdAt).as('period'),
          avgHandling: sql<number>`AVG(COALESCE(${helpdeskTickets.responseTime}, 0) + COALESCE(${helpdeskTickets.resolutionTime}, 0))`,
        })
        .from(helpdeskTickets)
        .where(baseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Math.round(toNumber(row.avgHandling)),
        fill: getChartColor(index),
      }));
    }

    default:
      return [];
  }
}

// ============ CONVERSATION METRICS ============

export async function getConversationMetrics(config: ChartQueryConfig): Promise<ChartDataPoint[]> {
  const { metric, timeRange, groupBy, sortOrder, limit } = config;
  const { start, end } = getDateRangeFromTimeRange(timeRange);
  const truncUnit = getDateTruncUnit(groupBy);
  const { db } = await getScopedDb();
  const query: MetricQuery = { db, metric, groupBy, sortOrder, limit, start, end, truncUnit };

  // Use materialized views for better performance
  if (USE_MATERIALIZED_VIEWS) {
    const fromViews = await getConversationMetricsFromViews(query);
    if (fromViews) return fromViews;
  }

  // Fallback to base tables if MVs not enabled or metric not covered
  return getConversationMetricsFromTables(query);
}

async function getConversationMetricsFromViews(q: MetricQuery): Promise<ChartDataPoint[] | null> {
  const { db, metric, groupBy, sortOrder, limit, start, end, truncUnit } = q;
  // Convert dates to ISO strings for proper PostgreSQL serialization
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const mvBaseConditions = and(
    gte(mvHelpdeskConversationsDaily.period, sql`${startIso}::timestamp`),
    lte(mvHelpdeskConversationsDaily.period, sql`${endIso}::timestamp`)
  );

  switch (metric) {
    case 'total_conversations':
    case 'conversations_by_day': {
      const periodExpr = dateTrunc(truncUnit, mvHelpdeskConversationsDaily.period);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, mvHelpdeskConversationsDaily.period).as('period'),
          count: sql<number>`SUM(${mvHelpdeskConversationsDaily.conversationCount})`,
        })
        .from(mvHelpdeskConversationsDaily)
        .where(mvBaseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: toNumber(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'active_conversations': {
      const periodExpr = dateTrunc(truncUnit, mvHelpdeskConversationsDaily.period);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, mvHelpdeskConversationsDaily.period).as('period'),
          count: sql<number>`SUM(${mvHelpdeskConversationsDaily.conversationCount})`,
        })
        .from(mvHelpdeskConversationsDaily)
        .where(and(
          mvBaseConditions,
          eq(mvHelpdeskConversationsDaily.status, 'active')
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: toNumber(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'conversations_by_channel': {
      const results = await db
        .select({
          channel: mvHelpdeskConversationsDaily.channel,
          count: sql<number>`SUM(${mvHelpdeskConversationsDaily.conversationCount})`,
        })
        .from(mvHelpdeskConversationsDaily)
        .where(mvBaseConditions)
        .groupBy(mvHelpdeskConversationsDaily.channel)
        .orderBy(pickOrder(sortOrder, desc(sql`SUM(${mvHelpdeskConversationsDaily.conversationCount})`), asc(sql`SUM(${mvHelpdeskConversationsDaily.conversationCount})`)))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: formatChannelLabel(orEmpty(row.channel)),
        value: toNumber(row.count),
        fill: getChartColor(index),
        name: formatChannelLabel(orEmpty(row.channel)),
      }));
    }

    case 'avg_messages': {
      // Weighted average across periods
      const periodExpr = dateTrunc(truncUnit, mvHelpdeskConversationsDaily.period);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, mvHelpdeskConversationsDaily.period).as('period'),
          avg: sql<number>`SUM(${mvHelpdeskConversationsDaily.avgMessages}::numeric * ${mvHelpdeskConversationsDaily.conversationCount}) / NULLIF(SUM(${mvHelpdeskConversationsDaily.conversationCount}), 0)`,
        })
        .from(mvHelpdeskConversationsDaily)
        .where(mvBaseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Math.round(toNumber(row.avg) * 10) / 10,
        fill: getChartColor(index),
      }));
    }

    case 'conversations_by_status': {
      const results = await db
        .select({
          status: mvHelpdeskConversationsDaily.status,
          count: sql<number>`SUM(${mvHelpdeskConversationsDaily.conversationCount})`,
        })
        .from(mvHelpdeskConversationsDaily)
        .where(mvBaseConditions)
        .groupBy(mvHelpdeskConversationsDaily.status)
        .orderBy(pickOrder(sortOrder, desc(sql`SUM(${mvHelpdeskConversationsDaily.conversationCount})`), asc(sql`SUM(${mvHelpdeskConversationsDaily.conversationCount})`)))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: formatConversationStatusLabel(orEmpty(row.status)),
        value: toNumber(row.count),
        fill: getChartColor(index),
        name: formatConversationStatusLabel(orEmpty(row.status)),
      }));
    }

    case 'closed_conversations': {
      const periodExpr = dateTrunc(truncUnit, mvHelpdeskConversationsDaily.period);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, mvHelpdeskConversationsDaily.period).as('period'),
          count: sql<number>`SUM(${mvHelpdeskConversationsDaily.conversationCount})`,
        })
        .from(mvHelpdeskConversationsDaily)
        .where(and(
          mvBaseConditions,
          eq(mvHelpdeskConversationsDaily.status, 'closed')
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: toNumber(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'conversation_resolution_rate': {
      // Resolution rate = closed conversations / total conversations as percentage
      const periodExpr = dateTrunc(truncUnit, mvHelpdeskConversationsDaily.period);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, mvHelpdeskConversationsDaily.period).as('period'),
          closed: sql<number>`SUM(CASE WHEN ${mvHelpdeskConversationsDaily.status} = 'closed' THEN ${mvHelpdeskConversationsDaily.conversationCount} ELSE 0 END)`,
          total: sql<number>`SUM(${mvHelpdeskConversationsDaily.conversationCount})`,
        })
        .from(mvHelpdeskConversationsDaily)
        .where(mvBaseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => {
        const rate = percentOf(Number(row.closed), Number(row.total));
        return {
          label: formatDateLabel(row.period, groupBy),
          value: rate,
          fill: getChartColor(index),
        };
      });
    }
  }
  return null;
}

async function getConversationMetricsFromTables(q: MetricQuery): Promise<ChartDataPoint[]> {
  const { db, metric, groupBy, sortOrder, limit, start, end, truncUnit } = q;
  // Fallback to base tables
  const baseConditions = and(
    isNull(helpdeskConversations.deletedAt),
    gte(helpdeskConversations.createdAt, start),
    lte(helpdeskConversations.createdAt, end)
  );

  switch (metric) {
    case 'total_conversations':
    case 'conversations_by_day': {
      const periodExpr = dateTrunc(truncUnit, helpdeskConversations.createdAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskConversations.createdAt).as('period'),
          count: count(),
        })
        .from(helpdeskConversations)
        .where(baseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Number(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'active_conversations': {
      const periodExpr = dateTrunc(truncUnit, helpdeskConversations.createdAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskConversations.createdAt).as('period'),
          count: count(),
        })
        .from(helpdeskConversations)
        .where(and(
          baseConditions,
          eq(helpdeskConversations.status, 'active')
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Number(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'conversations_by_channel': {
      const results = await db
        .select({
          channel: helpdeskConversations.channel,
          count: count(),
        })
        .from(helpdeskConversations)
        .where(baseConditions)
        .groupBy(helpdeskConversations.channel)
        .orderBy(pickOrder(sortOrder, desc(count()), asc(count())))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: formatChannelLabel(row.channel),
        value: Number(row.count),
        fill: getChartColor(index),
        name: formatChannelLabel(row.channel),
      }));
    }

    case 'avg_messages': {
      const periodExpr = dateTrunc(truncUnit, helpdeskConversations.createdAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskConversations.createdAt).as('period'),
          avg: avg(helpdeskConversations.messageCount),
        })
        .from(helpdeskConversations)
        .where(baseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Math.round(Number(row.avg) * 10) / 10,
        fill: getChartColor(index),
      }));
    }

    case 'conversations_by_status': {
      const results = await db
        .select({
          status: helpdeskConversations.status,
          count: count(),
        })
        .from(helpdeskConversations)
        .where(baseConditions)
        .groupBy(helpdeskConversations.status)
        .orderBy(pickOrder(sortOrder, desc(count()), asc(count())))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: formatConversationStatusLabel(row.status),
        value: Number(row.count),
        fill: getChartColor(index),
        name: formatConversationStatusLabel(row.status),
      }));
    }

    case 'closed_conversations': {
      const periodExpr = dateTrunc(truncUnit, helpdeskConversations.createdAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskConversations.createdAt).as('period'),
          count: count(),
        })
        .from(helpdeskConversations)
        .where(and(
          baseConditions,
          eq(helpdeskConversations.status, 'closed')
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Number(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'conversation_resolution_rate': {
      const periodExpr = dateTrunc(truncUnit, helpdeskConversations.createdAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskConversations.createdAt).as('period'),
          closed: sql<number>`COUNT(*) FILTER (WHERE ${helpdeskConversations.status} = 'closed')`,
          total: count(),
        })
        .from(helpdeskConversations)
        .where(baseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => {
        const rate = percentOf(Number(row.closed), Number(row.total));
        return {
          label: formatDateLabel(row.period, groupBy),
          value: rate,
          fill: getChartColor(index),
        };
      });
    }

    default:
      return [];
  }
}

// ============ AGENT METRICS ============

export async function getAgentMetrics(config: ChartQueryConfig): Promise<ChartDataPoint[]> {
  const { metric, sortOrder, limit } = config;
  const { db } = await getScopedDb();
  const query: AgentMetricQuery = { db, metric, sortOrder, limit };

  // Use materialized views for better performance
  if (USE_MATERIALIZED_VIEWS) {
    const fromViews = await getAgentMetricsFromViews(query);
    if (fromViews) return fromViews;
  }

  // Fallback to base tables
  return getAgentMetricsFromTables(query);
}

async function getAgentMetricsFromViews(q: AgentMetricQuery): Promise<ChartDataPoint[] | null> {
  const { db, metric, sortOrder, limit } = q;
  switch (metric) {
    case 'total_agents':
    case 'active_agents': {
      const additionalCondition = metric === 'active_agents'
        ? eq(mvHelpdeskAgentStats.status, 'active')
        : undefined;

      const results = await db
        .select({
          name: mvHelpdeskAgentStats.name,
          ticketsResolved: mvHelpdeskAgentStats.ticketsResolved,
        })
        .from(mvHelpdeskAgentStats)
        .where(additionalCondition)
        .orderBy(pickOrder(sortOrder, sql`${mvHelpdeskAgentStats.ticketsResolved} DESC NULLS LAST`, sql`${mvHelpdeskAgentStats.ticketsResolved} ASC NULLS LAST`))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: row.name,
        value: orZero(row.ticketsResolved),
        fill: getChartColor(index),
        name: row.name,
      }));
    }

    case 'tickets_per_agent':
    case 'agent_performance': {
      const results = await db
        .select({
          name: mvHelpdeskAgentStats.name,
          ticketsResolved: mvHelpdeskAgentStats.ticketsResolved,
          ticketsAssigned: mvHelpdeskAgentStats.ticketsAssigned,
        })
        .from(mvHelpdeskAgentStats)
        .orderBy(pickOrder(sortOrder, sql`${mvHelpdeskAgentStats.ticketsResolved} DESC NULLS LAST`, sql`${mvHelpdeskAgentStats.ticketsResolved} ASC NULLS LAST`))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: row.name,
        value: orZero(row.ticketsResolved),
        fill: getChartColor(index),
        name: row.name,
        assigned: orZero(row.ticketsAssigned),
      }));
    }

    case 'agent_response_time': {
      const results = await db
        .select({
          name: mvHelpdeskAgentStats.name,
          avgResponseTime: mvHelpdeskAgentStats.averageResponseTime,
        })
        .from(mvHelpdeskAgentStats)
        .orderBy(pickOrder(sortOrder, sql`${mvHelpdeskAgentStats.averageResponseTime} DESC NULLS LAST`, sql`${mvHelpdeskAgentStats.averageResponseTime} ASC NULLS LAST`))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: row.name,
        value: orZero(row.avgResponseTime),
        fill: getChartColor(index),
        name: row.name,
      }));
    }
  }
  return null;
}

async function getAgentMetricsFromTables(q: AgentMetricQuery): Promise<ChartDataPoint[]> {
  const { db, metric, sortOrder, limit } = q;
  // Fallback to base tables
  const baseConditions = isNull(helpdeskAgents.deletedAt);

  switch (metric) {
    case 'total_agents':
    case 'active_agents': {
      const additionalCondition = metric === 'active_agents'
        ? eq(helpdeskAgents.status, 'active')
        : undefined;

      const results = await db
        .select({
          name: helpdeskAgents.name,
          ticketsResolved: helpdeskAgents.ticketsResolved,
        })
        .from(helpdeskAgents)
        .where(additionalCondition ? and(baseConditions, additionalCondition) : baseConditions)
        .orderBy(pickOrder(sortOrder, sql`${helpdeskAgents.ticketsResolved} DESC NULLS LAST`, sql`${helpdeskAgents.ticketsResolved} ASC NULLS LAST`))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: row.name,
        value: orZero(row.ticketsResolved),
        fill: getChartColor(index),
        name: row.name,
      }));
    }

    case 'tickets_per_agent':
    case 'agent_performance': {
      const results = await db
        .select({
          name: helpdeskAgents.name,
          ticketsResolved: helpdeskAgents.ticketsResolved,
          ticketsAssigned: helpdeskAgents.ticketsAssigned,
        })
        .from(helpdeskAgents)
        .where(baseConditions)
        .orderBy(pickOrder(sortOrder, sql`${helpdeskAgents.ticketsResolved} DESC NULLS LAST`, sql`${helpdeskAgents.ticketsResolved} ASC NULLS LAST`))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: row.name,
        value: orZero(row.ticketsResolved),
        fill: getChartColor(index),
        name: row.name,
        assigned: orZero(row.ticketsAssigned),
      }));
    }

    case 'agent_response_time': {
      const results = await db
        .select({
          name: helpdeskAgents.name,
          avgResponseTime: helpdeskAgents.averageResponseTime,
        })
        .from(helpdeskAgents)
        .where(baseConditions)
        .orderBy(pickOrder(sortOrder, sql`${helpdeskAgents.averageResponseTime} DESC NULLS LAST`, sql`${helpdeskAgents.averageResponseTime} ASC NULLS LAST`))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: row.name,
        value: orZero(row.avgResponseTime),
        fill: getChartColor(index),
        name: row.name,
      }));
    }

    default:
      return [];
  }
}

// ============ RESPONSE TIME METRICS ============

export async function getResponseTimeMetrics(config: ChartQueryConfig): Promise<ChartDataPoint[]> {
  const { metric, timeRange, groupBy, sortOrder, limit } = config;
  const { start, end } = getDateRangeFromTimeRange(timeRange);
  const truncUnit = getDateTruncUnit(groupBy);
  const { db } = await getScopedDb();
  const query: MetricQuery = { db, metric, groupBy, sortOrder, limit, start, end, truncUnit };

  // Use materialized views for better performance
  if (USE_MATERIALIZED_VIEWS) {
    const fromViews = await getResponseTimeMetricsFromViews(query);
    if (fromViews) return fromViews;
  }

  // Fallback to base tables if MVs not enabled or metric not covered
  return getResponseTimeMetricsFromTables(query);
}

async function getResponseTimeMetricsFromViews(q: MetricQuery): Promise<ChartDataPoint[] | null> {
  const { db, metric, groupBy, sortOrder, limit, start, end, truncUnit } = q;
  // Convert dates to ISO strings for proper PostgreSQL serialization
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const mvBaseConditions = and(
    gte(mvHelpdeskTicketsDaily.period, sql`${startIso}::timestamp`),
    lte(mvHelpdeskTicketsDaily.period, sql`${endIso}::timestamp`)
  );

  switch (metric) {
    case 'avg_first_response':
    case 'response_time_trend': {
      // Weighted average across daily aggregations
      const periodExpr = dateTrunc(truncUnit, mvHelpdeskTicketsDaily.period);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, mvHelpdeskTicketsDaily.period).as('period'),
          avg: sql<number>`SUM(${mvHelpdeskTicketsDaily.avgResponseTime}::numeric * ${mvHelpdeskTicketsDaily.ticketCount}) / NULLIF(SUM(${mvHelpdeskTicketsDaily.ticketCount}), 0)`,
        })
        .from(mvHelpdeskTicketsDaily)
        .where(and(
          mvBaseConditions,
          sql`${mvHelpdeskTicketsDaily.avgResponseTime} IS NOT NULL`
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Math.round(toNumber(row.avg)),
        fill: getChartColor(index),
      }));
    }

    case 'avg_resolution_time': {
      // Weighted average across daily aggregations
      const periodExpr = dateTrunc(truncUnit, mvHelpdeskTicketsDaily.period);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, mvHelpdeskTicketsDaily.period).as('period'),
          avg: sql<number>`SUM(${mvHelpdeskTicketsDaily.avgResolutionTime}::numeric * ${mvHelpdeskTicketsDaily.ticketCount}) / NULLIF(SUM(${mvHelpdeskTicketsDaily.ticketCount}), 0)`,
        })
        .from(mvHelpdeskTicketsDaily)
        .where(and(
          mvBaseConditions,
          sql`${mvHelpdeskTicketsDaily.avgResolutionTime} IS NOT NULL`
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Math.round(toNumber(row.avg)),
        fill: getChartColor(index),
      }));
    }

    case 'response_by_priority': {
      // Weighted average by priority
      const results = await db
        .select({
          priority: mvHelpdeskTicketsDaily.priority,
          avg: sql<number>`SUM(${mvHelpdeskTicketsDaily.avgResponseTime}::numeric * ${mvHelpdeskTicketsDaily.ticketCount}) / NULLIF(SUM(${mvHelpdeskTicketsDaily.ticketCount}), 0)`,
        })
        .from(mvHelpdeskTicketsDaily)
        .where(and(
          mvBaseConditions,
          sql`${mvHelpdeskTicketsDaily.avgResponseTime} IS NOT NULL`
        ))
        .groupBy(mvHelpdeskTicketsDaily.priority)
        .orderBy(pickOrder(sortOrder, sql`SUM(${mvHelpdeskTicketsDaily.avgResponseTime}::numeric * ${mvHelpdeskTicketsDaily.ticketCount}) / NULLIF(SUM(${mvHelpdeskTicketsDaily.ticketCount}), 0) DESC NULLS LAST`, sql`SUM(${mvHelpdeskTicketsDaily.avgResponseTime}::numeric * ${mvHelpdeskTicketsDaily.ticketCount}) / NULLIF(SUM(${mvHelpdeskTicketsDaily.ticketCount}), 0) ASC NULLS LAST`))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: formatPriorityLabel(orEmpty(row.priority)),
        value: Math.round(toNumber(row.avg)),
        fill: getPriorityColor(orEmpty(row.priority), index),
        name: formatPriorityLabel(orEmpty(row.priority)),
      }));
    }

    // sla_compliance not in MV - fall through to base tables
  }
  return null;
}

async function getResponseTimeMetricsFromTables(q: MetricQuery): Promise<ChartDataPoint[]> {
  const { db, metric, groupBy, sortOrder, limit, start, end, truncUnit } = q;
  // Fallback to base tables
  const baseConditions = and(
    isNull(helpdeskTickets.deletedAt),
    gte(helpdeskTickets.createdAt, start),
    lte(helpdeskTickets.createdAt, end)
  );

  switch (metric) {
    case 'avg_first_response':
    case 'response_time_trend': {
      const periodExpr = dateTrunc(truncUnit, helpdeskTickets.createdAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskTickets.createdAt).as('period'),
          avg: avg(helpdeskTickets.responseTime),
        })
        .from(helpdeskTickets)
        .where(and(
          baseConditions,
          sql`${helpdeskTickets.responseTime} IS NOT NULL`
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Math.round(toNumber(row.avg)),
        fill: getChartColor(index),
      }));
    }

    case 'avg_resolution_time': {
      const periodExpr = dateTrunc(truncUnit, helpdeskTickets.createdAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskTickets.createdAt).as('period'),
          avg: avg(helpdeskTickets.resolutionTime),
        })
        .from(helpdeskTickets)
        .where(and(
          baseConditions,
          sql`${helpdeskTickets.resolutionTime} IS NOT NULL`
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Math.round(toNumber(row.avg)),
        fill: getChartColor(index),
      }));
    }

    case 'sla_compliance': {
      const periodExpr = dateTrunc(truncUnit, helpdeskTickets.createdAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskTickets.createdAt).as('period'),
          achieved: sql<number>`COUNT(*) FILTER (WHERE ${helpdeskTickets.slaStatus} = 'achieved')`,
          total: count(),
        })
        .from(helpdeskTickets)
        .where(and(
          baseConditions,
          sql`${helpdeskTickets.slaStatus} IS NOT NULL`
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: percentOf(Number(row.achieved), Number(row.total)),
        fill: getChartColor(index),
      }));
    }

    case 'response_by_priority': {
      const results = await db
        .select({
          priority: helpdeskTickets.priority,
          avg: avg(helpdeskTickets.responseTime),
        })
        .from(helpdeskTickets)
        .where(and(
          baseConditions,
          sql`${helpdeskTickets.responseTime} IS NOT NULL`
        ))
        .groupBy(helpdeskTickets.priority)
        .orderBy(pickOrder(sortOrder, sql`avg(${helpdeskTickets.responseTime}) DESC`, sql`avg(${helpdeskTickets.responseTime}) ASC`))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: formatPriorityLabel(row.priority),
        value: Math.round(toNumber(row.avg)),
        fill: getPriorityColor(row.priority, index),
        name: formatPriorityLabel(row.priority),
      }));
    }

    default:
      return [];
  }
}

// ============ SATISFACTION METRICS ============

export async function getSatisfactionMetrics(config: ChartQueryConfig): Promise<ChartDataPoint[]> {
  const { metric, timeRange, groupBy, sortOrder, limit } = config;
  const { start, end } = getDateRangeFromTimeRange(timeRange);
  const truncUnit = getDateTruncUnit(groupBy);
  const { db } = await getScopedDb();
  const query: MetricQuery = { db, metric, groupBy, sortOrder, limit, start, end, truncUnit };

  // Use materialized views for better performance
  if (USE_MATERIALIZED_VIEWS) {
    const fromViews = await getSatisfactionMetricsFromViews(query);
    if (fromViews) return fromViews;
  }

  // Fallback to base tables if MVs not enabled or metric not covered
  return getSatisfactionMetricsFromTables(query);
}

async function getSatisfactionMetricsFromViews(q: MetricQuery): Promise<ChartDataPoint[] | null> {
  const { db, metric, groupBy, sortOrder, limit, start, end, truncUnit } = q;
  // Convert dates to ISO strings for proper PostgreSQL serialization
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const mvBaseConditions = and(
    gte(mvHelpdeskSatisfactionDaily.period, sql`${startIso}::timestamp`),
    lte(mvHelpdeskSatisfactionDaily.period, sql`${endIso}::timestamp`)
  );

  switch (metric) {
    case 'csat_score':
    case 'satisfaction_trend': {
      // Weighted average across daily aggregations
      const periodExpr = dateTrunc(truncUnit, mvHelpdeskSatisfactionDaily.period);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, mvHelpdeskSatisfactionDaily.period).as('period'),
          avg: sql<number>`SUM(${mvHelpdeskSatisfactionDaily.avgRating}::numeric * ${mvHelpdeskSatisfactionDaily.completedCount}) / NULLIF(SUM(${mvHelpdeskSatisfactionDaily.completedCount}), 0)`,
        })
        .from(mvHelpdeskSatisfactionDaily)
        .where(and(
          mvBaseConditions,
          sql`${mvHelpdeskSatisfactionDaily.avgRating} IS NOT NULL`
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Math.round(toNumber(row.avg) * 10) / 10,
        fill: getChartColor(index),
      }));
    }

    case 'nps_score': {
      // NPS = % Promoters - % Detractors (already pre-computed in MV)
      const periodExpr = dateTrunc(truncUnit, mvHelpdeskSatisfactionDaily.period);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, mvHelpdeskSatisfactionDaily.period).as('period'),
          promoters: sql<number>`SUM(${mvHelpdeskSatisfactionDaily.promoters})`,
          detractors: sql<number>`SUM(${mvHelpdeskSatisfactionDaily.detractors})`,
          total: sql<number>`SUM(${mvHelpdeskSatisfactionDaily.completedCount})`,
        })
        .from(mvHelpdeskSatisfactionDaily)
        .where(mvBaseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => {
        const nps = percentOf(Number(row.promoters) - Number(row.detractors), Number(row.total));
        return {
          label: formatDateLabel(row.period, groupBy),
          value: nps,
          fill: getChartColor(index),
        };
      });
    }

    case 'survey_response_rate': {
      // Response rate = completed surveys / total surveys sent as percentage
      const periodExpr = dateTrunc(truncUnit, mvHelpdeskSatisfactionDaily.period);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, mvHelpdeskSatisfactionDaily.period).as('period'),
          completed: sql<number>`SUM(${mvHelpdeskSatisfactionDaily.completedCount})`,
          total: sql<number>`SUM(${mvHelpdeskSatisfactionDaily.surveyCount})`,
        })
        .from(mvHelpdeskSatisfactionDaily)
        .where(mvBaseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => {
        const rate = percentOf(Number(row.completed), Number(row.total));
        return {
          label: formatDateLabel(row.period, groupBy),
          value: rate,
          fill: getChartColor(index),
        };
      });
    }

    case 'total_surveys': {
      const periodExpr = dateTrunc(truncUnit, mvHelpdeskSatisfactionDaily.period);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, mvHelpdeskSatisfactionDaily.period).as('period'),
          count: sql<number>`SUM(${mvHelpdeskSatisfactionDaily.surveyCount})`,
        })
        .from(mvHelpdeskSatisfactionDaily)
        .where(mvBaseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: toNumber(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'completed_surveys': {
      const periodExpr = dateTrunc(truncUnit, mvHelpdeskSatisfactionDaily.period);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, mvHelpdeskSatisfactionDaily.period).as('period'),
          count: sql<number>`SUM(${mvHelpdeskSatisfactionDaily.completedCount})`,
        })
        .from(mvHelpdeskSatisfactionDaily)
        .where(mvBaseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: toNumber(row.count),
        fill: getChartColor(index),
      }));
    }

    // ratings_distribution and satisfaction_by_agent require base tables
    // (not aggregatable from daily MVs)
  }
  return null;
}

async function getSatisfactionMetricsFromTables(q: MetricQuery): Promise<ChartDataPoint[]> {
  const { db, metric, groupBy, sortOrder, limit, start, end, truncUnit } = q;
  // Fallback to base tables
  const baseConditions = and(
    isNull(helpdeskSatisfactionSurveys.deletedAt),
    gte(helpdeskSatisfactionSurveys.sentAt, start),
    lte(helpdeskSatisfactionSurveys.sentAt, end)
  );

  switch (metric) {
    case 'csat_score':
    case 'satisfaction_trend': {
      const periodExpr = dateTrunc(truncUnit, helpdeskSatisfactionSurveys.sentAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskSatisfactionSurveys.sentAt).as('period'),
          avg: avg(helpdeskSatisfactionSurveys.rating),
        })
        .from(helpdeskSatisfactionSurveys)
        .where(and(
          baseConditions,
          eq(helpdeskSatisfactionSurveys.status, 'completed'),
          sql`${helpdeskSatisfactionSurveys.rating} IS NOT NULL`
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Math.round(toNumber(row.avg) * 10) / 10,
        fill: getChartColor(index),
      }));
    }

    case 'nps_score': {
      // NPS = % Promoters (9-10) - % Detractors (0-6)
      const periodExpr = dateTrunc(truncUnit, helpdeskSatisfactionSurveys.sentAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskSatisfactionSurveys.sentAt).as('period'),
          promoters: sql<number>`COUNT(*) FILTER (WHERE ${helpdeskSatisfactionSurveys.rating} >= 9)`,
          detractors: sql<number>`COUNT(*) FILTER (WHERE ${helpdeskSatisfactionSurveys.rating} <= 6)`,
          total: count(),
        })
        .from(helpdeskSatisfactionSurveys)
        .where(and(
          baseConditions,
          eq(helpdeskSatisfactionSurveys.status, 'completed'),
          sql`${helpdeskSatisfactionSurveys.rating} IS NOT NULL`
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => {
        const nps = percentOf(Number(row.promoters) - Number(row.detractors), Number(row.total));
        return {
          label: formatDateLabel(row.period, groupBy),
          value: nps,
          fill: getChartColor(index),
        };
      });
    }

    case 'ratings_distribution': {
      const results = await db
        .select({
          rating: helpdeskSatisfactionSurveys.rating,
          count: count(),
        })
        .from(helpdeskSatisfactionSurveys)
        .where(and(
          baseConditions,
          eq(helpdeskSatisfactionSurveys.status, 'completed'),
          sql`${helpdeskSatisfactionSurveys.rating} IS NOT NULL`
        ))
        .groupBy(helpdeskSatisfactionSurveys.rating)
        .orderBy(pickOrder(sortOrder, desc(count()), asc(helpdeskSatisfactionSurveys.rating)))
        .limit(limitOr(limit, 10));

      return results.map((row) => ({
        label: `${row.rating} Star${row.rating !== 1 ? 's' : ''}`,
        value: Number(row.count),
        fill: getRatingColor(orZero(row.rating)),
        name: `${row.rating} Star${row.rating !== 1 ? 's' : ''}`,
      }));
    }

    case 'satisfaction_by_agent': {
      // Join with tickets to get agent satisfaction
      const results = await db
        .select({
          agentName: helpdeskTickets.assigneeName,
          avg: avg(helpdeskSatisfactionSurveys.rating),
        })
        .from(helpdeskSatisfactionSurveys)
        .innerJoin(helpdeskTickets, eq(helpdeskSatisfactionSurveys.ticketId, helpdeskTickets.id))
        .where(and(
          isNull(helpdeskSatisfactionSurveys.deletedAt),
          eq(helpdeskSatisfactionSurveys.status, 'completed'),
          sql`${helpdeskSatisfactionSurveys.rating} IS NOT NULL`,
          sql`${helpdeskTickets.assigneeName} IS NOT NULL`
        ))
        .groupBy(helpdeskTickets.assigneeName)
        .orderBy(pickOrder(sortOrder, sql`avg(${helpdeskSatisfactionSurveys.rating}) DESC`, sql`avg(${helpdeskSatisfactionSurveys.rating}) ASC`))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: row.agentName || 'Unknown',
        value: Math.round(toNumber(row.avg) * 10) / 10,
        fill: getChartColor(index),
        name: row.agentName || 'Unknown',
      }));
    }

    case 'survey_response_rate': {
      const periodExpr = dateTrunc(truncUnit, helpdeskSatisfactionSurveys.sentAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskSatisfactionSurveys.sentAt).as('period'),
          completed: sql<number>`COUNT(*) FILTER (WHERE ${helpdeskSatisfactionSurveys.status} = 'completed')`,
          total: count(),
        })
        .from(helpdeskSatisfactionSurveys)
        .where(baseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => {
        const rate = percentOf(Number(row.completed), Number(row.total));
        return {
          label: formatDateLabel(row.period, groupBy),
          value: rate,
          fill: getChartColor(index),
        };
      });
    }

    case 'total_surveys': {
      const periodExpr = dateTrunc(truncUnit, helpdeskSatisfactionSurveys.sentAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskSatisfactionSurveys.sentAt).as('period'),
          count: count(),
        })
        .from(helpdeskSatisfactionSurveys)
        .where(baseConditions)
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Number(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'completed_surveys': {
      const periodExpr = dateTrunc(truncUnit, helpdeskSatisfactionSurveys.sentAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskSatisfactionSurveys.sentAt).as('period'),
          count: count(),
        })
        .from(helpdeskSatisfactionSurveys)
        .where(and(
          baseConditions,
          eq(helpdeskSatisfactionSurveys.status, 'completed')
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Number(row.count),
        fill: getChartColor(index),
      }));
    }

    default:
      return [];
  }
}

// ============ CUSTOMER METRICS ============

export async function getCustomerMetrics(config: ChartQueryConfig): Promise<ChartDataPoint[]> {
  const { metric, timeRange, groupBy, sortOrder, limit } = config;
  const { start, end } = getDateRangeFromTimeRange(timeRange);
  const truncUnit = getDateTruncUnit(groupBy);
  const { db } = await getScopedDb();

  switch (metric) {
    case 'total_customers':
    case 'new_customers': {
      const periodExpr = dateTrunc(truncUnit, contacts.createdAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, contacts.createdAt).as('period'),
          count: count(),
        })
        .from(contacts)
        .where(and(
          isNull(contacts.deletedAt),
          gte(contacts.createdAt, start),
          lte(contacts.createdAt, end)
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Number(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'returning_customers': {
      // Customers with more than 1 ticket
      const periodExpr = dateTrunc(truncUnit, helpdeskTickets.createdAt);
      const results = await db
        .select({
          period: dateTrunc<Date>(truncUnit, helpdeskTickets.createdAt).as('period'),
          count: sql<number>`COUNT(DISTINCT ${helpdeskTickets.customerEmail})`,
        })
        .from(helpdeskTickets)
        .where(and(
          isNull(helpdeskTickets.deletedAt),
          gte(helpdeskTickets.createdAt, start),
          lte(helpdeskTickets.createdAt, end),
          sql`${helpdeskTickets.customerEmail} IN (
            SELECT customer_email FROM helpdesk_tickets
            GROUP BY customer_email
            HAVING COUNT(*) > 1
          )`
        ))
        .groupBy(periodExpr)
        .orderBy(pickOrder(sortOrder, desc(periodExpr), asc(periodExpr)))
        .limit(limitOr(limit, 100));

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Number(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'customers_by_tickets':
    case 'top_customers': {
      const results = await db
        .select({
          email: helpdeskTickets.customerEmail,
          name: helpdeskTickets.customerName,
          count: count(),
        })
        .from(helpdeskTickets)
        .where(and(
          isNull(helpdeskTickets.deletedAt),
          gte(helpdeskTickets.createdAt, start),
          lte(helpdeskTickets.createdAt, end)
        ))
        .groupBy(helpdeskTickets.customerEmail, helpdeskTickets.customerName)
        .orderBy(desc(count()))
        .limit(limitOr(limit, 10));

      return results.map((row, index) => ({
        label: row.name || row.email,
        value: Number(row.count),
        fill: getChartColor(index),
        name: row.name || row.email,
      }));
    }

    default:
      return [];
  }
}

// ============ MAIN DISPATCHER ============

export async function getChartDataByConfig(config: ChartQueryConfig): Promise<ChartDataPoint[]> {
  switch (config.entity) {
    case 'tickets':
      return getTicketMetrics(config);
    case 'conversations':
      return getConversationMetrics(config);
    case 'agents':
      return getAgentMetrics(config);
    case 'response_time':
      return getResponseTimeMetrics(config);
    case 'satisfaction':
      return getSatisfactionMetrics(config);
    case 'customers':
      return getCustomerMetrics(config);
    default:
      return [];
  }
}

// ============ LABEL FORMATTERS ============

function formatStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    new: 'New',
    open: 'Open',
    pending: 'Pending',
    on_hold: 'On Hold',
    in_progress: 'In Progress',
    resolved: 'Resolved',
    closed: 'Closed',
    cancelled: 'Cancelled',
  };
  return labels[status] || status;
}

function formatPriorityLabel(priority: string): string {
  const labels: Record<string, string> = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    urgent: 'Urgent',
    critical: 'Critical',
  };
  return labels[priority] || priority;
}

function formatChannelLabel(channel: string): string {
  const labels: Record<string, string> = {
    email: 'Email',
    web: 'Web',
    phone: 'Phone',
    chat: 'Chat',
    social_media: 'Social Media',
    api: 'API',
    mobile: 'Mobile',
  };
  return labels[channel] || channel;
}

function formatConversationStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    active: 'Active',
    pending: 'Pending',
    closed: 'Closed',
    archived: 'Archived',
    snoozed: 'Snoozed',
  };
  return labels[status] || status;
}

function getPriorityColor(priority: string, fallbackIndex: number): string {
  const colors: Record<string, string> = {
    low: 'var(--chart-4)',
    medium: 'var(--chart-3)',
    high: 'var(--chart-2)',
    urgent: 'var(--chart-1)',
    critical: 'var(--chart-5)',
  };
  return colors[priority] || getChartColor(fallbackIndex);
}

function getRatingColor(rating: number): string {
  if (rating >= 4) return 'var(--chart-3)'; // Green for good
  if (rating >= 3) return 'var(--chart-4)'; // Yellow for neutral
  return 'var(--chart-1)'; // Red for bad
}
