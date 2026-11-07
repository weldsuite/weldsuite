/**
 * WeldDesk reports on the live inbox (ADR DESK-011): the overview a team lead
 * opens and the data behind the report builder's charts, aggregated from the
 * tenant database (desk_conversations, desk_messages, desk_sla_clocks).
 *
 * Periods are whole UTC days, `start` inclusive and `end` exclusive, so the
 * same request gives the same answer all day. Every value is computed and
 * rounded in SQL; the Rust backend (rust/modules/desk/src/settings/reports.rs)
 * runs the same statements, so both answer alike.
 *
 * Units: overview durations are whole seconds; chart values are minutes
 * (first response), hours (resolution) or percentages, to one decimal.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';

// ── Periods ─────────────────────────────────────────────────────────────────

export const DESK_REPORT_RANGES = [
  'today',
  'yesterday',
  'last_7_days',
  'last_14_days',
  'last_30_days',
  'last_90_days',
  'last_180_days',
  'last_365_days',
  'this_month',
  'this_quarter',
  'this_year',
  'last_year',
  'all_time',
] as const;

export type DeskReportRange = (typeof DESK_REPORT_RANGES)[number];

const DEFAULT_RANGE: DeskReportRange = 'last_30_days';
const DAY_MS = 86_400_000;

export interface DeskReportPeriod {
  range: DeskReportRange;
  /** UTC midnight, inclusive. */
  start: Date;
  /** UTC midnight, exclusive. */
  end: Date;
}

export function deskReportRangeOf(value: unknown): DeskReportRange {
  return (DESK_REPORT_RANGES as readonly string[]).includes(value as string) ? (value as DeskReportRange) : DEFAULT_RANGE;
}

const LAST_DAYS: Partial<Record<DeskReportRange, number>> = {
  last_7_days: 7,
  last_14_days: 14,
  last_30_days: 30,
  last_90_days: 90,
  last_180_days: 180,
  last_365_days: 365,
};

/**
 * The days a range covers on `now`'s UTC calendar. `all_time` starts on the
 * day of `firstActivity` (the oldest conversation), today when there is none.
 */
export function deskReportPeriod(range: DeskReportRange, now: Date, firstActivity: Date | null): DeskReportPeriod {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const tomorrow = today + DAY_MS;
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const period = (start: number, end: number = tomorrow): DeskReportPeriod => ({
    range,
    start: new Date(start),
    end: new Date(end),
  });
  const lastDays = LAST_DAYS[range];
  if (lastDays) return period(today - (lastDays - 1) * DAY_MS);
  switch (range) {
    case 'today':
      return period(today);
    case 'yesterday':
      return period(today - DAY_MS, today);
    case 'this_month':
      return period(Date.UTC(year, month, 1));
    case 'this_quarter':
      return period(Date.UTC(year, month - (month % 3), 1));
    case 'this_year':
      return period(Date.UTC(year, 0, 1));
    case 'last_year':
      return period(Date.UTC(year - 1, 0, 1), Date.UTC(year, 0, 1));
    case 'all_time': {
      const first = firstActivity ? Math.floor(firstActivity.getTime() / DAY_MS) * DAY_MS : today;
      return period(Math.min(first, today));
    }
    default:
      return period(today - 29 * DAY_MS);
  }
}

/** The period of the same length just before `period` (for "vs. previous"). */
export function previousDeskReportPeriod(period: DeskReportPeriod): DeskReportPeriod {
  const length = period.end.getTime() - period.start.getTime();
  return { range: period.range, start: new Date(period.start.getTime() - length), end: period.start };
}

const dateKey = (d: Date) => d.toISOString().slice(0, 10);

// ── Buckets ─────────────────────────────────────────────────────────────────

export type DeskReportUnit = 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

const UNITS: DeskReportUnit[] = ['hour', 'day', 'week', 'month', 'quarter', 'year'];

/** Approximate length, only to keep a series under {@link MAX_BUCKETS}. */
const UNIT_MS: Record<DeskReportUnit, number> = {
  hour: 3_600_000,
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  quarter: 91 * DAY_MS,
  year: 365 * DAY_MS,
};

const UNIT_INTERVAL: Record<DeskReportUnit, string> = {
  hour: '1 hour',
  day: '1 day',
  week: '1 week',
  month: '1 month',
  quarter: '3 months',
  year: '1 year',
};

