/**
 * R2 SQL REST API query service
 *
 * Queries Cloudflare R2 Data Catalog (Iceberg) via the SQL REST API
 * to fetch chart data for analytics dashboards.
 *
 * Ported from apps/api-worker/src/services/analytics-query.ts.
 */

import type { Env } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChartQueryParams {
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
  date?: string;
}

// ---------------------------------------------------------------------------
// Module + entity mapping
// ---------------------------------------------------------------------------

const ENTITY_MODULE_MAP: Record<string, { module: string; entityType: string }> = {
  // Helpdesk (singular + plural)
  ticket: { module: 'helpdesk', entityType: 'ticket' },
  tickets: { module: 'helpdesk', entityType: 'ticket' },
  conversation: { module: 'helpdesk', entityType: 'conversation' },
  conversations: { module: 'helpdesk', entityType: 'conversation' },
  // CRM (singular + plural)
  lead: { module: 'crm', entityType: 'lead' },
  leads: { module: 'crm', entityType: 'lead' },
  opportunity: { module: 'crm', entityType: 'opportunity' },
  opportunities: { module: 'crm', entityType: 'opportunity' },
  activity: { module: 'crm', entityType: 'activity' },
  activities: { module: 'crm', entityType: 'activity' },
  customer: { module: 'crm', entityType: 'customer' },
  customers: { module: 'crm', entityType: 'customer' },
  contact: { module: 'crm', entityType: 'contact' },
  contacts: { module: 'crm', entityType: 'contact' },
  // Projects (singular + plural)
  task: { module: 'projects', entityType: 'task' },
  tasks: { module: 'projects', entityType: 'task' },
  time_entry: { module: 'projects', entityType: 'time_entry' },
  time_entries: { module: 'projects', entityType: 'time_entry' },
};

// Metric → SQL expression mapping (using named columns)
const METRIC_MAP: Record<string, { select: string }> = {
  count: { select: 'SUM(count)' },
  total: { select: 'SUM(count)' },
  amount: { select: 'SUM(amount)' },
  avg_amount: { select: 'AVG(amount)' },
  duration: { select: 'SUM(duration_seconds)' },
  avg_duration: { select: 'AVG(duration_seconds)' },
  score: { select: 'AVG(score)' },
  escalated: { select: 'SUM(is_escalated)' },
  qualified: { select: 'SUM(is_qualified)' },
  converted: { select: 'SUM(is_converted)' },
  completed: { select: 'SUM(is_completed)' },
  overdue: { select: 'SUM(is_overdue)' },
  billable: { select: 'SUM(is_billable)' },
  estimated_hours: { select: 'SUM(estimated_hours)' },
  actual_hours: { select: 'SUM(actual_hours)' },
  avg_progress: { select: 'AVG(progress)' },
  avg_probability: { select: 'AVG(probability)' },
  weighted_amount: { select: 'SUM(weighted_amount)' },
  messages: { select: 'SUM(message_count)' },
  avg_response_time: { select: 'AVG(response_time_seconds)' },
  avg_resolution_time: { select: 'AVG(resolution_time_seconds)' },
};

// ---------------------------------------------------------------------------
// Compound metric resolution
// ---------------------------------------------------------------------------
// The frontend sends compound metric IDs like "total_tickets" or
// "tickets_by_status". We resolve these to a generic metric + optional
// groupBy/filter override so the SQL builder can handle them.

interface ResolvedMetric {
  metric: string;           // key into METRIC_MAP
  groupByOverride?: string; // key into GROUP_BY_MAP (overrides params.groupBy)
  filterOverride?: Record<string, string>; // extra WHERE clauses
}

