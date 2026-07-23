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
import { and, eq, gte, lte, isNull, count, avg, sql, inArray, desc, asc, sum } from 'drizzle-orm';

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
    case 'last_30_days':
      start = new Date(now);
      start.setDate(start.getDate() - 30);
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
    default:
      start = new Date(now);
      start.setDate(start.getDate() - 30);
      start.setHours(0, 0, 0, 0);
  }

  return { start, end };
}

// ============ GROUPING HELPERS ============

// Valid date truncation units (whitelisted to prevent SQL injection)
const VALID_TRUNC_UNITS = ['hour', 'day', 'week', 'month', 'quarter', 'year'] as const;
type TruncUnit = (typeof VALID_TRUNC_UNITS)[number];

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
      case 'week':
        // Get ISO week number
        const startOfYear = new Date(d.getFullYear(), 0, 1);
        const days = Math.floor((d.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
        const weekNum = Math.ceil((days + startOfYear.getDay() + 1) / 7);
        return `Week ${weekNum}`;
      case 'month':
        return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      case 'quarter':
        const quarter = Math.floor(d.getMonth() / 3) + 1;
        return `Q${quarter} ${d.getFullYear()}`;
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
        const date = new Date(parseInt(year), parseInt(month) - 1, 1);
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

// ============ TICKET METRICS ============

export async function getTicketMetrics(config: ChartQueryConfig): Promise<ChartDataPoint[]> {
  const { workspaceId, metric, timeRange, groupBy, sortOrder, limit } = config;
  const { start, end } = getDateRangeFromTimeRange(timeRange);
  const truncUnit = getDateTruncUnit(groupBy);
  const { db } = await getScopedDb();

  // Use materialized views for better performance
  if (USE_MATERIALIZED_VIEWS) {
    // Convert dates to ISO strings for proper PostgreSQL serialization
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    const mvBaseConditions = and(
      eq(mvHelpdeskTicketsDaily.workspaceId, workspaceId),
      gte(mvHelpdeskTicketsDaily.period, sql`${startIso}::timestamp`),
      lte(mvHelpdeskTicketsDaily.period, sql`${endIso}::timestamp`)
    );

    switch (metric) {
      case 'total_tickets':
      case 'tickets_by_day': {
        // Query MV and re-aggregate by the requested groupBy period
        // Use sql.raw for truncUnit to embed as literal (not parameter) so PostgreSQL can match SELECT/GROUP BY
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskTicketsDaily.period})`;
        const results = await db
          .select({
            period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskTicketsDaily.period})`.as('period'),
            count: sql<number>`SUM(${mvHelpdeskTicketsDaily.ticketCount})`,
          })
          .from(mvHelpdeskTicketsDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, index) => ({
          label: formatDateLabel(row.period, groupBy),
          value: Number(row.count) || 0,
          fill: getChartColor(index),
        }));
      }

      case 'open_tickets': {
        const openStatuses = ['new', 'open', 'pending', 'in_progress'];
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskTicketsDaily.period})`;
        const results = await db
          .select({
            period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskTicketsDaily.period})`.as('period'),
            count: sql<number>`SUM(${mvHelpdeskTicketsDaily.ticketCount})`,
          })
          .from(mvHelpdeskTicketsDaily)
          .where(and(
            mvBaseConditions,
            inArray(mvHelpdeskTicketsDaily.status, openStatuses)
          ))
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, index) => ({
          label: formatDateLabel(row.period, groupBy),
          value: Number(row.count) || 0,
          fill: getChartColor(index),
        }));
      }

      case 'closed_tickets': {
        const closedStatuses = ['resolved', 'closed'];
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskTicketsDaily.period})`;
        const results = await db
          .select({
            period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskTicketsDaily.period})`.as('period'),
            count: sql<number>`SUM(${mvHelpdeskTicketsDaily.ticketCount})`,
          })
          .from(mvHelpdeskTicketsDaily)
          .where(and(
            mvBaseConditions,
            inArray(mvHelpdeskTicketsDaily.status, closedStatuses)
          ))
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, index) => ({
          label: formatDateLabel(row.period, groupBy),
          value: Number(row.count) || 0,
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
          .orderBy(sortOrder === 'desc'
            ? desc(sql`SUM(${mvHelpdeskTicketsDaily.ticketCount})`)
            : asc(sql`SUM(${mvHelpdeskTicketsDaily.ticketCount})`)
          )
          .limit(limit || 10);

        return results.map((row, index) => ({
          label: formatStatusLabel(row.status || ''),
          value: Number(row.count) || 0,
          fill: getChartColor(index),
          name: formatStatusLabel(row.status || ''),
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
          .orderBy(sortOrder === 'desc'
            ? desc(sql`SUM(${mvHelpdeskTicketsDaily.ticketCount})`)
            : asc(sql`SUM(${mvHelpdeskTicketsDaily.ticketCount})`)
          )
          .limit(limit || 10);

        return results.map((row, index) => ({
          label: formatPriorityLabel(row.priority || ''),
          value: Number(row.count) || 0,
          fill: getPriorityColor(row.priority || '', index),
          name: formatPriorityLabel(row.priority || ''),
        }));
      }

      case 'escalated_tickets': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskTicketsDaily.period})`;
        const results = await db
          .select({
            period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskTicketsDaily.period})`.as('period'),
            count: sql<number>`SUM(${mvHelpdeskTicketsDaily.escalatedCount})`,
          })
          .from(mvHelpdeskTicketsDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, index) => ({
          label: formatDateLabel(row.period, groupBy),
          value: Number(row.count) || 0,
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
          .orderBy(sortOrder === 'desc'
            ? desc(sql`SUM(${mvHelpdeskTicketsDaily.ticketCount})`)
            : asc(sql`SUM(${mvHelpdeskTicketsDaily.ticketCount})`)
          )
          .limit(limit || 10);

        return results.map((row, index) => ({
          label: formatChannelLabel(row.channel || ''),
          value: Number(row.count) || 0,
          fill: getChartColor(index),
          name: formatChannelLabel(row.channel || ''),
        }));
      }

      case 'resolution_rate': {
        // Resolution rate = closed tickets / total tickets as percentage
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskTicketsDaily.period})`;
        const results = await db
          .select({
            period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskTicketsDaily.period})`.as('period'),
            closed: sql<number>`SUM(CASE WHEN ${mvHelpdeskTicketsDaily.status} IN ('resolved', 'closed') THEN ${mvHelpdeskTicketsDaily.ticketCount} ELSE 0 END)`,
            total: sql<number>`SUM(${mvHelpdeskTicketsDaily.ticketCount})`,
          })
          .from(mvHelpdeskTicketsDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, index) => {
          const total = Number(row.total);
          const rate = total > 0 ? Math.round((Number(row.closed) / total) * 100) : 0;
          return {
            label: formatDateLabel(row.period, groupBy),
            value: rate,
            fill: getChartColor(index),
          };
        });
      }

      case 'avg_handling_time': {
        // Average handling time (response + resolution time)
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskTicketsDaily.period})`;
        const results = await db
          .select({
            period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskTicketsDaily.period})`.as('period'),
            avgHandling: sql<number>`
              (SUM(COALESCE(${mvHelpdeskTicketsDaily.avgResponseTime}::numeric, 0) * ${mvHelpdeskTicketsDaily.ticketCount}) +
               SUM(COALESCE(${mvHelpdeskTicketsDaily.avgResolutionTime}::numeric, 0) * ${mvHelpdeskTicketsDaily.ticketCount}))
              / NULLIF(SUM(${mvHelpdeskTicketsDaily.ticketCount}), 0)
            `,
          })
          .from(mvHelpdeskTicketsDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, index) => ({
          label: formatDateLabel(row.period, groupBy),
          value: Math.round(Number(row.avgHandling) || 0),
          fill: getChartColor(index),
        }));
      }
    }
  }

  // Fallback to base tables if MVs not enabled or metric not covered
  const baseConditions = and(
    eq(helpdeskTickets.workspaceId, workspaceId),
    isNull(helpdeskTickets.deletedAt),
    gte(helpdeskTickets.createdAt, start),
    lte(helpdeskTickets.createdAt, end)
  );

  switch (metric) {
    case 'total_tickets':
    case 'tickets_by_day': {
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`.as('period'),
          count: count(),
        })
        .from(helpdeskTickets)
        .where(baseConditions)
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Number(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'open_tickets': {
      const openStatuses = ['new', 'open', 'pending', 'in_progress'];
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`.as('period'),
          count: count(),
        })
        .from(helpdeskTickets)
        .where(and(
          baseConditions,
          inArray(helpdeskTickets.status, openStatuses)
        ))
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Number(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'closed_tickets': {
      const closedStatuses = ['resolved', 'closed'];
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`.as('period'),
          count: count(),
        })
        .from(helpdeskTickets)
        .where(and(
          baseConditions,
          inArray(helpdeskTickets.status, closedStatuses)
        ))
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

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
        .orderBy(sortOrder === 'desc' ? desc(count()) : asc(count()))
        .limit(limit || 10);

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
        .orderBy(sortOrder === 'desc' ? desc(count()) : asc(count()))
        .limit(limit || 10);

      return results.map((row, index) => ({
        label: formatPriorityLabel(row.priority),
        value: Number(row.count),
        fill: getPriorityColor(row.priority, index),
        name: formatPriorityLabel(row.priority),
      }));
    }

    case 'escalated_tickets': {
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`.as('period'),
          count: count(),
        })
        .from(helpdeskTickets)
        .where(and(
          baseConditions,
          eq(helpdeskTickets.isEscalated, true)
        ))
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

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
        .orderBy(sortOrder === 'desc' ? desc(count()) : asc(count()))
        .limit(limit || 10);

      return results.map((row, index) => ({
        label: formatChannelLabel(row.channel),
        value: Number(row.count),
        fill: getChartColor(index),
        name: formatChannelLabel(row.channel),
      }));
    }

    case 'resolution_rate': {
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`.as('period'),
          closed: sql<number>`COUNT(*) FILTER (WHERE ${helpdeskTickets.status} IN ('resolved', 'closed'))`,
          total: count(),
        })
        .from(helpdeskTickets)
        .where(baseConditions)
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

      return results.map((row, index) => {
        const total = Number(row.total);
        const rate = total > 0 ? Math.round((Number(row.closed) / total) * 100) : 0;
        return {
          label: formatDateLabel(row.period, groupBy),
          value: rate,
          fill: getChartColor(index),
        };
      });
    }

    case 'avg_handling_time': {
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`.as('period'),
          avgHandling: sql<number>`AVG(COALESCE(${helpdeskTickets.responseTime}, 0) + COALESCE(${helpdeskTickets.resolutionTime}, 0))`,
        })
        .from(helpdeskTickets)
        .where(baseConditions)
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Math.round(Number(row.avgHandling) || 0),
        fill: getChartColor(index),
      }));
    }

    default:
      return [];
  }
}

