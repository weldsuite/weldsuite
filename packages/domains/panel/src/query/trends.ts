/**
 * `trends`: one or more measures of events over time, filtered, broken down by
 * a property and compared with the previous period.
 *
 * All series share one scan: each is a conditional aggregate over the events
 * that match any series. The breakdown's top N values come from a first,
 * cheap statement and are applied as a `CASE` in the second (no subquery:
 * 6.7 s against 1.2 s in the Basin spike).
 */

import type {
  PanelInterval,
  PanelTrendPoint,
  PanelTrendSeriesResult,
  PanelTrendsResult,
  ParsedTrendsSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelQueryContext } from './context';
import {
  breakdownExpr,
  breakdownLimit,
  breakdownLimitedExpr,
  breakdownNeedsProfiles,
  compileFilters,
  eventsScope,
  OTHER_LABEL,
  type EventsScope,
} from './scope';
import { eventName, inList, int, propertyKey } from './sql';
import { bucketLabel, bucketLabels, bucketSql, previousBounds, resolveRange, type ResolvedRange, type TimeBounds } from './time';
import { toNumber, toText, type PanelSqlQuery, type Row } from './rows';
import { toResolvedRange } from './result-range';

type SeriesSpec = ParsedTrendsSpec['series'][number];

/** The interval the spec asked for, coarsened where it would make thousands of buckets. */
export function trendsInterval(range: ResolvedRange, requested: PanelInterval): PanelInterval {
  const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;
  return requested === 'hour' && days > 14 ? 'day' : requested;
}

function seriesCondition(series: SeriesSpec, scope: EventsScope, ctx: PanelQueryContext, range: ResolvedRange): string {
  const parts = [`e.name = ${eventName(series.event)}`, ...compileFilters(series.filters, ctx, range, scope.person)];
  return parts.join(' AND ');
}

/** The aggregate columns of one series: `s<k>_v` (the measure) and `s<k>_u` (users, for per-user averages). */
function seriesAggregates(series: SeriesSpec, index: number, scope: EventsScope, ctx: PanelQueryContext, range: ResolvedRange): string[] {
  const cond = seriesCondition(series, scope, ctx, range);
  const v = `s${index}_v`;
  const u = `s${index}_u`;
  const property = series.property ? `json_get_float(e.properties, ${propertyKey(series.property)})` : '';
  switch (series.math) {
    case 'total':
      return [`COUNT(CASE WHEN ${cond} THEN 1 END) AS ${v}`];
    case 'unique_users':
      return [`COUNT(DISTINCT CASE WHEN ${cond} THEN ${scope.person} END) AS ${v}`];
    case 'sessions':
      return [`COUNT(DISTINCT CASE WHEN ${cond} THEN COALESCE(e.session_id, e.anon_id) END) AS ${v}`];
    case 'avg_per_user':
      return [`COUNT(CASE WHEN ${cond} THEN 1 END) AS ${v}`, `COUNT(DISTINCT CASE WHEN ${cond} THEN ${scope.person} END) AS ${u}`];
    case 'sum':
      return [`SUM(CASE WHEN ${cond} THEN ${property} END) AS ${v}`];
    case 'avg':
      return [`AVG(CASE WHEN ${cond} THEN ${property} END) AS ${v}`];
    case 'min':
      return [`MIN(CASE WHEN ${cond} THEN ${property} END) AS ${v}`];
    case 'max':
      return [`MAX(CASE WHEN ${cond} THEN ${property} END) AS ${v}`];
  }
}

function aggregateColumns(spec: ParsedTrendsSpec): string[] {
  return spec.series.flatMap((s, i) => (s.math === 'avg_per_user' ? [`s${i}_v`, `s${i}_u`] : [`s${i}_v`]));
}

function needsProfiles(spec: ParsedTrendsSpec): boolean {
  return breakdownNeedsProfiles(spec.breakdown) || spec.series.some((s) => s.filters.some((f) => f.source === 'person'));
}

function scopeFor(spec: ParsedTrendsSpec, ctx: PanelQueryContext, range: ResolvedRange, bounds: TimeBounds): EventsScope {
  return eventsScope(ctx, range, bounds, { filters: spec.filters, personProps: needsProfiles(spec) });
}

function namesCondition(spec: ParsedTrendsSpec): string {
  return `e.name IN ${inList([...new Set(spec.series.map((s) => s.event))])}`;
}

function probeQuery(spec: ParsedTrendsSpec, ctx: PanelQueryContext, range: ResolvedRange): PanelSqlQuery | null {
  if (!spec.breakdown) return null;
  const scope = scopeFor(spec, ctx, range, range);
  const expr = breakdownExpr(spec.breakdown);
  const sql =
    `SELECT ${expr} AS value, COUNT(*) AS n FROM ${scope.from} ${scope.where(namesCondition(spec))} ` +
    `GROUP BY ${expr} ORDER BY COUNT(*) DESC LIMIT ${int(breakdownLimit(spec.breakdown), 25)}`;
  return { name: 'trends.breakdownValues', sql, columns: ['value', 'n'] };
}