const COMPOUND_METRICS: Record<string, ResolvedMetric> = {
  // Tickets
  total_tickets:        { metric: 'count' },
  open_tickets:         { metric: 'count', filterOverride: { status: "IN ('new','open','pending','in_progress')" } },
  closed_tickets:       { metric: 'count', filterOverride: { status: "IN ('resolved','closed')" } },
  tickets_by_status:    { metric: 'count', groupByOverride: 'status' },
  tickets_by_priority:  { metric: 'count', groupByOverride: 'priority' },
  tickets_by_day:       { metric: 'count', groupByOverride: 'day' },
  escalated_tickets:    { metric: 'escalated' },
  // Conversations
  total_conversations:       { metric: 'count' },
  active_conversations:      { metric: 'count', filterOverride: { status: "IN ('active','pending')" } },
  conversations_by_channel:  { metric: 'count', groupByOverride: 'channel' },
  conversations_by_day:      { metric: 'count', groupByOverride: 'day' },
  avg_messages:              { metric: 'messages' },
  // Customers
  total_customers:      { metric: 'count' },
  new_customers:        { metric: 'count' },
  returning_customers:  { metric: 'count' },
  customers_by_tickets: { metric: 'count' },
  top_customers:        { metric: 'count' },
  // Agents
  total_agents:         { metric: 'count', groupByOverride: 'assignee' },
  active_agents:        { metric: 'count', groupByOverride: 'assignee' },
  tickets_per_agent:    { metric: 'count', groupByOverride: 'assignee' },
  agent_performance:    { metric: 'completed', groupByOverride: 'assignee' },
  agent_response_time:  { metric: 'avg_response_time', groupByOverride: 'assignee' },
  // Response times
  avg_first_response:   { metric: 'avg_response_time' },
  avg_resolution_time:  { metric: 'avg_resolution_time' },
  response_time_trend:  { metric: 'avg_response_time', groupByOverride: 'day' },
  sla_compliance:       { metric: 'count' },
  response_by_priority: { metric: 'avg_response_time', groupByOverride: 'priority' },
  // Satisfaction
  csat_score:           { metric: 'score' },
  nps_score:            { metric: 'score' },
  satisfaction_trend:   { metric: 'score', groupByOverride: 'day' },
  ratings_distribution: { metric: 'score', groupByOverride: 'category' },
  satisfaction_by_agent:{ metric: 'score', groupByOverride: 'assignee' },
};

// GroupBy → column mapping (using named columns)
const GROUP_BY_MAP: Record<string, { column: string; isDate: boolean }> = {
  day: { column: 'event_date', isDate: true },
  date: { column: 'event_date', isDate: true },
  status: { column: 'status', isDate: false },
  priority: { column: 'priority', isDate: false },
  channel: { column: 'channel', isDate: false },
  category: { column: 'category', isDate: false },
  assignee: { column: 'assignee_id', isDate: false },
  source: { column: 'source', isDate: false },
  stage: { column: 'stage', isDate: false },
  project: { column: 'project_id', isDate: false },
};

// ---------------------------------------------------------------------------
// Time range → date filter
// ---------------------------------------------------------------------------

function getDateRange(timeRange: string): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString().split('T')[0]!;
  const start = new Date(now);

  switch (timeRange) {
    case 'last_7_days':
      start.setDate(start.getDate() - 7);
      break;
    case 'last_14_days':
      start.setDate(start.getDate() - 14);
      break;
    case 'last_30_days':
      start.setDate(start.getDate() - 30);
      break;
    case 'last_90_days':
      start.setDate(start.getDate() - 90);
      break;
    case 'last_180_days':
      start.setDate(start.getDate() - 180);
      break;
    case 'last_365_days':
      start.setDate(start.getDate() - 365);
      break;
    case 'this_month': {
      start.setDate(1);
      break;
    }
    case 'this_quarter': {
      const quarter = Math.floor(start.getMonth() / 3);
      start.setMonth(quarter * 3, 1);
      break;
    }
    case 'this_year': {
      start.setMonth(0, 1);
      break;
    }
    default:
      start.setDate(start.getDate() - 30);
  }

  return { start: start.toISOString().split('T')[0]!, end };
}

// ---------------------------------------------------------------------------
// SQL builder
// ---------------------------------------------------------------------------

