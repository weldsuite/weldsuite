/**
 * `web`: the Overview. Visitors, visits, pageviews, bounce rate and visit
 * duration, a daily series, top pages, entry and exit pages and the usual
 * dimensions. One statement per list (each reads the table once), run a few at
 * a time; visits are derived from 30-minute gaps for cookieless visitors.
 */

import type {
  PanelBreakdownRow,
  PanelEntryExitRow,
  PanelInterval,
  PanelTotals,
  PanelWebResult,
  ParsedWebSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelQueryContext } from './context';
import { eventsScope, type EventsScope } from './scope';
import { int, lit } from './sql';
import { bucketLabel, bucketLabels, bucketSql, previousBounds, resolveRange, type ResolvedRange, type TimeBounds } from './time';
import { toNumber, toText, type PanelSqlQuery, type Row } from './rows';
import { toResolvedRange } from './result-range';

const SESSION_GAP_SECONDS = 1800;
const PAGEVIEW = lit('$pageview');

/** Hours make sense for short ranges only; longer ones fall back to days. */
export function webInterval(range: ResolvedRange): PanelInterval {
  const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;
  return days <= 2 ? 'hour' : 'day';
}

interface DimensionDef {
  key: 'topPages' | 'sources' | 'utmSources' | 'utmMediums' | 'utmCampaigns' | 'countries' | 'devices' | 'browsers' | 'operatingSystems';
  expr: string;
  /** Rows without a value are left out (utm), or labelled. */
  notNull: boolean;
}

const DIMENSIONS: DimensionDef[] = [
  { key: 'topPages', expr: 'e.path', notNull: false },
  { key: 'sources', expr: `COALESCE(e.referrer_host, '(direct)')`, notNull: false },
  { key: 'utmSources', expr: 'e.utm_source', notNull: true },
  { key: 'utmMediums', expr: 'e.utm_medium', notNull: true },
  { key: 'utmCampaigns', expr: 'e.utm_campaign', notNull: true },
  { key: 'countries', expr: `COALESCE(e.country, '(unknown)')`, notNull: false },
  { key: 'devices', expr: `COALESCE(e.device_type, '(unknown)')`, notNull: false },
  { key: 'browsers', expr: `COALESCE(e.browser, '(unknown)')`, notNull: false },
  { key: 'operatingSystems', expr: `COALESCE(e.os, '(unknown)')`, notNull: false },
];

/** Events with their visit key: gaps over 30 minutes start a new visit (cookieless visitors have no session id). */
function visitsSql(scope: EventsScope): string {
  const partition = 'COALESCE(session_id, anon_id)';
  return (
    `WITH ev AS (SELECT ${scope.person} AS person, e.session_id AS session_id, e.anon_id AS anon_id, e.ts AS ts, e.name AS name, e.event_id AS event_id, ` +
    `LAG(e.ts) OVER (PARTITION BY COALESCE(e.session_id, e.anon_id) ORDER BY e.ts, e.event_id) AS prev_ts ` +
    `FROM ${scope.from} ${scope.where()}), ` +
    `seg AS (SELECT person, session_id, anon_id, ts, name, ` +
    `SUM(CASE WHEN prev_ts IS NULL OR to_unixtime(ts) - to_unixtime(prev_ts) > ${SESSION_GAP_SECONDS} THEN 1 ELSE 0 END) ` +
    `OVER (PARTITION BY ${partition} ORDER BY ts, event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS seg_no FROM ev), ` +
    `visit AS (SELECT ${partition} AS visit_key, seg_no, MIN(person) AS person, MIN(ts) AS t0, MAX(ts) AS t1, ` +
    `SUM(CASE WHEN name = ${PAGEVIEW} THEN 1 ELSE 0 END) AS pageviews, ` +
    `SUM(CASE WHEN name NOT IN (${PAGEVIEW}, '$pageleave') THEN 1 ELSE 0 END) AS actions ` +
    `FROM seg GROUP BY ${partition}, seg_no)`
  );
}