/** Labels sort chronologically; the same as the analytics pipeline's (bucketLabel). */
const UNIT_LABEL: Record<DeskReportUnit, string> = {
  hour: 'YYYY-MM-DD"T"HH24":00"',
  day: 'YYYY-MM-DD',
  week: 'YYYY-MM-DD',
  month: 'YYYY-MM',
  quarter: 'YYYY-"Q"Q',
  year: 'YYYY',
};

const MAX_BUCKETS = 1000;

/** The unit asked for, made coarser until the period fits in {@link MAX_BUCKETS}. */
export function deskReportUnit(groupBy: string, period: DeskReportPeriod): DeskReportUnit {
  const span = period.end.getTime() - period.start.getTime();
  const asked = UNITS.indexOf(groupBy as DeskReportUnit);
  let index = asked === -1 ? UNITS.indexOf('day') : asked;
  while (index < UNITS.length - 1 && Math.ceil(span / UNIT_MS[UNITS[index]!]) > MAX_BUCKETS) index++;
  return UNITS[index]!;
}

/** The overview's series: days up to three months, weeks up to a year, then months. */
export function deskOverviewUnit(period: DeskReportPeriod): DeskReportUnit {
  const days = (period.end.getTime() - period.start.getTime()) / DAY_MS;
  if (days <= 92) return 'day';
  if (days <= 371) return 'week';
  return 'month';
}

/** A whitelisted constant (a unit, a label format, an interval) as a SQL string literal. */
const literal = (text: string) => sql.raw(`'${text}'`);
const trunc = (unit: DeskReportUnit, column: SQL) => sql`date_trunc(${literal(unit)}, ${column})`;
const labelOf = (unit: DeskReportUnit, column: SQL) => sql`to_char(${column}, ${literal(UNIT_LABEL[unit])})`;

/** `generate_series` over the period's buckets, as `buckets(bucket)`. */
function bucketsCte(unit: DeskReportUnit, period: DeskReportPeriod): SQL {
  return sql`buckets as (
    select generate_series(
      ${trunc(unit, sql`${period.start.toISOString()}::timestamp`)},
      ${period.end.toISOString()}::timestamp - interval '1 millisecond',
      interval ${literal(UNIT_INTERVAL[unit])}
    ) as bucket
  )`;
}

// ── Execution ───────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

async function rowsOf(db: Database, query: SQL): Promise<Row[]> {
  const result = await db.execute(query);
  return ((result as unknown as { rows?: Row[] }).rows ?? (result as unknown as Row[])) || [];
}

const num = (value: unknown): number => (value == null ? 0 : Number(value));
const numOrNull = (value: unknown): number | null => (value == null ? null : Number(value));
const text = (value: unknown): string => (value == null ? '' : String(value));

/** The day of the oldest conversation, for `all_time`. */
async function firstActivity(db: Database): Promise<Date | null> {
  const [row] = await rowsOf(db, sql`select to_char(min(created_at), 'YYYY-MM-DD') as first from desk_conversations`);
  const first = row?.first;
  return first == null ? null : new Date(`${String(first)}T00:00:00.000Z`);
}

export async function resolveDeskReportPeriod(db: Database, rangeValue: unknown, now: Date): Promise<DeskReportPeriod> {
  const range = deskReportRangeOf(rangeValue);
  return deskReportPeriod(range, now, range === 'all_time' ? await firstActivity(db) : null);
}

const inPeriod = (column: SQL, period: DeskReportPeriod) =>
  sql`(${column} >= ${period.start.toISOString()}::timestamp and ${column} < ${period.end.toISOString()}::timestamp)`;

// ── Chart data (the report builder) ─────────────────────────────────────────

export interface DeskChartQuery {
  entity?: string;
  metric: string;
  timeRange: string;
  groupBy: string;
  aggregation?: string;
  sortOrder?: string;
  limit?: number;
}

export interface DeskChartPoint {
  label: string;
  value: number;
}

/** What a chart reads: the rows, the time column a period filters on, and the dimension joins. */
type Source = 'conversations' | 'agent_replies' | 'sla_clocks';

interface SourceSpec {
  from: SQL;
}

