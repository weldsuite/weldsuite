/**
 * R2 SQL REST API query service
 *
 * Queries Cloudflare R2 Data Catalog (Iceberg) via the SQL REST API
 * to fetch chart data for analytics dashboards.
 *
 * Ported from apps/api-worker/src/services/analytics-query.ts.
 *
 * R2 SQL is deliberately used for the simplest possible shapes only (no
 * aliases, no date functions): every query groups by a plain column and returns
 * positional rows. Anything richer is computed here after the rows come back:
 *  - coarser date buckets (week / month / quarter / year) are rolled up from
 *    per-day rows,
 *  - ratio metrics (completion rate, estimation accuracy, ...) divide two
 *    aggregates,
 *  - ordering and limits of rolled-up series are applied on the merged result.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The bindings {@link queryAnalytics} reads. Any worker Env with them fits. */
export interface AnalyticsQueryEnv {
  /** Bearer token for the Cloudflare R2 SQL REST API. */
  R2_SQL_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  /** Name of the R2 bucket that holds the Iceberg analytics catalog. */
  R2_ANALYTICS_BUCKET?: string;
}

export interface ChartQueryParams {
  entity: string;
  metric: string;
  timeRange: string;
  groupBy: string;
  /** Calculation for measure metrics: sum | average | count | max | min. */
  aggregation: string;
  sortOrder?: string;
  limit?: number;
  /**
   * Restrict the series to one project (WeldFlow entities only). For the
   * `project` entity this matches the project itself.
   */
  projectId?: string;
  /**
   * Restrict the series to these projects: the caller's accessible projects.
   * `undefined` / `null` means no restriction, an empty array means nothing is
   * visible and the result is empty without querying.
   */
  projectIds?: string[] | null;
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
  // Projects / WeldFlow (singular + plural)
  project: { module: 'projects', entityType: 'project' },
  projects: { module: 'projects', entityType: 'project' },
  task: { module: 'projects', entityType: 'task' },
  tasks: { module: 'projects', entityType: 'task' },
  time_entry: { module: 'projects', entityType: 'time_entry' },
  time_entries: { module: 'projects', entityType: 'time_entry' },
  milestone: { module: 'projects', entityType: 'milestone' },
  milestones: { module: 'projects', entityType: 'milestone' },
};

/**
 * Entity names (singular + plural) that belong to WeldFlow. flow-api only lets
 * these through, so a project report cannot read another module's analytics.
 */
export const WELDFLOW_ANALYTICS_ENTITIES = Object.entries(ENTITY_MODULE_MAP)
  .filter(([, info]) => info.module === 'projects')
  .map(([name]) => name) as [string, ...string[]];

// Metric → aggregate mapping (using named columns)
type AggregateFn = 'SUM' | 'AVG' | 'MIN' | 'MAX';

interface MetricSpec {
  fn: AggregateFn;
  column: string;
  /**
   * Real measures (hours, money, durations) honour the chart's "calculation"
   * option (sum / average / maximum / minimum / count). Event counters and flag
   * columns do not: the "average of count" is always 1.
   */
  measure?: boolean;
}

const METRIC_MAP: Record<string, MetricSpec> = {
  count: { fn: 'SUM', column: 'count' },
  total: { fn: 'SUM', column: 'count' },
  amount: { fn: 'SUM', column: 'amount', measure: true },
  avg_amount: { fn: 'AVG', column: 'amount' },
  duration: { fn: 'SUM', column: 'duration_seconds', measure: true },
  avg_duration: { fn: 'AVG', column: 'duration_seconds' },
  score: { fn: 'AVG', column: 'score' },
  escalated: { fn: 'SUM', column: 'is_escalated' },
  qualified: { fn: 'SUM', column: 'is_qualified' },
  converted: { fn: 'SUM', column: 'is_converted' },
  completed: { fn: 'SUM', column: 'is_completed' },
  overdue: { fn: 'SUM', column: 'is_overdue' },
  billable: { fn: 'SUM', column: 'is_billable' },
  estimated_hours: { fn: 'SUM', column: 'estimated_hours', measure: true },
  actual_hours: { fn: 'SUM', column: 'actual_hours', measure: true },
  avg_progress: { fn: 'AVG', column: 'progress' },
  avg_probability: { fn: 'AVG', column: 'probability' },
  weighted_amount: { fn: 'SUM', column: 'weighted_amount', measure: true },
  messages: { fn: 'SUM', column: 'message_count', measure: true },
  avg_response_time: { fn: 'AVG', column: 'response_time_seconds' },
  avg_resolution_time: { fn: 'AVG', column: 'resolution_time_seconds' },
};

