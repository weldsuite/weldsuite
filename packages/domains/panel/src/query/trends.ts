/**
 * `trends`: one or more measures of events over time, filtered, broken down by
 * up to three properties and compared with the previous period, plus
 * formulas over the series (`A / B * 100`).
 *
 * All series share one scan: each is a conditional aggregate over the events
 * that match any series. The breakdown's top N values come from a first,
 * cheap statement and are applied as a `CASE` in the second (no subquery:
 * 6.7 s against 1.2 s in the Basin spike). Formulas are evaluated here, from
 * the series' values per bucket, never in SQL.
 *
 * `display: 'cumulative'` turns the points into running totals: summed for
 * counts and sums, and for distinct counts (people, groups, sessions) from
 * one more statement per such series that counts each one in the bucket it
 * was first seen in.
 */

import {
  specBreakdowns,
  type PanelFormulaPoint,
  type PanelInterval,
  type PanelTrendFormulaResult,
  type PanelTrendPoint,
  type PanelTrendSeriesResult,
  type PanelTrendsResult,
  type ParsedTrendsSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { evaluate, parseExpression, type ExpressionNode } from '../expression';
import type { PanelQueryContext } from './context';
import { limitedBreakdown, orderedValues, partsFor, prepareBreakdowns, type PreparedBreakdowns } from './breakdowns';
import {
  eventPropertyNumber,
  eventWithFilters,
  eventsScope,
  groupKeyExpr,
  knownGroupType,
  namesCondition,
  scopeNeeds,
  type EventsScope,
} from './scope';
import { PanelQueryError } from './sql';
import { bucketLabel, bucketLabels, bucketSql, previousBounds, resolveRange, type ResolvedRange, type TimeBounds } from './time';
import { toNumber, toText, type PanelSqlQuery, type Row } from './rows';
import { toResolvedRange } from './result-range';

type SeriesSpec = ParsedTrendsSpec['series'][number];
type Run = (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>;

/** The interval the spec asked for, coarsened where it would make thousands of buckets. */
export function trendsInterval(range: ResolvedRange, requested: PanelInterval): PanelInterval {
  const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;
  return requested === 'hour' && days > 14 ? 'day' : requested;
}

function seriesCondition(series: SeriesSpec, scope: EventsScope, ctx: PanelQueryContext, range: ResolvedRange): string {
  const cond = eventWithFilters(series.event, series.filters, ctx, range, scope.person);
  // A group count leaves out events without that group.
  if (series.math === 'unique_groups') return `${cond} AND ${groupKeyExpr(knownGroupType(ctx, series.groupType ?? ''))} IS NOT NULL`;
  return cond;
}

/** What a distinct measure counts per series: people, a group key or a session; null for additive maths. */
function distinctUnit(series: SeriesSpec, scope: EventsScope, ctx: PanelQueryContext): string | null {
  switch (series.math) {
    case 'unique_users':
      return scope.person;
    case 'unique_groups':
      return groupKeyExpr(knownGroupType(ctx, series.groupType ?? ''));
    case 'sessions':
      return 'COALESCE(e.session_id, e.anon_id)';
    default:
      return null;
  }
}

/** The aggregate columns of one series: `s<k>_v` (the measure) and `s<k>_u` (users, for per-user averages). */
function seriesAggregates(series: SeriesSpec, index: number, scope: EventsScope, ctx: PanelQueryContext, range: ResolvedRange): string[] {
  const cond = seriesCondition(series, scope, ctx, range);
  const v = `s${index}_v`;
  const u = `s${index}_u`;
  const property = series.property ? eventPropertyNumber(series.property, ctx) : '';
  switch (series.math) {
    case 'total':
      return [`COUNT(CASE WHEN ${cond} THEN 1 END) AS ${v}`];
    case 'unique_users':
    case 'unique_groups':
    case 'sessions':
      return [`COUNT(DISTINCT CASE WHEN ${cond} THEN ${distinctUnit(series, scope, ctx)} END) AS ${v}`];
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

function scopeFor(spec: ParsedTrendsSpec, ctx: PanelQueryContext, range: ResolvedRange, bounds: TimeBounds): EventsScope {
  const needs = scopeNeeds(ctx, {
    filters: spec.series.map((s) => s.filters),
    events: spec.series.map((s) => s.event),
    breakdowns: specBreakdowns(spec),
  });
  return eventsScope(ctx, range, bounds, { filters: spec.filters, ...needs });
}

function seriesNames(spec: ParsedTrendsSpec, ctx: PanelQueryContext): string {
  return namesCondition(spec.series.map((s) => s.event), ctx);
}

function mainQueries(
  spec: ParsedTrendsSpec,
  ctx: PanelQueryContext,
  range: ResolvedRange,
  bounds: TimeBounds,
  interval: PanelInterval,
  breakdowns: PreparedBreakdowns | null,
  suffix: string,
): PanelSqlQuery[] {
  const scope = scopeFor(spec, ctx, range, bounds);
  const aggregates = spec.series.flatMap((s, i) => seriesAggregates(s, i, scope, ctx, range));
  const columns = aggregateColumns(spec);
  const bucket = bucketSql('e.ts', interval, range.offsetMinutes);
  const bd = breakdowns ? limitedBreakdown(breakdowns) : null;
  const where = scope.where(seriesNames(spec, ctx));

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

/**
 * Distinct-so-far for a cumulative line: each person (group, session) counted
 * once, in the bucket of their first matching event.
 */
function firstSeenQuery(
  spec: ParsedTrendsSpec,
  index: number,
  ctx: PanelQueryContext,
  range: ResolvedRange,
  interval: PanelInterval,
  breakdowns: PreparedBreakdowns | null,
): PanelSqlQuery {
  const series = spec.series[index] as SeriesSpec;
  const scope = scopeFor(spec, ctx, range, range);
  const unit = distinctUnit(series, scope, ctx) as string;
  const bucket = bucketSql('e.ts', interval, range.offsetMinutes);
  const bd = breakdowns ? limitedBreakdown(breakdowns) : null;
  const where = scope.where(seriesCondition(series, scope, ctx, range));
  const bdSelect = bd ? bd + ' AS bd, ' : '';
  const bdGroup = bd ? ', ' + bd : '';
  const inner = `SELECT ${unit} AS unit, ${bdSelect}MIN(${bucket}) AS first_bucket FROM ${scope.from} ${where} GROUP BY ${unit}${bdGroup}`;
  const sql =
    `SELECT first_bucket AS bucket, ${bd ? 'bd, ' : ''}COUNT(*) AS n FROM (${inner}) AS firsts ` +
    `GROUP BY first_bucket${bd ? ', bd' : ''}`;
  return { name: `trends.firstSeen.s${index}`, sql, columns: ['bucket', ...(bd ? ['bd'] : []), 'n'] };
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

interface Line {
  total: number;
  points: PanelTrendPoint[];
}

function lineFor(
  series: SeriesSpec,
  index: number,
  breakdownValue: string | null,
  seriesRows: Row[],
  totalRows: Row[],
  labels: string[],
  interval: PanelInterval,
): Line {
  const matches = (row: Row) => breakdownValue === null || toText(row.bd) === breakdownValue;
  const byBucket = new Map(seriesRows.filter(matches).map((row) => [bucketLabel(row.bucket, interval), row]));
  return {
    total: round(measure(series, index, totalRows.find(matches))),
    points: labels.map((bucket) => ({ bucket, value: round(measure(series, index, byBucket.get(bucket))) })),
  };
}

function runningTotals(points: readonly PanelTrendPoint[]): PanelTrendPoint[] {
  const out: PanelTrendPoint[] = [];
  let running = 0;
  for (const p of points) {
    running += p.value;
    out.push({ bucket: p.bucket, value: round(running) });
  }
  return out;
}

/** Running totals. Distinct maths use their first-seen counts; averages and extremes are left per bucket. */
function cumulativeLine(series: SeriesSpec, line: Line, firstSeen: Row[] | null, breakdownValue: string | null, interval: PanelInterval): Line {
  if (firstSeen) {
    const matches = (row: Row) => breakdownValue === null || toText(row.bd) === breakdownValue;
    const counts = new Map<string, number>();
    for (const row of firstSeen.filter(matches)) {
      const label = bucketLabel(row.bucket, interval);
      counts.set(label, (counts.get(label) ?? 0) + toNumber(row.n));
    }
    return { total: line.total, points: runningTotals(line.points.map((p) => ({ bucket: p.bucket, value: counts.get(p.bucket) ?? 0 }))) };
  }
  if (series.math !== 'total' && series.math !== 'sum') return line;
  return { total: line.total, points: runningTotals(line.points) };
}

/** Each formula parsed once; a formula that does not parse is a 400. */
function parseFormulas(spec: ParsedTrendsSpec): { expression: string; label: string; ast: ExpressionNode }[] {
  return (spec.formulas ?? []).map((formula, i) => {
    const parsed = parseExpression(formula.expression, { identifiers: 'series', seriesCount: spec.series.length });
    if (!parsed.ok) throw new PanelQueryError(`Formula ${i + 1}: ${parsed.error.message}`);
    return { expression: formula.expression, label: formula.label?.trim() || formula.expression, ast: parsed.ast };
  });
}

const LETTERS = ['A', 'B', 'C', 'D', 'E'];

function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10000) / 10000;
}

/** A formula over lines of the same breakdown value: per bucket and over the totals. */
function formulaLine(ast: ExpressionNode, lines: (Line | undefined)[]): { total: number | null; points: PanelFormulaPoint[] } {
  const valuesAt = (pick: (line: Line) => number | undefined) =>
    Object.fromEntries(lines.map((line, i) => [LETTERS[i] as string, line ? pick(line) : undefined]));
  const labels = lines.find((l) => l)?.points.map((p) => p.bucket) ?? [];
  return {
    total: roundOrNull(evaluate(ast, valuesAt((l) => l.total))),
    points: labels.map((bucket, b) => ({ bucket, value: roundOrNull(evaluate(ast, valuesAt((l) => l.points[b]?.value))) })),
  };
}

export async function runTrends(spec: ParsedTrendsSpec, ctx: PanelQueryContext, run: Run): Promise<PanelTrendsResult> {
  const range = resolveRange(spec.dateRange, spec.timezone, ctx);
  const interval = trendsInterval(range, spec.interval);
  const previous = spec.compare ? previousBounds(range, range.floor) : null;
  const formulas = parseFormulas(spec);
  const cumulative = spec.display === 'cumulative';

  // First pass: the breakdowns' buckets and top values.
  const probeScope = scopeFor(spec, ctx, range, range);
  const breakdowns = await prepareBreakdowns(
    specBreakdowns(spec),
    { ctx, scope: probeScope, where: [seriesNames(spec, ctx)], measure: 'COUNT(*)', name: 'trends', cleanPaths: spec.cleanPaths },
    run,
  );

  const firstSeenFor = cumulative ? spec.series.map((s, i) => (distinctUnit(s, probeScope, ctx) ? i : -1)).filter((i) => i >= 0) : [];
  const queries = [
    ...mainQueries(spec, ctx, range, range, interval, breakdowns, ''),
    ...(previous ? mainQueries(spec, ctx, range, previous, interval, breakdowns, '.previous') : []),
    ...firstSeenFor.map((i) => firstSeenQuery(spec, i, ctx, range, interval, breakdowns)),
  ];
  const results = await run(queries);
  const at = (name: string): Row[] => results[queries.findIndex((q) => q.name === name)] ?? [];

  const labels = bucketLabels(range, interval, range.offsetMinutes);
  const previousLabels = previous ? bucketLabels(previous, interval, range.offsetMinutes) : [];
  const seriesRows = at('trends.series');
  const totalRows = at('trends.totals');

  // The lines: one per series, or one per breakdown value (top values in rank order, `Other` last, only those with data).
  const seen = new Set([...seriesRows, ...totalRows].map((r) => toText(r.bd)));
  const breakdownValues: (string | null)[] = breakdowns ? orderedValues(breakdowns, seen) : [null];

  const lines = new Map<string, { current: Line; previous: Line | null }>();
  const series: PanelTrendSeriesResult[] = [];
  spec.series.forEach((s, index) => {
    for (const value of breakdownValues) {
      let current = lineFor(s, index, value, seriesRows, totalRows, labels, interval);
      let before = previous ? lineFor(s, index, value, at('trends.series.previous'), at('trends.totals.previous'), previousLabels, interval) : null;
      if (cumulative) {
        const firstSeen = firstSeenFor.includes(index) ? at(`trends.firstSeen.s${index}`) : null;
        current = cumulativeLine(s, current, firstSeen, value, interval);
        // The previous period has no first-seen statement: additive maths only.
        before = before ? cumulativeLine(s, before, null, value, interval) : null;
      }
      lines.set(`${index}|${value ?? ''}`, { current, previous: before });
      series.push({
        seriesIndex: index,
        label: s.label?.trim() || s.event,
        breakdownValue: value,
        ...(breakdowns ? { breakdownParts: partsFor(breakdowns, value) } : {}),
        total: current.total,
        points: current.points,
        previous: before,
      });
    }
  });

  const result: PanelTrendsResult = { range: toResolvedRange(range, previous), interval, series: spec.formulaOnly ? [] : series };
  if (cumulative) result.cumulative = true;
  if (formulas.length > 0) {
    result.formulas = formulas.flatMap((formula, formulaIndex) =>
      breakdownValues.map((value): PanelTrendFormulaResult => {
        const forValue = spec.series.map((_, i) => lines.get(`${i}|${value ?? ''}`));
        const current = formulaLine(formula.ast, forValue.map((l) => l?.current));
        return {
          formulaIndex,
          label: formula.label,
          expression: formula.expression,
          breakdownValue: value,
          ...(breakdowns ? { breakdownParts: partsFor(breakdowns, value) } : {}),
          total: current.total,
          points: current.points,
          previous: previous ? formulaLine(formula.ast, forValue.map((l) => l?.previous ?? undefined)) : null,
        };
      }),
    );
  }
  return result;
}