const SOURCES: Record<Source, SourceSpec> = {
  conversations: { from: sql`desk_conversations c` },
  agent_replies: {
    from: sql`desk_messages m join desk_conversations c on c.id = m.conversation_id`,
  },
  sla_clocks: { from: sql`desk_sla_clocks s join desk_conversations c on c.id = s.conversation_id` },
};

type Dimension = 'state' | 'priority' | 'channel' | 'type' | 'team' | 'assignee' | 'author' | 'rating' | 'customer' | 'sla_metric';

interface DimensionSpec {
  join?: SQL;
  /** Grouped on; the label is taken per key. */
  key: SQL;
  label: SQL;
  /** Listed in the key's own order (1 to 5 stars), not by value. */
  ordered?: boolean;
}

const CUSTOMER_KEY = sql`coalesce(c.contact_id, c.visitor_id, lower(c.email), c.id)`;

const DIMENSIONS: Record<Dimension, DimensionSpec> = {
  state: { key: sql`c.state`, label: sql`c.state` },
  priority: { key: sql`coalesce(c.priority, 'none')`, label: sql`coalesce(c.priority, 'none')` },
  channel: { key: sql`c.channel`, label: sql`c.channel` },
  type: {
    join: sql`left join helpdesk_ticket_types tt on tt.id = c.ticket_type_id`,
    key: sql`c.ticket_type_id`,
    label: sql`coalesce(max(tt.name), '')`,
  },
  team: {
    join: sql`left join helpdesk_departments dp on dp.id = c.department_id`,
    key: sql`c.department_id`,
    label: sql`coalesce(max(dp.name), '')`,
  },
  assignee: {
    join: sql`left join workspace_members wm on wm.user_id = c.assignee_id`,
    key: sql`c.assignee_id`,
    label: sql`coalesce(max(wm.name), max(wm.email), c.assignee_id, '')`,
  },
  author: {
    join: sql`left join workspace_members wm on wm.user_id = m.author_id`,
    key: sql`m.author_id`,
    label: sql`coalesce(max(wm.name), max(wm.email), m.author_id, '')`,
  },
  rating: { key: sql`c.rating`, label: sql`coalesce(c.rating::text, '')`, ordered: true },
  customer: { key: CUSTOMER_KEY, label: sql`coalesce(max(c.name), max(c.email), '')` },
  sla_metric: { key: sql`s.metric`, label: sql`s.metric` },
};

/** How the value of a group is computed. */
type Measure =
  | { kind: 'count' }
  | { kind: 'distinct'; expr: SQL }
  /** A duration in seconds, shown in `unit`; honours the chart's calculation (average, max, min, count). */
  | { kind: 'duration'; column: SQL; unit: 'minutes' | 'hours' }
  | { kind: 'average'; expr: SQL }
  /** Share of the rows where `when` holds, among those where `of` holds (all rows by default). */
  | { kind: 'percent'; when: SQL; of?: SQL };

interface MetricSpec {
  source: Source;
  /** The time column the period filters on (and series bucket by). */
  time: SQL;
  filter?: SQL;
  measure: Measure;
  /** Grouped on this instead of time. */
  dimension?: Dimension;
  /** Series always in this unit (the `*_by_day` metrics). */
  unit?: DeskReportUnit;
}

const CREATED = sql`c.created_at`;
const RESOLVED = sql`c.resolved_at`;
const ANSWERED = sql`c.first_response_at`;
const RATED = sql`c.rated_at`;
const REPLIED = sql`m.created_at`;
const CLOCK_STARTED = sql`s.started_at`;

const FIRST_RESPONSE: Measure = { kind: 'duration', column: sql`c.first_response_seconds`, unit: 'minutes' };
const RESOLUTION: Measure = { kind: 'duration', column: sql`c.resolution_seconds`, unit: 'hours' };
const CSAT: Measure = { kind: 'percent', when: sql`c.rating >= 4` };
const SLA_MET: Measure = {
  kind: 'percent',
  when: sql`s.status = 'completed' and s.breached_at is null`,
  of: sql`(s.status = 'completed' and s.breached_at is null) or s.breached_at is not null`,
};
const AGENT_REPLY = sql`m.kind = 'message' and m.author_type = 'agent'`;
const PUBLIC_MESSAGES = sql`(select count(*) from desk_messages pm where pm.conversation_id = c.id and pm.kind = 'message' and pm.author_type in ('visitor', 'agent'))`;
const BREACHED = sql`exists (select 1 from desk_sla_clocks bs where bs.conversation_id = c.id and bs.breached_at is not null)`;