const SUMMARY_COLUMNS = ['visitors', 'visits', 'pageviews', 'bounces', 'duration_seconds'] as const;

function summaryQuery(name: string, ctx: PanelQueryContext, range: ResolvedRange, bounds: TimeBounds, spec: ParsedWebSpec): PanelSqlQuery {
  const scope = eventsScope(ctx, range, bounds, { filters: spec.filters });
  const sql =
    `${visitsSql(scope)} SELECT COUNT(DISTINCT person) AS visitors, COUNT(*) AS visits, SUM(pageviews) AS pageviews, ` +
    `SUM(CASE WHEN pageviews <= 1 AND actions = 0 THEN 1 ELSE 0 END) AS bounces, ` +
    `SUM(to_unixtime(t1) - to_unixtime(t0)) AS duration_seconds FROM visit`;
  return { name, sql, columns: SUMMARY_COLUMNS };
}

function seriesQuery(
  name: string,
  ctx: PanelQueryContext,
  range: ResolvedRange,
  bounds: TimeBounds,
  interval: PanelInterval,
  spec: ParsedWebSpec,
): PanelSqlQuery {
  const scope = eventsScope(ctx, range, bounds, { filters: spec.filters });
  const bucket = bucketSql('e.ts', interval, range.offsetMinutes);
  const sql =
    `SELECT ${bucket} AS bucket, COUNT(DISTINCT ${scope.person}) AS visitors, COUNT(*) AS pageviews ` +
    `FROM ${scope.from} ${scope.where(`e.name = ${PAGEVIEW}`)} GROUP BY ${bucket} ORDER BY ${bucket} ASC`;
  return { name, sql, columns: ['bucket', 'visitors', 'pageviews'] };
}

function entryExitQuery(ctx: PanelQueryContext, range: ResolvedRange, spec: ParsedWebSpec): PanelSqlQuery {
  const scope = eventsScope(ctx, range, range, { filters: spec.filters });
  const partition = 'COALESCE(session_id, anon_id)';
  const sql =
    `WITH pv AS (SELECT e.path AS path, e.session_id AS session_id, e.anon_id AS anon_id, e.ts AS ts, e.event_id AS event_id, ` +
    `LAG(e.ts) OVER (PARTITION BY COALESCE(e.session_id, e.anon_id) ORDER BY e.ts, e.event_id) AS prev_ts ` +
    `FROM ${scope.from} ${scope.where(`e.name = ${PAGEVIEW}`)}), ` +
    `seg AS (SELECT path, session_id, anon_id, ts, event_id, ` +
    `SUM(CASE WHEN prev_ts IS NULL OR to_unixtime(ts) - to_unixtime(prev_ts) > ${SESSION_GAP_SECONDS} THEN 1 ELSE 0 END) ` +
    `OVER (PARTITION BY ${partition} ORDER BY ts, event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS seg_no FROM pv), ` +
    `ranked AS (SELECT path, ` +
    `ROW_NUMBER() OVER (PARTITION BY ${partition}, seg_no ORDER BY ts ASC, event_id ASC) AS rn_first, ` +
    `ROW_NUMBER() OVER (PARTITION BY ${partition}, seg_no ORDER BY ts DESC, event_id DESC) AS rn_last FROM seg) ` +
    `SELECT path, SUM(CASE WHEN rn_first = 1 THEN 1 ELSE 0 END) AS entries, SUM(CASE WHEN rn_last = 1 THEN 1 ELSE 0 END) AS exits ` +
    `FROM ranked GROUP BY path ORDER BY SUM(CASE WHEN rn_first = 1 THEN 1 ELSE 0 END) + SUM(CASE WHEN rn_last = 1 THEN 1 ELSE 0 END) DESC LIMIT ${int(spec.limit * 2, 200)}`;
  return { name: 'web.entryExit', sql, columns: ['path', 'entries', 'exits'] };
}