const aggregateSql = (spec: MetricSpec): string => `${spec.fn}(${spec.column})`;

/** Applies the chart's calculation option to a measure metric. */
function withCalculation(spec: MetricSpec, aggregation: string | undefined): MetricSpec {
  if (!spec.measure) return spec;
  switch (aggregation) {
    case 'average':
    case 'avg':
      return { ...spec, fn: 'AVG' };
    case 'max':
      return { ...spec, fn: 'MAX' };
    case 'min':
      return { ...spec, fn: 'MIN' };
    case 'count':
      // The number of events behind the measure.
      return { fn: 'SUM', column: 'count' };
    default:
      return spec;
  }
}

// ---------------------------------------------------------------------------
// Compound metric resolution
// ---------------------------------------------------------------------------
// The frontend sends compound metric IDs like "total_tickets" or
// "tickets_by_status". We resolve these to a generic metric + optional
// groupBy/filter override so the SQL builder can handle them.

/** One side of a ratio: an aggregate, optionally over a narrower row set. */
interface RatioPart {
  metric: string; // key into METRIC_MAP
  filter?: Record<string, string>;
}

/** value = numerator / denominator * 100, per group. */
interface RatioSpec {
  numerator: RatioPart;
  denominator: RatioPart;
  /** Applies to both sides. */
  filter?: Record<string, string>;
}

interface ResolvedMetric {
  metric: string;           // key into METRIC_MAP
  groupByOverride?: string; // key into GROUP_BY_MAP (overrides params.groupBy)
  filterOverride?: Record<string, string>; // extra WHERE clauses
  ratio?: RatioSpec;        // when set, the metric is a percentage of two aggregates
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

  // WeldFlow — projects
  total_projects:        { metric: 'count' },
  // Align with KPI summary: non-terminal status (isActive is not available in R2 rows).
  active_projects:       { metric: 'count', filterOverride: { status: "NOT IN ('Completed','Cancelled')" } },
  projects_by_status:    { metric: 'count', groupByOverride: 'status' },
  projects_by_health:    { metric: 'count', groupByOverride: 'health' },
  projects_by_day:       { metric: 'count', groupByOverride: 'day' },
  // Share of project events recorded while the project was completed (percent).
  completion_rate:       {
    metric: 'completed',
    ratio: { numerator: { metric: 'completed' }, denominator: { metric: 'count' } },
  },
  // Spent amount only: the budget is not part of the analytics rows.
  budget_utilization:    { metric: 'amount' },
  // Actual hours as a percentage of the budgeted hours (percent).
  hours_utilization:     {
    metric: 'actual_hours',
    ratio: {
      numerator: { metric: 'actual_hours' },
      denominator: { metric: 'estimated_hours' },
      filter: { estimated_hours: '> 0' },
    },
  },
  avg_progress:          { metric: 'avg_progress' },

  // WeldFlow — tasks
  total_tasks:           { metric: 'count' },
  completed_tasks:       { metric: 'completed' },
  overdue_tasks:         { metric: 'overdue' },
  tasks_by_status:       { metric: 'count', groupByOverride: 'status' },
  tasks_by_priority:     { metric: 'count', groupByOverride: 'priority' },
  tasks_by_type:         { metric: 'count', groupByOverride: 'category' },
  throughput:            { metric: 'completed', groupByOverride: 'day' },
  // Actual hours as a percentage of the estimate, over tasks that have one (100 = on estimate).
  estimation_accuracy:   {
    metric: 'actual_hours',
    ratio: {
      numerator: { metric: 'actual_hours' },
      denominator: { metric: 'estimated_hours' },
      filter: { estimated_hours: '> 0' },
    },
  },
  tasks_by_day:          { metric: 'count', groupByOverride: 'day' },

  // WeldFlow — time entries
  total_hours:           { metric: 'actual_hours' },
  billable_hours:        { metric: 'actual_hours', filterOverride: { is_billable: '= 1' } },
  non_billable_hours:    { metric: 'actual_hours', filterOverride: { is_billable: '= 0' } },
  // Billable hours as a percentage of all logged hours (percent).
  utilization_rate:      {
    metric: 'actual_hours',
    ratio: {
      numerator: { metric: 'actual_hours', filter: { is_billable: '= 1' } },
      denominator: { metric: 'actual_hours' },
    },
  },
  total_cost:            { metric: 'amount' },
  hours_by_day:          { metric: 'actual_hours', groupByOverride: 'day' },