const ticketsCreated: MetricSpec = { source: 'conversations', time: CREATED, measure: { kind: 'count' } };
const ticketsOpen: MetricSpec = { ...ticketsCreated, filter: sql`c.state = 'open'` };
const byDay = (spec: MetricSpec): MetricSpec => ({ ...spec, unit: 'day' });
const by = (dimension: Dimension, spec: MetricSpec = ticketsCreated): MetricSpec => ({ ...spec, dimension });
const firstResponse: MetricSpec = { source: 'conversations', time: ANSWERED, measure: FIRST_RESPONSE, filter: sql`c.first_response_seconds is not null` };
const resolution: MetricSpec = { source: 'conversations', time: RESOLVED, measure: RESOLUTION, filter: sql`c.resolution_seconds is not null` };
const resolved: MetricSpec = { source: 'conversations', time: RESOLVED, measure: { kind: 'count' } };
const csat: MetricSpec = { source: 'conversations', time: RATED, measure: CSAT, filter: sql`c.rating is not null` };
const slaCompliance: MetricSpec = { source: 'sla_clocks', time: CLOCK_STARTED, measure: SLA_MET };
const agentReplies: MetricSpec = { source: 'agent_replies', time: REPLIED, filter: AGENT_REPLY, measure: { kind: 'count' } };

/**
 * The report builder's metrics. The old ids (the analytics pipeline's) stay
 * as aliases, so saved charts keep their data; a metric not listed answers
 * an empty series.
 */
export const DESK_CHART_METRICS: Record<string, MetricSpec> = {
  // Tickets (a conversation is the ticket, DESK-007)
  tickets_created: ticketsCreated,
  tickets_resolved: resolved,
  tickets_open: ticketsOpen,
  tickets_by_status: by('state'),
  tickets_by_priority: by('priority'),
  tickets_by_channel: by('channel'),
  tickets_by_type: by('type'),
  tickets_by_team: by('team'),
  sla_breached_tickets: { ...ticketsCreated, filter: BREACHED },
  avg_messages: { source: 'conversations', time: CREATED, measure: { kind: 'average', expr: PUBLIC_MESSAGES } },
  // Customers
  total_customers: { source: 'conversations', time: CREATED, measure: { kind: 'distinct', expr: CUSTOMER_KEY } },
  new_customers: {
    source: 'conversations',
    time: CREATED,
    filter: sql`not exists (select 1 from desk_conversations pc where coalesce(pc.contact_id, pc.visitor_id, lower(pc.email), pc.id) = ${CUSTOMER_KEY} and pc.created_at < c.created_at)`,
    measure: { kind: 'distinct', expr: CUSTOMER_KEY },
  },
  returning_customers: {
    source: 'conversations',
    time: CREATED,
    filter: sql`exists (select 1 from desk_conversations pc where coalesce(pc.contact_id, pc.visitor_id, lower(pc.email), pc.id) = ${CUSTOMER_KEY} and pc.created_at < c.created_at)`,
    measure: { kind: 'distinct', expr: CUSTOMER_KEY },
  },
  top_customers: by('customer'),
  // Agents
  agents_replying: { ...agentReplies, measure: { kind: 'distinct', expr: sql`m.author_id` } },
  tickets_per_agent: by('assignee'),
  resolved_per_agent: by('assignee', resolved),
  replies_per_agent: by('author', agentReplies),
  agent_response_time: by('assignee', firstResponse),
  // Response and resolution times
  avg_first_response: firstResponse,
  avg_resolution_time: resolution,
  response_by_priority: by('priority', firstResponse),
  resolution_by_priority: by('priority', resolution),
  sla_compliance: slaCompliance,
  sla_compliance_by_metric: by('sla_metric', slaCompliance),
  // Satisfaction (the 1–5 rating after a close; 4 and 5 are satisfied)
  csat_score: csat,
  avg_rating: { ...csat, measure: { kind: 'average', expr: sql`c.rating` } },
  ratings_distribution: by('rating', { ...csat, measure: { kind: 'count' } }),
  satisfaction_by_agent: by('assignee', csat),
};