function buildQuery(workspaceId: string, params: ChartQueryParams): string {
  const entityInfo = ENTITY_MODULE_MAP[params.entity];
  if (!entityInfo) {
    throw new Error(`Unknown entity: ${params.entity}`);
  }

  // Resolve compound metric (e.g. "total_tickets" → metric "count")
  const compound = COMPOUND_METRICS[params.metric];
  const resolvedMetricKey = compound?.metric ?? params.metric;
  const resolvedGroupByKey = compound?.groupByOverride ?? params.groupBy;

  const metricInfo = METRIC_MAP[resolvedMetricKey];
  if (!metricInfo) {
    throw new Error(`Unknown metric: ${params.metric} (resolved: ${resolvedMetricKey})`);
  }

  const groupByInfo = GROUP_BY_MAP[resolvedGroupByKey];
  if (!groupByInfo) {
    throw new Error(`Unknown groupBy: ${resolvedGroupByKey}`);
  }

  const { start, end } = getDateRange(params.timeRange);

  // R2 SQL does NOT support aliases (AS) — use raw column expressions.
  // Result columns will be positional: [0]=label, [1]=value.
  const selectCols = [groupByInfo.column, metricInfo.select];

  const whereClauses = [
    `workspace_id = '${workspaceId}'`,
    `module = '${entityInfo.module}'`,
    `entity_type = '${entityInfo.entityType}'`,
    `event_date >= '${start}'`,
    `event_date <= '${end}'`,
  ];

  // For count-based metrics on time series, only count 'created' events.
  if (['count', 'total'].includes(resolvedMetricKey) && groupByInfo.isDate) {
    whereClauses.push(`action = 'created'`);
  }

  // Apply filter overrides from compound metric.
  if (compound?.filterOverride) {
    for (const [col, expr] of Object.entries(compound.filterOverride)) {
      whereClauses.push(`${col} ${expr}`);
    }
  }

  const where = whereClauses.join(' AND ');
  const orderBy = params.sortOrder === 'desc' ? 'DESC' : 'ASC';
  const limitClause = params.limit ? ` LIMIT ${params.limit}` : '';
  const orderCol = groupByInfo.isDate ? groupByInfo.column : metricInfo.select;

  return `SELECT ${selectCols.join(', ')} FROM default.weldsuite_analytics WHERE ${where} GROUP BY ${groupByInfo.column} ORDER BY ${orderCol} ${orderBy}${limitClause}`;
}

// ---------------------------------------------------------------------------
// Query executor
// ---------------------------------------------------------------------------

export async function queryAnalytics(
  env: Env,
  workspaceId: string,
  params: ChartQueryParams,
): Promise<ChartDataPoint[]> {
  const token = env.R2_SQL_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  const bucket = env.R2_ANALYTICS_BUCKET;

  if (!token || !accountId || !bucket) {
    console.warn('[Analytics] Missing R2_SQL_API_TOKEN, CF_ACCOUNT_ID, or R2_ANALYTICS_BUCKET — returning empty data');
    return [];
  }

  try {
    const sql = buildQuery(workspaceId, params);
    console.log(`[Analytics] SQL: ${sql}`);
    const response = await fetch(
      `https://api.sql.cloudflarestorage.com/api/v1/accounts/${accountId}/r2-sql/query/${bucket}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: sql }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      console.error(`[Analytics] R2 SQL API error ${response.status}: ${text}`);
      return [];
    }

    const raw = await response.json() as any;
    console.log(`[Analytics] R2 SQL response: ${JSON.stringify(raw).slice(0, 500)}`);

    const rows: any[] = raw.result?.rows ?? [];

    // Rows are positional: [0]=label (groupBy column), [1]=value (aggregate).
    return rows.map((row) => {
      const arr = Array.isArray(row) ? row : Object.values(row);
      return {
        label: String(arr[0] ?? ''),
        value: Number(arr[1] ?? 0),
      };
    });
  } catch (err) {
    console.error('[Analytics] Query failed:', err);
    return [];
  }
}