function dimensionQuery(def: DimensionDef, ctx: PanelQueryContext, range: ResolvedRange, spec: ParsedWebSpec): PanelSqlQuery {
  const scope = eventsScope(ctx, range, range, { filters: spec.filters });
  const extra = [`e.name = ${PAGEVIEW}`];
  if (def.notNull) extra.push(`${def.expr} IS NOT NULL`);
  const sql =
    `SELECT ${def.expr} AS value, COUNT(DISTINCT ${scope.person}) AS visitors, COUNT(*) AS events ` +
    `FROM ${scope.from} ${scope.where(...extra)} GROUP BY ${def.expr} ORDER BY COUNT(DISTINCT ${scope.person}) DESC, COUNT(*) DESC LIMIT ${int(spec.limit, 50)}`;
  return { name: `web.${def.key}`, sql, columns: ['value', 'visitors', 'events'] };
}

function totalsFrom(rows: Row[]): PanelTotals {
  const row = rows[0] ?? {};
  const visits = toNumber(row.visits);
  return {
    visitors: toNumber(row.visitors),
    visits,
    pageviews: toNumber(row.pageviews),
    bounceRate: visits > 0 ? Math.min(toNumber(row.bounces) / visits, 1) : 0,
    avgVisitDurationSeconds: visits > 0 ? Math.round(toNumber(row.duration_seconds) / visits) : 0,
  };
}

function seriesFrom(rows: Row[], bounds: TimeBounds, interval: PanelInterval, offset: number) {
  const byBucket = new Map(rows.map((r) => [bucketLabel(r.bucket, interval), r]));
  return bucketLabels(bounds, interval, offset).map((bucket) => {
    const row = byBucket.get(bucket);
    return { bucket, visitors: toNumber(row?.visitors), pageviews: toNumber(row?.pageviews) };
  });
}

function breakdownFrom(rows: Row[]): PanelBreakdownRow[] {
  return rows.map((r) => ({ value: toText(r.value), visitors: toNumber(r.visitors), events: toNumber(r.events) }));
}

function entryExitFrom(rows: Row[], limit: number): PanelEntryExitRow[] {
  return rows.slice(0, limit).map((r) => ({ value: toText(r.path), entries: toNumber(r.entries), exits: toNumber(r.exits) }));
}

export async function runWeb(
  spec: ParsedWebSpec,
  ctx: PanelQueryContext,
  run: (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>,
): Promise<PanelWebResult> {
  const range = resolveRange(spec.dateRange, spec.timezone, ctx);
  const interval = webInterval(range);
  const previous = spec.compare ? previousBounds(range, range.floor) : null;

  const queries: PanelSqlQuery[] = [
    summaryQuery('web.summary', ctx, range, range, spec),
    seriesQuery('web.series', ctx, range, range, interval, spec),
    entryExitQuery(ctx, range, spec),
    ...DIMENSIONS.map((def) => dimensionQuery(def, ctx, range, spec)),
  ];
  if (previous) {
    queries.push(
      summaryQuery('web.summary.previous', ctx, range, previous, spec),
      seriesQuery('web.series.previous', ctx, range, previous, interval, spec),
    );
  }
  const results = await run(queries);
  const at = (name: string): Row[] => results[queries.findIndex((q) => q.name === name)] ?? [];

  const lists = Object.fromEntries(DIMENSIONS.map((def) => [def.key, breakdownFrom(at(`web.${def.key}`))])) as Record<
    DimensionDef['key'],
    PanelBreakdownRow[]
  >;
  return {
    range: toResolvedRange(range, previous),
    interval,
    totals: totalsFrom(at('web.summary')),
    previousTotals: previous ? totalsFrom(at('web.summary.previous')) : null,
    series: seriesFrom(at('web.series'), range, interval, range.offsetMinutes),
    previousSeries: previous ? seriesFrom(at('web.series.previous'), previous, interval, range.offsetMinutes) : null,
    entryExitPages: entryExitFrom(at('web.entryExit'), spec.limit),
    ...lists,
  };
}