const ALIASES: Record<string, string> = {
  total_tickets: 'tickets_created',
  total_conversations: 'tickets_created',
  tickets_by_day: 'tickets_created_by_day',
  conversations_by_day: 'tickets_created_by_day',
  closed_tickets: 'tickets_resolved',
  open_tickets: 'tickets_open',
  active_conversations: 'tickets_open',
  conversations_by_channel: 'tickets_by_channel',
  escalated_tickets: 'sla_breached_tickets',
  customers_by_tickets: 'top_customers',
  total_agents: 'agents_replying',
  active_agents: 'agents_replying',
  agent_performance: 'resolved_per_agent',
  response_time_trend: 'avg_first_response_by_day',
  satisfaction_trend: 'csat_score_by_day',
};

const BY_DAY: Record<string, MetricSpec> = {
  tickets_created_by_day: byDay(ticketsCreated),
  avg_first_response_by_day: byDay(firstResponse),
  csat_score_by_day: byDay(csat),
};

export function deskChartMetric(metric: string): MetricSpec | undefined {
  const id = ALIASES[metric] ?? metric;
  return DESK_CHART_METRICS[id] ?? BY_DAY[id];
}

/** The SQL value of a measure (rounded where it is not a count). */
function valueSql(measure: Measure, aggregation: string | undefined): SQL {
  switch (measure.kind) {
    case 'count':
      return sql`count(*)::float8`;
    case 'distinct':
      return sql`count(distinct ${measure.expr})::float8`;
    case 'average':
      return sql`round(avg(${measure.expr})::numeric, 1)::float8`;
    case 'percent': {
      const of = measure.of ?? sql`true`;
      return sql`round(100.0 * count(*) filter (where ${measure.when}) / nullif(count(*) filter (where ${of}), 0), 1)::float8`;
    }
    case 'duration': {
      if (aggregation === 'count') return sql`count(${measure.column})::float8`;
      const divisor = sql.raw(measure.unit === 'hours' ? '3600.0' : '60.0');
      let fn = 'avg';
      if (aggregation === 'max') fn = 'max';
      else if (aggregation === 'min') fn = 'min';
      return sql`round((${sql.raw(fn)}(${measure.column}) / ${divisor})::numeric, 1)::float8`;
    }
  }
}

/** Counts are 0 where a bucket has no rows; averages and shares are left out there. */
const countLike = (measure: Measure, aggregation: string | undefined) =>
  measure.kind === 'count' || measure.kind === 'distinct' || (measure.kind === 'duration' && aggregation === 'count');

function whereOf(spec: MetricSpec, period: DeskReportPeriod): SQL {
  return spec.filter ? sql`${inPeriod(spec.time, period)} and ${spec.filter}` : inPeriod(spec.time, period);
}

const MAX_LIMIT = 1000;

function limitOf(limit: unknown): number | undefined {
  const n = typeof limit === 'string' ? Number(limit) : limit;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return undefined;
  return Math.min(n, MAX_LIMIT);
}

async function seriesData(
  db: Database,
  spec: MetricSpec,
  query: DeskChartQuery,
  period: DeskReportPeriod,
): Promise<DeskChartPoint[]> {
  const unit = spec.unit ?? deskReportUnit(query.groupBy, period);
  const value = valueSql(spec.measure, query.aggregation);
  const rows = await rowsOf(
    db,
    sql`with ${bucketsCte(unit, period)},
      data as (
        select ${trunc(unit, spec.time)} as bucket, ${value} as value
        from ${SOURCES[spec.source].from}
        where ${whereOf(spec, period)}
        group by 1
      )
      select ${labelOf(unit, sql`b.bucket`)} as label, d.value
      from buckets b left join data d on d.bucket = b.bucket
      order by b.bucket`,
  );
  const fill = countLike(spec.measure, query.aggregation);
  let points = rows
    .filter((row) => fill || row.value != null)
    .map((row) => ({ label: text(row.label), value: num(row.value) }));
  // A limit keeps the most recent buckets, in the order asked for.
  const limit = limitOf(query.limit);
  if (limit && points.length > limit) points = points.slice(points.length - limit);
  return query.sortOrder === 'desc' ? points.reverse() : points;
}