  // WeldFlow — milestones
  total_milestones:      { metric: 'count' },
  milestones_by_status:  { metric: 'count', groupByOverride: 'status' },
  completed_milestones:  { metric: 'completed' },
  overdue_milestones:    { metric: 'overdue' },
  // Completed milestones that were not overdue, as a percentage of all completed ones (percent).
  on_time_milestones:    {
    metric: 'completed',
    ratio: {
      numerator: { metric: 'completed', filter: { is_overdue: '= 0' } },
      denominator: { metric: 'completed' },
    },
  },
  avg_milestone_progress:{ metric: 'avg_progress' },
};

// GroupBy → column mapping (using named columns)
type DateBucket = 'day' | 'week' | 'month' | 'quarter' | 'year';

interface GroupByInfo {
  column: string;
  isDate: boolean;
  /** Date groups are queried per day and rolled up to this bucket afterwards. */
  bucket?: DateBucket;
}

const GROUP_BY_MAP: Record<string, GroupByInfo> = {
  day: { column: 'event_date', isDate: true, bucket: 'day' },
  date: { column: 'event_date', isDate: true, bucket: 'day' },
  // The analytics rows only carry a calendar date, so hourly grouping falls back to days.
  hour: { column: 'event_date', isDate: true, bucket: 'day' },
  week: { column: 'event_date', isDate: true, bucket: 'week' },
  month: { column: 'event_date', isDate: true, bucket: 'month' },
  quarter: { column: 'event_date', isDate: true, bucket: 'quarter' },
  year: { column: 'event_date', isDate: true, bucket: 'year' },
  status: { column: 'status', isDate: false },
  priority: { column: 'priority', isDate: false },
  channel: { column: 'channel', isDate: false },
  category: { column: 'category', isDate: false },
  health: { column: 'category', isDate: false },
  assignee: { column: 'assignee_id', isDate: false },
  source: { column: 'source', isDate: false },
  stage: { column: 'stage', isDate: false },
  project: { column: 'project_id', isDate: false },
};

// ---------------------------------------------------------------------------
// Time range → date filter
// ---------------------------------------------------------------------------

const isoDate = (d: Date): string => d.toISOString().split('T')[0]!;