function mainQueries(
  spec: ParsedTrendsSpec,
  ctx: PanelQueryContext,
  range: ResolvedRange,
  bounds: TimeBounds,
  interval: PanelInterval,
  values: readonly string[],
  suffix: string,
): PanelSqlQuery[] {
  const scope = scopeFor(spec, ctx, range, bounds);
  const aggregates = spec.series.flatMap((s, i) => seriesAggregates(s, i, scope, ctx, range));
  const columns = aggregateColumns(spec);
  const bucket = bucketSql('e.ts', interval, range.offsetMinutes);
  const bd = spec.breakdown ? breakdownLimitedExpr(spec.breakdown, values) : null;
  const where = scope.where(namesCondition(spec));

  const bdSelect = bd ? `${bd} AS bd, ` : '';
  const bdGroup = bd ? `, ${bd}` : '';
  const seriesSql =
    `SELECT ${bucket} AS bucket, ${bdSelect}${aggregates.join(', ')} FROM ${scope.from} ${where} ` +
    `GROUP BY ${bucket}${bdGroup} ORDER BY ${bucket} ASC`;
  const totalsSql =
    `SELECT ${bdSelect}${aggregates.join(', ')} FROM ${scope.from} ${where}` + (bd ? ` GROUP BY ${bd}` : '');
  return [
    { name: `trends.series${suffix}`, sql: seriesSql, columns: ['bucket', ...(bd ? ['bd'] : []), ...columns] },
    { name: `trends.totals${suffix}`, sql: totalsSql, columns: [...(bd ? ['bd'] : []), ...columns] },
  ];
}

function measure(series: SeriesSpec, index: number, row: Row | undefined): number {
  if (!row) return 0;
  if (series.math === 'avg_per_user') {
    const users = toNumber(row[`s${index}_u`]);
    return users > 0 ? toNumber(row[`s${index}_v`]) / users : 0;
  }
  return toNumber(row[`s${index}_v`]);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function lineFor(
  series: SeriesSpec,
  index: number,
  breakdownValue: string | null,
  seriesRows: Row[],
  totalRows: Row[],
  labels: string[],
  interval: PanelInterval,
): { total: number; points: PanelTrendPoint[] } {
  const matches = (row: Row) => breakdownValue === null || toText(row.bd) === breakdownValue;
  const byBucket = new Map(seriesRows.filter(matches).map((row) => [bucketLabel(row.bucket, interval), row]));
  return {
    total: round(measure(series, index, totalRows.find(matches))),
    points: labels.map((bucket) => ({ bucket, value: round(measure(series, index, byBucket.get(bucket))) })),
  };
}

export async function runTrends(
  spec: ParsedTrendsSpec,
  ctx: PanelQueryContext,
  run: (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>,
): Promise<PanelTrendsResult> {
  const range = resolveRange(spec.dateRange, spec.timezone, ctx);
  const interval = trendsInterval(range, spec.interval);
  const previous = spec.compare ? previousBounds(range, range.floor) : null;

  // First pass: the breakdown's top values.
  const probe = probeQuery(spec, ctx, range);
  const values = probe ? ((await run([probe]))[0] ?? []).map((r) => toText(r.value)) : [];

  const queries = [
    ...mainQueries(spec, ctx, range, range, interval, values, ''),
    ...(previous ? mainQueries(spec, ctx, range, previous, interval, values, '.previous') : []),
  ];
  const results = await run(queries);
  const at = (name: string): Row[] => results[queries.findIndex((q) => q.name === name)] ?? [];

  const labels = bucketLabels(range, interval, range.offsetMinutes);
  const previousLabels = previous ? bucketLabels(previous, interval, range.offsetMinutes) : [];
  const seriesRows = at('trends.series');
  const totalRows = at('trends.totals');

  // The lines: one per series, or one per breakdown value (top values in rank order, `Other` last, only those with data).
  const seen = new Set([...seriesRows, ...totalRows].map((r) => toText(r.bd)));
  const breakdownValues: (string | null)[] = spec.breakdown
    ? [...values.filter((v) => seen.has(v)), ...(seen.has(OTHER_LABEL) && !values.includes(OTHER_LABEL) ? [OTHER_LABEL] : [])]
    : [null];

  const series: PanelTrendSeriesResult[] = [];
  spec.series.forEach((s, index) => {
    for (const value of breakdownValues) {
      const current = lineFor(s, index, value, seriesRows, totalRows, labels, interval);
      series.push({
        seriesIndex: index,
        label: s.label?.trim() || s.event,
        breakdownValue: value,
        total: current.total,
        points: current.points,
        previous: previous
          ? lineFor(s, index, value, at('trends.series.previous'), at('trends.totals.previous'), previousLabels, interval)
          : null,
      });
    }
  });

  return { range: toResolvedRange(range, previous), interval, series };
}