async function dimensionData(
  db: Database,
  spec: MetricSpec & { dimension: Dimension },
  query: DeskChartQuery,
  period: DeskReportPeriod,
): Promise<DeskChartPoint[]> {
  const dimension = DIMENSIONS[spec.dimension];
  const value = valueSql(spec.measure, query.aggregation);
  const direction = sql.raw(query.sortOrder === 'desc' ? 'desc' : 'asc');
  const order = dimension.ordered ? sql`${dimension.key} ${direction}` : sql`2 ${direction}, 1 asc`;
  const limit = limitOf(query.limit);
  const limitClause = limit ? sql`limit ${sql.raw(String(limit))}` : sql.empty();
  const rows = await rowsOf(
    db,
    sql`select ${dimension.label} as label, ${value} as value
      from ${SOURCES[spec.source].from} ${dimension.join ?? sql.empty()}
      where ${whereOf(spec, period)}
      group by ${dimension.key}
      having ${value} is not null
      order by ${order}
      ${limitClause}`,
  );
  return rows.map((row) => ({ label: text(row.label), value: num(row.value) }));
}

/** One chart's data points; an unknown metric is an empty series. */
export async function deskChartData(db: Database, query: DeskChartQuery, now: Date): Promise<DeskChartPoint[]> {
  const spec = deskChartMetric(query.metric);
  if (!spec) return [];
  const period = await resolveDeskReportPeriod(db, query.timeRange, now);
  if (spec.dimension) return dimensionData(db, spec as MetricSpec & { dimension: Dimension }, query, period);
  return seriesData(db, spec, query, period);
}

// ── Overview ────────────────────────────────────────────────────────────────

export interface DeskReportPair<T> {
  value: T;
  previous: T;
}

export interface DeskReportPerson {
  id: string | null;
  name: string;
  created: number;
  resolved: number;
  /** Seconds. */
  firstResponseAvg: number | null;
  /** Seconds. */
  resolutionAvg: number | null;
  ratings: number;
  /** Percent of ratings that were 4 or 5. */
  csat: number | null;
}

export interface DeskReportsOverview {
  range: { key: DeskReportRange; start: string; end: string; bucket: DeskReportUnit };
  kpis: {
    created: DeskReportPair<number>;
    resolved: DeskReportPair<number>;
    firstResponseAvg: DeskReportPair<number | null>;
    firstResponseMedian: DeskReportPair<number | null>;
    resolutionAvg: DeskReportPair<number | null>;
    resolutionMedian: DeskReportPair<number | null>;
    slaCompliance: DeskReportPair<number | null>;
    csat: DeskReportPair<number | null>;
  };
  /** Now, whatever the period: open, of those unassigned, and waiting on the team. */
  backlog: { open: number; unassigned: number; waiting: number };
  counts: { firstResponses: number; resolutions: number; slaMet: number; slaBreached: number; ratings: number; ratingAverage: number | null };
  series: Array<{ label: string; created: number; resolved: number; firstResponseAvg: number | null; resolutionAvg: number | null }>;
  byChannel: Array<{ key: string; count: number }>;
  byPriority: Array<{ key: string; count: number }>;
  agents: DeskReportPerson[];
  teams: DeskReportPerson[];
}

const PEOPLE_LIMIT = 50;

/** The KPI aggregates of one period, as SQL select items suffixed `_<suffix>`. */
function kpiColumns(period: DeskReportPeriod, suffix: string): SQL {
  const s = sql.raw(suffix);
  const created = inPeriod(CREATED, period);
  const resolvedIn = inPeriod(RESOLVED, period);
  const answered = sql`${inPeriod(ANSWERED, period)} and c.first_response_seconds is not null`;
  const resolution = sql`${resolvedIn} and c.resolution_seconds is not null`;
  const rated = sql`${inPeriod(RATED, period)} and c.rating is not null`;
  return sql`
    count(*) filter (where ${created})::int as created_${s},
    count(*) filter (where ${resolvedIn})::int as resolved_${s},
    count(*) filter (where ${answered})::int as answered_${s},
    round(avg(c.first_response_seconds) filter (where ${answered}))::int as frt_avg_${s},
    round(percentile_cont(0.5) within group (order by c.first_response_seconds) filter (where ${answered}))::int as frt_median_${s},
    count(*) filter (where ${resolution})::int as resolutions_${s},
    round(avg(c.resolution_seconds) filter (where ${resolution}))::int as res_avg_${s},
    round(percentile_cont(0.5) within group (order by c.resolution_seconds) filter (where ${resolution}))::int as res_median_${s},
    count(*) filter (where ${rated})::int as ratings_${s},
    round(100.0 * count(*) filter (where ${rated} and c.rating >= 4) / nullif(count(*) filter (where ${rated}), 0), 1)::float8 as csat_${s},
    round(avg(c.rating) filter (where ${rated})::numeric, 2)::float8 as rating_avg_${s}`;
}