function getDateRange(timeRange: string): { start: string; end: string } {
  const now = new Date();
  const end = new Date(now);
  const start = new Date(now);

  switch (timeRange) {
    case 'today':
      break;
    case 'yesterday':
      start.setUTCDate(start.getUTCDate() - 1);
      end.setUTCDate(end.getUTCDate() - 1);
      break;
    case 'last_7_days':
      start.setUTCDate(start.getUTCDate() - 7);
      break;
    case 'last_14_days':
      start.setUTCDate(start.getUTCDate() - 14);
      break;
    case 'last_30_days':
      start.setUTCDate(start.getUTCDate() - 30);
      break;
    case 'last_90_days':
      start.setUTCDate(start.getUTCDate() - 90);
      break;
    case 'last_180_days':
      start.setUTCDate(start.getUTCDate() - 180);
      break;
    case 'last_365_days':
      start.setUTCDate(start.getUTCDate() - 365);
      break;
    case 'this_month': {
      start.setUTCDate(1);
      break;
    }
    case 'this_quarter': {
      const quarter = Math.floor(start.getUTCMonth() / 3);
      start.setUTCMonth(quarter * 3, 1);
      break;
    }
    case 'this_year': {
      start.setUTCMonth(0, 1);
      break;
    }
    case 'last_year': {
      // The previous calendar year.
      const year = now.getUTCFullYear() - 1;
      start.setUTCFullYear(year, 0, 1);
      end.setUTCFullYear(year, 11, 31);
      break;
    }
    case 'all_time':
      return { start: '1970-01-01', end: isoDate(end) };
    default:
      start.setUTCDate(start.getUTCDate() - 30);
  }

  return { start: isoDate(start), end: isoDate(end) };
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/** Quotes a value as a SQL string literal. */
const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LIMIT = 1000;

/** `LIMIT` is interpolated into the SQL, so it only ever leaves here as a bounded integer. */
function sanitizeLimit(limit: unknown): number | undefined {
  const n = typeof limit === 'string' ? Number(limit) : limit;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return undefined;
  return Math.min(n, MAX_LIMIT);
}

/**
 * `project_id IN (...)` for the requested project scope, `null` for no scope,
 * `'none'` when nothing may be read (empty or unusable scope).
 */
function projectScopeClause(
  entityType: string,
  params: Pick<ChartQueryParams, 'projectId' | 'projectIds'>,
): string | null | 'none' {
  let ids: string[] | null = params.projectIds ?? null;
  if (params.projectId !== undefined) {
    if (ids && !ids.includes(params.projectId)) return 'none';
    ids = [params.projectId];
  }
  if (ids === null) return null;
  const safe = ids.filter((id) => SAFE_ID.test(id));
  if (safe.length === 0) return 'none';
  // Project rows describe the project itself; the other entities point at it.
  const column = entityType === 'project' ? 'entity_id' : 'project_id';
  return `${column} IN (${safe.map(sqlString).join(', ')})`;
}

interface QueryContext {
  workspaceId: string;
  module: string;
  entityType: string;
  group: GroupByInfo;
  groupColumn: string;
  start: string;
  end: string;
  scopeClause: string | null;
}

function buildSelect(
  ctx: QueryContext,
  selects: string[],
  options: {
    filters?: Record<string, string>[];
    extraWhere?: string[];
    order: { by: string; direction: 'ASC' | 'DESC' };
    limit?: number;
  },
): string {
  // R2 SQL does NOT support aliases (AS) — use raw column expressions.
  // Result columns are positional: [0]=label, [1..]=aggregates.
  const whereClauses = [
    `workspace_id = ${sqlString(ctx.workspaceId)}`,
    `module = ${sqlString(ctx.module)}`,
    `entity_type = ${sqlString(ctx.entityType)}`,
    `event_date >= ${sqlString(ctx.start)}`,
    `event_date <= ${sqlString(ctx.end)}`,
    ...(options.extraWhere ?? []),
  ];
  if (ctx.scopeClause) whereClauses.push(ctx.scopeClause);
  for (const filter of options.filters ?? []) {
    for (const [col, expr] of Object.entries(filter)) whereClauses.push(`${col} ${expr}`);
  }
  const limitClause = options.limit ? ` LIMIT ${options.limit}` : '';
  return `SELECT ${[ctx.groupColumn, ...selects].join(', ')} FROM default.weldsuite_analytics WHERE ${whereClauses.join(' AND ')} GROUP BY ${ctx.groupColumn} ORDER BY ${options.order.by} ${options.order.direction}${limitClause}`;
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

type RawRow = unknown[] | Record<string, unknown>;

interface ParsedRow {
  label: string;
  values: number[];
}

function parseRows(rows: RawRow[]): ParsedRow[] {
  return rows.map((row) => {
    const arr = Array.isArray(row) ? row : Object.values(row);
    return {
      label: String(arr[0] ?? ''),
      values: arr.slice(1).map((v) => Number(v ?? 0)),
    };
  });
}

/** Start (Monday) of the ISO week containing `date`. */
function weekStart(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return isoDate(d);
}

/** The bucket a `YYYY-MM-DD` day belongs to; labels sort chronologically. */
export function bucketLabel(day: string, bucket: DateBucket): string {
  if (bucket === 'day' || !/^\d{4}-\d{2}-\d{2}/.test(day)) return day;
  const ymd = day.slice(0, 10);
  switch (bucket) {
    case 'week':
      return weekStart(new Date(`${ymd}T00:00:00Z`));
    case 'month':
      return ymd.slice(0, 7);
    case 'quarter':
      return `${ymd.slice(0, 4)}-Q${Math.floor((Number(ymd.slice(5, 7)) - 1) / 3) + 1}`;
    case 'year':
      return ymd.slice(0, 4);
  }
}

/** Sums every value column of rows that share a label (after re-bucketing). */
function mergeRows(rows: ParsedRow[], bucket: DateBucket | undefined): ParsedRow[] {
  const merged = new Map<string, number[]>();
  for (const row of rows) {
    const label = bucket ? bucketLabel(row.label, bucket) : row.label;
    const acc = merged.get(label) ?? [];
    row.values.forEach((v, i) => {
      acc[i] = (acc[i] ?? 0) + v;
    });
    merged.set(label, acc);
  }
  return [...merged.entries()].map(([label, values]) => ({ label, values }));
}

/** Rolls per-day rows up to `bucket`, combining values the way `fn` aggregates. */
function rollUp(rows: ParsedRow[], bucket: DateBucket, fn: AggregateFn): ParsedRow[] {
  if (bucket === 'day') return rows;
  const groups = new Map<string, ParsedRow[]>();
  for (const row of rows) {
    const label = bucketLabel(row.label, bucket);
    const list = groups.get(label) ?? [];
    list.push(row);
    groups.set(label, list);
  }
  return [...groups.entries()].map(([label, list]) => {
    const values = list.map((r) => r.values[0] ?? 0);
    let value: number;
    switch (fn) {
      case 'MAX':
        value = Math.max(...values);
        break;
      case 'MIN':
        value = Math.min(...values);
        break;
      case 'AVG': {
        // Weighted by the number of events behind each day's average.
        const weights = list.map((r) => r.values[1] ?? 1);
        const totalWeight = weights.reduce((a, b) => a + b, 0);
        value =
          totalWeight > 0
            ? values.reduce((sum, v, i) => sum + v * (weights[i] ?? 1), 0) / totalWeight
            : values.reduce((a, b) => a + b, 0) / values.length;
        break;
      }
      default:
        value = values.reduce((a, b) => a + b, 0);
    }
    return { label, values: [value] };
  });
}

function sortAndLimit(
  points: ChartDataPoint[],
  isDate: boolean,
  sortOrder: string | undefined,
  limit: number | undefined,
): ChartDataPoint[] {
  const direction = sortOrder === 'desc' ? -1 : 1;
  const byDate = (a: ChartDataPoint, b: ChartDataPoint) => a.label.localeCompare(b.label);
  if (isDate) {
    // A limit on a time series keeps the most recent buckets (not the oldest),
    // shown in the requested order.
    const recent = limit ? [...points].sort((a, b) => byDate(b, a)).slice(0, limit) : points;
    return [...recent].sort((a, b) => direction * byDate(a, b));
  }
  const sorted = [...points].sort((a, b) => direction * (a.value - b.value));
  return limit ? sorted.slice(0, limit) : sorted;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Query planning
// ---------------------------------------------------------------------------

/** The SQL to run for one chart and how to turn its rows into data points. */
export interface ChartPlan {
  queries: string[];
  /** `results[i]` holds the raw rows of `queries[i]`. */
  finish: (results: RawRow[][]) => ChartDataPoint[];
}

const EMPTY_PLAN: ChartPlan = { queries: [], finish: () => [] };

export function planChartQuery(workspaceId: string, params: ChartQueryParams): ChartPlan {
  const entityInfo = ENTITY_MODULE_MAP[params.entity];
  if (!entityInfo) {
    throw new Error(`Unknown entity: ${params.entity}`);
  }

  // Resolve compound metric (e.g. "total_tickets" → metric "count")
  const compound = COMPOUND_METRICS[params.metric];
  const resolvedMetricKey = compound?.metric ?? params.metric;
  const resolvedGroupByKey = compound?.groupByOverride ?? params.groupBy;

  const baseSpec = METRIC_MAP[resolvedMetricKey];
  if (!baseSpec) {
    throw new Error(`Unknown metric: ${params.metric} (resolved: ${resolvedMetricKey})`);
  }

  const groupByInfo = GROUP_BY_MAP[resolvedGroupByKey];
  if (!groupByInfo) {
    throw new Error(`Unknown groupBy: ${resolvedGroupByKey}`);
  }

  const scopeClause = projectScopeClause(entityInfo.entityType, params);
  if (scopeClause === 'none') return EMPTY_PLAN;

  const { start, end } = getDateRange(params.timeRange);
  const ctx: QueryContext = {
    workspaceId,
    module: entityInfo.module,
    entityType: entityInfo.entityType,
    group: groupByInfo,
    groupColumn: groupByInfo.column,
    start,
    end,
    scopeClause,
  };
  const limit = sanitizeLimit(params.limit);
  const direction = params.sortOrder === 'desc' ? 'DESC' : 'ASC';
  const bucket = groupByInfo.isDate ? groupByInfo.bucket ?? 'day' : undefined;
  const rolledUp = bucket !== undefined && bucket !== 'day';

  if (compound?.ratio) {
    return planRatio(ctx, compound.ratio, { bucket, isDate: groupByInfo.isDate, sortOrder: params.sortOrder, limit });
  }

  // A plain aggregate over one metric column.
  const spec = withCalculation(baseSpec, params.aggregation);
  const selects = [aggregateSql(spec)];
  // Averages rolled up to a coarser bucket need the event count as their weight.
  if (rolledUp && spec.fn === 'AVG') selects.push('SUM(count)');

  // For count-based metrics on time series, only count 'created' events.
  const extraWhere =
    ['count', 'total'].includes(resolvedMetricKey) && groupByInfo.isDate ? [`action = 'created'`] : [];

  const query = buildSelect(ctx, selects, {
    filters: compound?.filterOverride ? [compound.filterOverride] : [],
    extraWhere,
    // A time series with a limit asks for its most recent days; rolled-up series
    // are limited after merging the per-day rows.
    order: groupByInfo.isDate
      ? { by: groupByInfo.column, direction: limit && !rolledUp ? 'DESC' : 'ASC' }
      : { by: aggregateSql(spec), direction },
    limit: rolledUp ? undefined : limit,
  });

  return {
    queries: [query],
    finish: ([rows = []]) => {
      let parsed = parseRows(rows);
      if (rolledUp && bucket) parsed = rollUp(parsed, bucket, spec.fn);
      const points = parsed.map((r) => ({ label: r.label, value: r.values[0] ?? 0 }));
      return groupByInfo.isDate ? sortAndLimit(points, true, params.sortOrder, limit) : points;
    },
  };
}

function planRatio(
  ctx: QueryContext,
  ratio: RatioSpec,
  shape: { bucket: DateBucket | undefined; isDate: boolean; sortOrder: string | undefined; limit: number | undefined },
): ChartPlan {
  const numerator = METRIC_MAP[ratio.numerator.metric];
  const denominator = METRIC_MAP[ratio.denominator.metric];
  if (!numerator || !denominator) {
    throw new Error(`Unknown ratio metric: ${ratio.numerator.metric} / ${ratio.denominator.metric}`);
  }

  const numFilter = { ...ratio.filter, ...ratio.numerator.filter };
  const denFilter = { ...ratio.filter, ...ratio.denominator.filter };
  const sameFilter = JSON.stringify(numFilter) === JSON.stringify(denFilter);
  const order = { by: ctx.groupColumn, direction: 'ASC' as const };

  // One query when both sides read the same rows, otherwise one per side.
  const queries = sameFilter
    ? [buildSelect(ctx, [aggregateSql(numerator), aggregateSql(denominator)], { filters: [numFilter], order })]
    : [
        buildSelect(ctx, [aggregateSql(numerator)], { filters: [numFilter], order }),
        buildSelect(ctx, [aggregateSql(denominator)], { filters: [denFilter], order }),
      ];

  return {
    queries,
    finish: (results) => {
      const sums = new Map<string, { num: number; den: number }>();
      const add = (rows: ParsedRow[], side: (v: number[]) => { num?: number; den?: number }) => {
        for (const row of mergeRows(rows, shape.bucket)) {
          const part = side(row.values);
          const acc = sums.get(row.label) ?? { num: 0, den: 0 };
          acc.num += part.num ?? 0;
          acc.den += part.den ?? 0;
          sums.set(row.label, acc);
        }
      };
      if (sameFilter) {
        add(parseRows(results[0] ?? []), (v) => ({ num: v[0], den: v[1] }));
      } else {
        add(parseRows(results[0] ?? []), (v) => ({ num: v[0] }));
        add(parseRows(results[1] ?? []), (v) => ({ den: v[0] }));
      }

      const points = [...sums.entries()].map(([label, { num, den }]) => ({
        label,
        value: den > 0 ? round2((num / den) * 100) : 0,
      }));
      return sortAndLimit(points, shape.isDate, shape.sortOrder, shape.limit);
    },
  };
}

// ---------------------------------------------------------------------------
// Query executor
// ---------------------------------------------------------------------------

async function runR2Sql(
  endpoint: string,
  token: string,
  sql: string,
): Promise<RawRow[]> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`R2 SQL API error ${response.status}: ${text}`);
  }

  const raw = (await response.json()) as { result?: { rows?: RawRow[] } };
  return raw.result?.rows ?? [];
}

export async function queryAnalytics(
  env: AnalyticsQueryEnv,
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
    const plan = planChartQuery(workspaceId, params);
    if (plan.queries.length === 0) return [];
    const endpoint = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${accountId}/r2-sql/query/${bucket}`;
    const results = await Promise.all(plan.queries.map((sql) => runR2Sql(endpoint, token, sql)));
    return plan.finish(results);
  } catch (err) {
    console.error('[Analytics] Query failed:', err);
    return [];
  }
}