// ============ CONVERSATION METRICS ============

export async function getConversationMetrics(config: ChartQueryConfig): Promise<ChartDataPoint[]> {
  const { workspaceId, metric, timeRange, groupBy, sortOrder, limit } = config;
  const { start, end } = getDateRangeFromTimeRange(timeRange);
  const truncUnit = getDateTruncUnit(groupBy);
  const { db } = await getScopedDb();

  // Use materialized views for better performance
  if (USE_MATERIALIZED_VIEWS) {
    // Convert dates to ISO strings for proper PostgreSQL serialization
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    const mvBaseConditions = and(
      eq(mvHelpdeskConversationsDaily.workspaceId, workspaceId),
      gte(mvHelpdeskConversationsDaily.period, sql`${startIso}::timestamp`),
      lte(mvHelpdeskConversationsDaily.period, sql`${endIso}::timestamp`)
    );

    switch (metric) {
      case 'total_conversations':
      case 'conversations_by_day': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskConversationsDaily.period})`;
        const results = await db
          .select({
            period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskConversationsDaily.period})`.as('period'),
            count: sql<number>`SUM(${mvHelpdeskConversationsDaily.conversationCount})`,
          })
          .from(mvHelpdeskConversationsDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, index) => ({
          label: formatDateLabel(row.period, groupBy),
          value: Number(row.count) || 0,
          fill: getChartColor(index),
        }));
      }

      case 'active_conversations': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskConversationsDaily.period})`;
        const results = await db
          .select({
            period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskConversationsDaily.period})`.as('period'),
            count: sql<number>`SUM(${mvHelpdeskConversationsDaily.conversationCount})`,
          })
          .from(mvHelpdeskConversationsDaily)
          .where(and(
            mvBaseConditions,
            eq(mvHelpdeskConversationsDaily.status, 'active')
          ))
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, index) => ({
          label: formatDateLabel(row.period, groupBy),
          value: Number(row.count) || 0,
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
          .orderBy(sortOrder === 'desc'
            ? desc(sql`SUM(${mvHelpdeskConversationsDaily.conversationCount})`)
            : asc(sql`SUM(${mvHelpdeskConversationsDaily.conversationCount})`)
          )
          .limit(limit || 10);

        return results.map((row, index) => ({
          label: formatChannelLabel(row.channel || ''),
          value: Number(row.count) || 0,
          fill: getChartColor(index),
          name: formatChannelLabel(row.channel || ''),
        }));
      }

      case 'avg_messages': {
        // Weighted average across periods
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskConversationsDaily.period})`;
        const results = await db
          .select({
            period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskConversationsDaily.period})`.as('period'),
            avg: sql<number>`SUM(${mvHelpdeskConversationsDaily.avgMessages}::numeric * ${mvHelpdeskConversationsDaily.conversationCount}) / NULLIF(SUM(${mvHelpdeskConversationsDaily.conversationCount}), 0)`,
          })
          .from(mvHelpdeskConversationsDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, index) => ({
          label: formatDateLabel(row.period, groupBy),
          value: Math.round((Number(row.avg) || 0) * 10) / 10,
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
          .orderBy(sortOrder === 'desc'
            ? desc(sql`SUM(${mvHelpdeskConversationsDaily.conversationCount})`)
            : asc(sql`SUM(${mvHelpdeskConversationsDaily.conversationCount})`)
          )
          .limit(limit || 10);

        return results.map((row, index) => ({
          label: formatConversationStatusLabel(row.status || ''),
          value: Number(row.count) || 0,
          fill: getChartColor(index),
          name: formatConversationStatusLabel(row.status || ''),
        }));
      }

      case 'closed_conversations': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskConversationsDaily.period})`;
        const results = await db
          .select({
            period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskConversationsDaily.period})`.as('period'),
            count: sql<number>`SUM(${mvHelpdeskConversationsDaily.conversationCount})`,
          })
          .from(mvHelpdeskConversationsDaily)
          .where(and(
            mvBaseConditions,
            eq(mvHelpdeskConversationsDaily.status, 'closed')
          ))
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, index) => ({
          label: formatDateLabel(row.period, groupBy),
          value: Number(row.count) || 0,
          fill: getChartColor(index),
        }));
      }

      case 'conversation_resolution_rate': {
        // Resolution rate = closed conversations / total conversations as percentage
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskConversationsDaily.period})`;
        const results = await db
          .select({
            period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskConversationsDaily.period})`.as('period'),
            closed: sql<number>`SUM(CASE WHEN ${mvHelpdeskConversationsDaily.status} = 'closed' THEN ${mvHelpdeskConversationsDaily.conversationCount} ELSE 0 END)`,
            total: sql<number>`SUM(${mvHelpdeskConversationsDaily.conversationCount})`,
          })
          .from(mvHelpdeskConversationsDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, index) => {
          const total = Number(row.total);
          const rate = total > 0 ? Math.round((Number(row.closed) / total) * 100) : 0;
          return {
            label: formatDateLabel(row.period, groupBy),
            value: rate,
            fill: getChartColor(index),
          };
        });
      }
    }
  }

  // Fallback to base tables
  const baseConditions = and(
    eq(helpdeskConversations.workspaceId, workspaceId),
    isNull(helpdeskConversations.deletedAt),
    gte(helpdeskConversations.createdAt, start),
    lte(helpdeskConversations.createdAt, end)
  );

  switch (metric) {
    case 'total_conversations':
    case 'conversations_by_day': {
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskConversations.createdAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskConversations.createdAt})`.as('period'),
          count: count(),
        })
        .from(helpdeskConversations)
        .where(baseConditions)
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Number(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'active_conversations': {
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskConversations.createdAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskConversations.createdAt})`.as('period'),
          count: count(),
        })
        .from(helpdeskConversations)
        .where(and(
          baseConditions,
          eq(helpdeskConversations.status, 'active')
        ))
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

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
        .orderBy(sortOrder === 'desc' ? desc(count()) : asc(count()))
        .limit(limit || 10);

      return results.map((row, index) => ({
        label: formatChannelLabel(row.channel),
        value: Number(row.count),
        fill: getChartColor(index),
        name: formatChannelLabel(row.channel),
      }));
    }

    case 'avg_messages': {
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskConversations.createdAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskConversations.createdAt})`.as('period'),
          avg: avg(helpdeskConversations.messageCount),
        })
        .from(helpdeskConversations)
        .where(baseConditions)
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

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
        .orderBy(sortOrder === 'desc' ? desc(count()) : asc(count()))
        .limit(limit || 10);

      return results.map((row, index) => ({
        label: formatConversationStatusLabel(row.status),
        value: Number(row.count),
        fill: getChartColor(index),
        name: formatConversationStatusLabel(row.status),
      }));
    }

    case 'closed_conversations': {
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskConversations.createdAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskConversations.createdAt})`.as('period'),
          count: count(),
        })
        .from(helpdeskConversations)
        .where(and(
          baseConditions,
          eq(helpdeskConversations.status, 'closed')
        ))
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Number(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'conversation_resolution_rate': {
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskConversations.createdAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskConversations.createdAt})`.as('period'),
          closed: sql<number>`COUNT(*) FILTER (WHERE ${helpdeskConversations.status} = 'closed')`,
          total: count(),
        })
        .from(helpdeskConversations)
        .where(baseConditions)
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

      return results.map((row, index) => {
        const total = Number(row.total);
        const rate = total > 0 ? Math.round((Number(row.closed) / total) * 100) : 0;
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
  const { workspaceId, metric, sortOrder, limit } = config;
  const { db } = await getScopedDb();

  // Use materialized views for better performance
  if (USE_MATERIALIZED_VIEWS) {
    const mvBaseConditions = eq(mvHelpdeskAgentStats.workspaceId, workspaceId);

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
          .where(additionalCondition ? and(mvBaseConditions, additionalCondition) : mvBaseConditions)
          .orderBy(sortOrder === 'desc'
            ? sql`${mvHelpdeskAgentStats.ticketsResolved} DESC NULLS LAST`
            : sql`${mvHelpdeskAgentStats.ticketsResolved} ASC NULLS LAST`
          )
          .limit(limit || 10);

        return results.map((row, index) => ({
          label: row.name,
          value: row.ticketsResolved || 0,
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
          .where(mvBaseConditions)
          .orderBy(sortOrder === 'desc'
            ? sql`${mvHelpdeskAgentStats.ticketsResolved} DESC NULLS LAST`
            : sql`${mvHelpdeskAgentStats.ticketsResolved} ASC NULLS LAST`
          )
          .limit(limit || 10);

        return results.map((row, index) => ({
          label: row.name,
          value: row.ticketsResolved || 0,
          fill: getChartColor(index),
          name: row.name,
          assigned: row.ticketsAssigned || 0,
        }));
      }

      case 'agent_response_time': {
        const results = await db
          .select({
            name: mvHelpdeskAgentStats.name,
            avgResponseTime: mvHelpdeskAgentStats.averageResponseTime,
          })
          .from(mvHelpdeskAgentStats)
          .where(mvBaseConditions)
          .orderBy(sortOrder === 'desc'
            ? sql`${mvHelpdeskAgentStats.averageResponseTime} DESC NULLS LAST`
            : sql`${mvHelpdeskAgentStats.averageResponseTime} ASC NULLS LAST`
          )
          .limit(limit || 10);

        return results.map((row, index) => ({
          label: row.name,
          value: row.avgResponseTime || 0,
          fill: getChartColor(index),
          name: row.name,
        }));
      }
    }
  }

  // Fallback to base tables
  const baseConditions = and(
    eq(helpdeskAgents.workspaceId, workspaceId),
    isNull(helpdeskAgents.deletedAt)
  );

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
        .orderBy(sortOrder === 'desc'
          ? sql`${helpdeskAgents.ticketsResolved} DESC NULLS LAST`
          : sql`${helpdeskAgents.ticketsResolved} ASC NULLS LAST`
        )
        .limit(limit || 10);

      return results.map((row, index) => ({
        label: row.name,
        value: row.ticketsResolved || 0,
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
        .orderBy(sortOrder === 'desc'
          ? sql`${helpdeskAgents.ticketsResolved} DESC NULLS LAST`
          : sql`${helpdeskAgents.ticketsResolved} ASC NULLS LAST`
        )
        .limit(limit || 10);

      return results.map((row, index) => ({
        label: row.name,
        value: row.ticketsResolved || 0,
        fill: getChartColor(index),
        name: row.name,
        assigned: row.ticketsAssigned || 0,
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
        .orderBy(sortOrder === 'desc'
          ? sql`${helpdeskAgents.averageResponseTime} DESC NULLS LAST`
          : sql`${helpdeskAgents.averageResponseTime} ASC NULLS LAST`
        )
        .limit(limit || 10);

      return results.map((row, index) => ({
        label: row.name,
        value: row.avgResponseTime || 0,
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
  const { workspaceId, metric, timeRange, groupBy, sortOrder, limit } = config;
  const { start, end } = getDateRangeFromTimeRange(timeRange);
  const truncUnit = getDateTruncUnit(groupBy);
  const { db } = await getScopedDb();

  // Use materialized views for better performance
  if (USE_MATERIALIZED_VIEWS) {
    // Convert dates to ISO strings for proper PostgreSQL serialization
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    const mvBaseConditions = and(
      eq(mvHelpdeskTicketsDaily.workspaceId, workspaceId),
      gte(mvHelpdeskTicketsDaily.period, sql`${startIso}::timestamp`),
      lte(mvHelpdeskTicketsDaily.period, sql`${endIso}::timestamp`)
    );

    switch (metric) {
      case 'avg_first_response':
      case 'response_time_trend': {
        // Weighted average across daily aggregations
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskTicketsDaily.period})`;
        const results = await db
          .select({
            period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskTicketsDaily.period})`.as('period'),
            avg: sql<number>`SUM(${mvHelpdeskTicketsDaily.avgResponseTime}::numeric * ${mvHelpdeskTicketsDaily.ticketCount}) / NULLIF(SUM(${mvHelpdeskTicketsDaily.ticketCount}), 0)`,
          })
          .from(mvHelpdeskTicketsDaily)
          .where(and(
            mvBaseConditions,
            sql`${mvHelpdeskTicketsDaily.avgResponseTime} IS NOT NULL`
          ))
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, index) => ({
          label: formatDateLabel(row.period, groupBy),
          value: Math.round(Number(row.avg) || 0),
          fill: getChartColor(index),
        }));
      }

      case 'avg_resolution_time': {
        // Weighted average across daily aggregations
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskTicketsDaily.period})`;
        const results = await db
          .select({
            period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskTicketsDaily.period})`.as('period'),
            avg: sql<number>`SUM(${mvHelpdeskTicketsDaily.avgResolutionTime}::numeric * ${mvHelpdeskTicketsDaily.ticketCount}) / NULLIF(SUM(${mvHelpdeskTicketsDaily.ticketCount}), 0)`,
          })
          .from(mvHelpdeskTicketsDaily)
          .where(and(
            mvBaseConditions,
            sql`${mvHelpdeskTicketsDaily.avgResolutionTime} IS NOT NULL`
          ))
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, index) => ({
          label: formatDateLabel(row.period, groupBy),
          value: Math.round(Number(row.avg) || 0),
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
          .orderBy(sortOrder === 'desc'
            ? sql`SUM(${mvHelpdeskTicketsDaily.avgResponseTime}::numeric * ${mvHelpdeskTicketsDaily.ticketCount}) / NULLIF(SUM(${mvHelpdeskTicketsDaily.ticketCount}), 0) DESC NULLS LAST`
            : sql`SUM(${mvHelpdeskTicketsDaily.avgResponseTime}::numeric * ${mvHelpdeskTicketsDaily.ticketCount}) / NULLIF(SUM(${mvHelpdeskTicketsDaily.ticketCount}), 0) ASC NULLS LAST`
          )
          .limit(limit || 10);

        return results.map((row, index) => ({
          label: formatPriorityLabel(row.priority || ''),
          value: Math.round(Number(row.avg) || 0),
          fill: getPriorityColor(row.priority || '', index),
          name: formatPriorityLabel(row.priority || ''),
        }));
      }

      // sla_compliance not in MV - fall through to base tables
    }
  }

  // Fallback to base tables
  const baseConditions = and(
    eq(helpdeskTickets.workspaceId, workspaceId),
    isNull(helpdeskTickets.deletedAt),
    gte(helpdeskTickets.createdAt, start),
    lte(helpdeskTickets.createdAt, end)
  );

  switch (metric) {
    case 'avg_first_response':
    case 'response_time_trend': {
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`.as('period'),
          avg: avg(helpdeskTickets.responseTime),
        })
        .from(helpdeskTickets)
        .where(and(
          baseConditions,
          sql`${helpdeskTickets.responseTime} IS NOT NULL`
        ))
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Math.round(Number(row.avg) || 0),
        fill: getChartColor(index),
      }));
    }

    case 'avg_resolution_time': {
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`.as('period'),
          avg: avg(helpdeskTickets.resolutionTime),
        })
        .from(helpdeskTickets)
        .where(and(
          baseConditions,
          sql`${helpdeskTickets.resolutionTime} IS NOT NULL`
        ))
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Math.round(Number(row.avg) || 0),
        fill: getChartColor(index),
      }));
    }

    case 'sla_compliance': {
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`.as('period'),
          achieved: sql<number>`COUNT(*) FILTER (WHERE ${helpdeskTickets.slaStatus} = 'achieved')`,
          total: count(),
        })
        .from(helpdeskTickets)
        .where(and(
          baseConditions,
          sql`${helpdeskTickets.slaStatus} IS NOT NULL`
        ))
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Number(row.total) > 0
          ? Math.round((Number(row.achieved) / Number(row.total)) * 100)
          : 0,
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
        .orderBy(sortOrder === 'desc' ? sql`avg(${helpdeskTickets.responseTime}) DESC` : sql`avg(${helpdeskTickets.responseTime}) ASC`)
        .limit(limit || 10);

      return results.map((row, index) => ({
        label: formatPriorityLabel(row.priority),
        value: Math.round(Number(row.avg) || 0),
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
  const { workspaceId, metric, timeRange, groupBy, sortOrder, limit } = config;
  const { start, end } = getDateRangeFromTimeRange(timeRange);
  const truncUnit = getDateTruncUnit(groupBy);
  const { db } = await getScopedDb();

  // Use materialized views for better performance
  if (USE_MATERIALIZED_VIEWS) {
    // Convert dates to ISO strings for proper PostgreSQL serialization
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    const mvBaseConditions = and(
      eq(mvHelpdeskSatisfactionDaily.workspaceId, workspaceId),
      gte(mvHelpdeskSatisfactionDaily.period, sql`${startIso}::timestamp`),
      lte(mvHelpdeskSatisfactionDaily.period, sql`${endIso}::timestamp`)
    );

    switch (metric) {
      case 'csat_score':
      case 'satisfaction_trend': {
        // Weighted average across daily aggregations
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskSatisfactionDaily.period})`;
        const results = await db
          .select({
            period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskSatisfactionDaily.period})`.as('period'),
            avg: sql<number>`SUM(${mvHelpdeskSatisfactionDaily.avgRating}::numeric * ${mvHelpdeskSatisfactionDaily.completedCount}) / NULLIF(SUM(${mvHelpdeskSatisfactionDaily.completedCount}), 0)`,
          })
          .from(mvHelpdeskSatisfactionDaily)
          .where(and(
            mvBaseConditions,
            sql`${mvHelpdeskSatisfactionDaily.avgRating} IS NOT NULL`
          ))
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, index) => ({
          label: formatDateLabel(row.period, groupBy),
          value: Math.round((Number(row.avg) || 0) * 10) / 10,
          fill: getChartColor(index),
        }));
      }

      case 'nps_score': {
        // NPS = % Promoters - % Detractors (already pre-computed in MV)
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskSatisfactionDaily.period})`;
        const results = await db
          .select({
            period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskSatisfactionDaily.period})`.as('period'),
            promoters: sql<number>`SUM(${mvHelpdeskSatisfactionDaily.promoters})`,
            detractors: sql<number>`SUM(${mvHelpdeskSatisfactionDaily.detractors})`,
            total: sql<number>`SUM(${mvHelpdeskSatisfactionDaily.completedCount})`,
          })
          .from(mvHelpdeskSatisfactionDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, index) => {
          const total = Number(row.total);
          const nps = total > 0
            ? Math.round(((Number(row.promoters) - Number(row.detractors)) / total) * 100)
            : 0;
          return {
            label: formatDateLabel(row.period, groupBy),
            value: nps,
            fill: getChartColor(index),
          };
        });
      }

      case 'survey_response_rate': {
        // Response rate = completed surveys / total surveys sent as percentage
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskSatisfactionDaily.period})`;
        const results = await db
          .select({
            period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskSatisfactionDaily.period})`.as('period'),
            completed: sql<number>`SUM(${mvHelpdeskSatisfactionDaily.completedCount})`,
            total: sql<number>`SUM(${mvHelpdeskSatisfactionDaily.surveyCount})`,
          })
          .from(mvHelpdeskSatisfactionDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, index) => {
          const total = Number(row.total);
          const rate = total > 0 ? Math.round((Number(row.completed) / total) * 100) : 0;
          return {
            label: formatDateLabel(row.period, groupBy),
            value: rate,
            fill: getChartColor(index),
          };
        });
      }

      case 'total_surveys': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskSatisfactionDaily.period})`;
        const results = await db
          .select({
            period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskSatisfactionDaily.period})`.as('period'),
            count: sql<number>`SUM(${mvHelpdeskSatisfactionDaily.surveyCount})`,
          })
          .from(mvHelpdeskSatisfactionDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, index) => ({
          label: formatDateLabel(row.period, groupBy),
          value: Number(row.count) || 0,
          fill: getChartColor(index),
        }));
      }

      case 'completed_surveys': {
        const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskSatisfactionDaily.period})`;
        const results = await db
          .select({
            period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${mvHelpdeskSatisfactionDaily.period})`.as('period'),
            count: sql<number>`SUM(${mvHelpdeskSatisfactionDaily.completedCount})`,
          })
          .from(mvHelpdeskSatisfactionDaily)
          .where(mvBaseConditions)
          .groupBy(periodExpr)
          .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
          .limit(limit || 100);

        return results.map((row, index) => ({
          label: formatDateLabel(row.period, groupBy),
          value: Number(row.count) || 0,
          fill: getChartColor(index),
        }));
      }

      // ratings_distribution and satisfaction_by_agent require base tables
      // (not aggregatable from daily MVs)
    }
  }

  // Fallback to base tables
  const baseConditions = and(
    eq(helpdeskSatisfactionSurveys.workspaceId, workspaceId),
    isNull(helpdeskSatisfactionSurveys.deletedAt),
    gte(helpdeskSatisfactionSurveys.sentAt, start),
    lte(helpdeskSatisfactionSurveys.sentAt, end)
  );

  switch (metric) {
    case 'csat_score':
    case 'satisfaction_trend': {
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskSatisfactionSurveys.sentAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskSatisfactionSurveys.sentAt})`.as('period'),
          avg: avg(helpdeskSatisfactionSurveys.rating),
        })
        .from(helpdeskSatisfactionSurveys)
        .where(and(
          baseConditions,
          eq(helpdeskSatisfactionSurveys.status, 'completed'),
          sql`${helpdeskSatisfactionSurveys.rating} IS NOT NULL`
        ))
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Math.round((Number(row.avg) || 0) * 10) / 10,
        fill: getChartColor(index),
      }));
    }

    case 'nps_score': {
      // NPS = % Promoters (9-10) - % Detractors (0-6)
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskSatisfactionSurveys.sentAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskSatisfactionSurveys.sentAt})`.as('period'),
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
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

      return results.map((row, index) => {
        const total = Number(row.total);
        const nps = total > 0
          ? Math.round(((Number(row.promoters) - Number(row.detractors)) / total) * 100)
          : 0;
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
        .orderBy(sortOrder === 'desc' ? desc(count()) : asc(helpdeskSatisfactionSurveys.rating))
        .limit(limit || 10);

      return results.map((row, index) => ({
        label: `${row.rating} Star${row.rating !== 1 ? 's' : ''}`,
        value: Number(row.count),
        fill: getRatingColor(row.rating || 0, index),
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
          eq(helpdeskSatisfactionSurveys.workspaceId, workspaceId),
          isNull(helpdeskSatisfactionSurveys.deletedAt),
          eq(helpdeskSatisfactionSurveys.status, 'completed'),
          sql`${helpdeskSatisfactionSurveys.rating} IS NOT NULL`,
          sql`${helpdeskTickets.assigneeName} IS NOT NULL`
        ))
        .groupBy(helpdeskTickets.assigneeName)
        .orderBy(sortOrder === 'desc' ? sql`avg(${helpdeskSatisfactionSurveys.rating}) DESC` : sql`avg(${helpdeskSatisfactionSurveys.rating}) ASC`)
        .limit(limit || 10);

      return results.map((row, index) => ({
        label: row.agentName || 'Unknown',
        value: Math.round((Number(row.avg) || 0) * 10) / 10,
        fill: getChartColor(index),
        name: row.agentName || 'Unknown',
      }));
    }

    case 'survey_response_rate': {
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskSatisfactionSurveys.sentAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskSatisfactionSurveys.sentAt})`.as('period'),
          completed: sql<number>`COUNT(*) FILTER (WHERE ${helpdeskSatisfactionSurveys.status} = 'completed')`,
          total: count(),
        })
        .from(helpdeskSatisfactionSurveys)
        .where(baseConditions)
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

      return results.map((row, index) => {
        const total = Number(row.total);
        const rate = total > 0 ? Math.round((Number(row.completed) / total) * 100) : 0;
        return {
          label: formatDateLabel(row.period, groupBy),
          value: rate,
          fill: getChartColor(index),
        };
      });
    }

    case 'total_surveys': {
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskSatisfactionSurveys.sentAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskSatisfactionSurveys.sentAt})`.as('period'),
          count: count(),
        })
        .from(helpdeskSatisfactionSurveys)
        .where(baseConditions)
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Number(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'completed_surveys': {
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskSatisfactionSurveys.sentAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskSatisfactionSurveys.sentAt})`.as('period'),
          count: count(),
        })
        .from(helpdeskSatisfactionSurveys)
        .where(and(
          baseConditions,
          eq(helpdeskSatisfactionSurveys.status, 'completed')
        ))
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

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
  const { workspaceId, metric, timeRange, groupBy, sortOrder, limit } = config;
  const { start, end } = getDateRangeFromTimeRange(timeRange);
  const truncUnit = getDateTruncUnit(groupBy);
  const { db } = await getScopedDb();

  switch (metric) {
    case 'total_customers':
    case 'new_customers': {
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${contacts.createdAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${contacts.createdAt})`.as('period'),
          count: count(),
        })
        .from(contacts)
        .where(and(
          isNull(contacts.deletedAt),
          gte(contacts.createdAt, start),
          lte(contacts.createdAt, end)
        ))
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

      return results.map((row, index) => ({
        label: formatDateLabel(row.period, groupBy),
        value: Number(row.count),
        fill: getChartColor(index),
      }));
    }

    case 'returning_customers': {
      // Customers with more than 1 ticket
      const periodExpr = sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`;
      const results = await db
        .select({
          period: sql<Date>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${helpdeskTickets.createdAt})`.as('period'),
          count: sql<number>`COUNT(DISTINCT ${helpdeskTickets.customerEmail})`,
        })
        .from(helpdeskTickets)
        .where(and(
          eq(helpdeskTickets.workspaceId, workspaceId),
          isNull(helpdeskTickets.deletedAt),
          gte(helpdeskTickets.createdAt, start),
          lte(helpdeskTickets.createdAt, end),
          sql`${helpdeskTickets.customerEmail} IN (
            SELECT customer_email FROM helpdesk_tickets
            WHERE workspace_id = ${workspaceId}
            GROUP BY customer_email
            HAVING COUNT(*) > 1
          )`
        ))
        .groupBy(periodExpr)
        .orderBy(sortOrder === 'desc' ? desc(periodExpr) : asc(periodExpr))
        .limit(limit || 100);

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
          eq(helpdeskTickets.workspaceId, workspaceId),
          isNull(helpdeskTickets.deletedAt),
          gte(helpdeskTickets.createdAt, start),
          lte(helpdeskTickets.createdAt, end)
        ))
        .groupBy(helpdeskTickets.customerEmail, helpdeskTickets.customerName)
        .orderBy(desc(count()))
        .limit(limit || 10);

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

function getRatingColor(rating: number, fallbackIndex: number): string {
  if (rating >= 4) return 'var(--chart-3)'; // Green for good
  if (rating >= 3) return 'var(--chart-4)'; // Yellow for neutral
  return 'var(--chart-1)'; // Red for bad
}