/** Rows the overview can touch: active in either period, or open now. */
function touched(since: Date): SQL {
  const at = sql`${since.toISOString()}::timestamp`;
  return sql`(c.state = 'open' or c.created_at >= ${at} or c.resolved_at >= ${at} or c.first_response_at >= ${at} or c.rated_at >= ${at})`;
}

async function people(
  db: Database,
  period: DeskReportPeriod,
  group: 'assignee' | 'team',
): Promise<DeskReportPerson[]> {
  const created = inPeriod(CREATED, period);
  const resolvedIn = inPeriod(RESOLVED, period);
  const answered = sql`${inPeriod(ANSWERED, period)} and c.first_response_seconds is not null`;
  const resolution = sql`${resolvedIn} and c.resolution_seconds is not null`;
  const rated = sql`${inPeriod(RATED, period)} and c.rating is not null`;
  const dimension = DIMENSIONS[group === 'assignee' ? 'assignee' : 'team'];
  const rows = await rowsOf(
    db,
    sql`select ${dimension.key} as id, ${dimension.label} as name,
        count(*) filter (where ${created})::int as created,
        count(*) filter (where ${resolvedIn})::int as resolved,
        round(avg(c.first_response_seconds) filter (where ${answered}))::int as frt_avg,
        round(avg(c.resolution_seconds) filter (where ${resolution}))::int as res_avg,
        count(*) filter (where ${rated})::int as ratings,
        round(100.0 * count(*) filter (where ${rated} and c.rating >= 4) / nullif(count(*) filter (where ${rated}), 0), 1)::float8 as csat
      from desk_conversations c ${dimension.join ?? sql.empty()}
      where (${created} or ${resolvedIn} or ${inPeriod(ANSWERED, period)} or ${inPeriod(RATED, period)})
      group by ${dimension.key}
      order by 4 desc, 3 desc, 2 asc
      limit ${sql.raw(String(PEOPLE_LIMIT))}`,
  );
  return rows.map((row) => ({
    id: row.id == null ? null : String(row.id),
    name: text(row.name),
    created: num(row.created),
    resolved: num(row.resolved),
    firstResponseAvg: numOrNull(row.frt_avg),
    resolutionAvg: numOrNull(row.res_avg),
    ratings: num(row.ratings),
    csat: numOrNull(row.csat),
  }));
}

async function countsBy(db: Database, period: DeskReportPeriod, column: SQL): Promise<Array<{ key: string; count: number }>> {
  const rows = await rowsOf(
    db,
    sql`select ${column} as key, count(*)::int as count
      from desk_conversations c
      where ${inPeriod(CREATED, period)}
      group by 1
      order by 2 desc, 1 asc`,
  );
  return rows.map((row) => ({ key: text(row.key), count: num(row.count) }));
}

export async function deskReportsOverview(db: Database, rangeValue: unknown, now: Date): Promise<DeskReportsOverview> {
  const period = await resolveDeskReportPeriod(db, rangeValue, now);
  const previous = previousDeskReportPeriod(period);
  const unit = deskOverviewUnit(period);

  const [totalsRows, slaRows, seriesRows, byChannel, byPriority, agents, teams] = await Promise.all([
    rowsOf(
      db,
      sql`select ${kpiColumns(period, 'cur')}, ${kpiColumns(previous, 'prev')},
          count(*) filter (where c.state = 'open')::int as open,
          count(*) filter (where c.state = 'open' and c.assignee_id is null)::int as unassigned,
          count(*) filter (where c.state = 'open' and c.waiting_since is not null)::int as waiting
        from desk_conversations c
        where ${touched(previous.start)}`,
    ),
    rowsOf(
      db,
      sql`select met_cur, breached_cur,
          round(100.0 * met_cur / nullif(met_cur + breached_cur, 0), 1)::float8 as rate_cur,
          round(100.0 * met_prev / nullif(met_prev + breached_prev, 0), 1)::float8 as rate_prev
        from (
          select
            count(*) filter (where ${inPeriod(CLOCK_STARTED, period)} and s.status = 'completed' and s.breached_at is null)::int as met_cur,
            count(*) filter (where ${inPeriod(CLOCK_STARTED, period)} and s.breached_at is not null)::int as breached_cur,
            count(*) filter (where ${inPeriod(CLOCK_STARTED, previous)} and s.status = 'completed' and s.breached_at is null)::int as met_prev,
            count(*) filter (where ${inPeriod(CLOCK_STARTED, previous)} and s.breached_at is not null)::int as breached_prev
          from desk_sla_clocks s
          where s.started_at >= ${previous.start.toISOString()}::timestamp and s.started_at < ${period.end.toISOString()}::timestamp
        ) clocks`,
    ),
    rowsOf(
      db,
      sql`with ${bucketsCte(unit, period)},
        created as (
          select ${trunc(unit, CREATED)} as bucket, count(*)::int as n
          from desk_conversations c where ${inPeriod(CREATED, period)} group by 1
        ),
        resolved as (
          select ${trunc(unit, RESOLVED)} as bucket, count(*)::int as n,
            round(avg(c.resolution_seconds))::int as avg
          from desk_conversations c where ${inPeriod(RESOLVED, period)} group by 1
        ),
        answered as (
          select ${trunc(unit, ANSWERED)} as bucket, round(avg(c.first_response_seconds))::int as avg
          from desk_conversations c
          where ${inPeriod(ANSWERED, period)} and c.first_response_seconds is not null
          group by 1
        )
        select ${labelOf(unit, sql`b.bucket`)} as label,
          coalesce(cr.n, 0) as created, coalesce(rs.n, 0) as resolved,
          an.avg as frt_avg, rs.avg as res_avg
        from buckets b
        left join created cr on cr.bucket = b.bucket
        left join resolved rs on rs.bucket = b.bucket
        left join answered an on an.bucket = b.bucket
        order by b.bucket`,
    ),
    countsBy(db, period, sql`c.channel`),
    countsBy(db, period, sql`coalesce(c.priority, 'none')`),
    people(db, period, 'assignee'),
    people(db, period, 'team'),
  ]);

  const t = totalsRows[0] ?? {};
  const sla = slaRows[0] ?? {};
  const pair = <T>(value: T, previousValue: T): DeskReportPair<T> => ({ value, previous: previousValue });

  return {
    range: { key: period.range, start: dateKey(period.start), end: dateKey(period.end), bucket: unit },
    kpis: {
      created: pair(num(t.created_cur), num(t.created_prev)),
      resolved: pair(num(t.resolved_cur), num(t.resolved_prev)),
      firstResponseAvg: pair(numOrNull(t.frt_avg_cur), numOrNull(t.frt_avg_prev)),
      firstResponseMedian: pair(numOrNull(t.frt_median_cur), numOrNull(t.frt_median_prev)),
      resolutionAvg: pair(numOrNull(t.res_avg_cur), numOrNull(t.res_avg_prev)),
      resolutionMedian: pair(numOrNull(t.res_median_cur), numOrNull(t.res_median_prev)),
      slaCompliance: pair(numOrNull(sla.rate_cur), numOrNull(sla.rate_prev)),
      csat: pair(numOrNull(t.csat_cur), numOrNull(t.csat_prev)),
    },
    backlog: { open: num(t.open), unassigned: num(t.unassigned), waiting: num(t.waiting) },
    counts: {
      firstResponses: num(t.answered_cur),
      resolutions: num(t.resolutions_cur),
      slaMet: num(sla.met_cur),
      slaBreached: num(sla.breached_cur),
      ratings: num(t.ratings_cur),
      ratingAverage: numOrNull(t.rating_avg_cur),
    },
    series: seriesRows.map((row) => ({
      label: text(row.label),
      created: num(row.created),
      resolved: num(row.resolved),
      firstResponseAvg: numOrNull(row.frt_avg),
      resolutionAvg: numOrNull(row.res_avg),
    })),
    byChannel,
    byPriority,
    agents,
    teams,
  };
}
