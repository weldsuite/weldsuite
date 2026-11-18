/**
 * Root cause ("why did this move?"): one trends series, a current window and
 * the window before it, split by the usual dimensions (country, device,
 * browser, OS, referrer, UTM source, cleaned path) and up to three asked
 * properties. Each dimension is one statement over both windows (the
 * table read once, conditional aggregates per window); a totals statement
 * gives the whole change. Values are ranked by how much of the change they
 * carry; dimensions by how much more of it their top value carries than its
 * share of the traffic (a value with half the traffic and half the change
 * explains nothing).
 *
 * Window bounds are written `TIMESTAMP … <= e.ts`, so the scope's own bounds
 * stay the only `e.ts >= TIMESTAMP` in a statement.
 */

import type {
  PanelBreakdown,
  ParsedTrendsSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelQueryContext } from './context';
import { cleanedPathSql } from './paths';
import {
  breakdownExpr,
  eventPropertyNumber,
  eventsScope,
  eventWithFilters,
  groupKeyExpr,
  knownGroupType,
  namesCondition,
  scopeNeeds,
  type EventsScope,
} from './scope';
import { PanelQueryError, ts } from './sql';
import { dayStart, previousBounds, queryNow, type ResolvedRange, type TimeBounds } from './time';
import { toNumber, toText, type PanelSqlQuery, type Row } from './rows';
import type { PanelInterval } from '@weldsuite/app-api-client/schemas/weldpanel-query';

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function addMonths(ymd: string, months: number): string {
  const [y, m] = ymd.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 10);
}

/** The start of a bucket label (`YYYY-MM-DD` or `YYYY-MM-DDTHH:00`) and of the bucket after it, in the timezone. */
function bucketBounds(label: string, interval: PanelInterval, timezone: string): TimeBounds {
  const day = label.slice(0, 10);
  if (interval === 'hour') {
    const hour = Number(label.slice(11, 13) || '0');
    const from = new Date(dayStart(day, timezone).getTime() + hour * 3_600_000);
    return { from, to: new Date(from.getTime() + 3_600_000) };
  }
  if (interval === 'month') return { from: dayStart(day, timezone), to: dayStart(addMonths(day, 1), timezone) };
  return { from: dayStart(day, timezone), to: dayStart(addDays(day, interval === 'week' ? 7 : 1), timezone) };
}

/** The label of the bucket before `label`. */
function previousLabel(label: string, interval: Exclude<PanelInterval, 'hour'>): string {
  const day = label.slice(0, 10);
  if (interval === 'month') return addMonths(day, -1);
  return addDays(day, interval === 'week' ? -7 : -1);
}

/** A bucket and the one before it. */
function bucketWindows(label: string, interval: PanelInterval, timezone: string): ExplainWindows {
  const current = bucketBounds(label, interval, timezone);
  if (interval === 'hour') return { current, baseline: { from: new Date(current.from.getTime() - 3_600_000), to: current.from } };
  return { current, baseline: { from: bucketBounds(previousLabel(label, interval), interval, timezone).from, to: current.from } };
}

/**
 * The window to explain and the one it is compared with: a bucket and the one
 * before it, a period of days and as many days before, or the spec's range
 * and the period before it. Clamped to the retention floor and to now.
 */
export function explainWindows(
  ctx: PanelQueryContext,
  range: ResolvedRange,
  interval: PanelInterval,
  input: { bucket?: string; period?: { from: string; to: string } },
): ExplainWindows {
  const now = queryNow(ctx);
  let current: TimeBounds;
  let baseline: TimeBounds;
  if (input.bucket) {
    ({ current, baseline } = bucketWindows(input.bucket, interval, range.timezone));
  } else if (input.period) {
    current = { from: dayStart(input.period.from, range.timezone), to: dayStart(addDays(input.period.to, 1), range.timezone) };
    baseline = previousBounds(current, range.floor);
  } else {
    current = { from: range.from, to: range.to };
    baseline = previousBounds(current, range.floor);
  }
  const clamp = (d: Date) => new Date(Math.min(Math.max(d.getTime(), range.floor.getTime()), now.getTime()));
  current = { from: clamp(current.from), to: clamp(current.to) };
  baseline = { from: clamp(baseline.from), to: clamp(baseline.to) };
  if (current.to.getTime() <= current.from.getTime()) throw new PanelQueryError('That period has not started yet');
  return { current, baseline };
}

export const EXPLAIN_DIMENSIONS = ['country', 'device_type', 'browser', 'os', 'referrer_host', 'utm_source', 'path'] as const;

const MAX_VALUES_READ = 50;

export interface ExplainWindows {
  current: TimeBounds;
  baseline: TimeBounds;
}

export interface ExplainDimension {
  /** `country`, ..., `event:<key>`, `person:<key>`. */
  name: string;
  expr: string;
}

type Series = ParsedTrendsSpec['series'][number];

/** The measure of the series inside a window, as one aggregate. */
function windowAggregate(series: Series, scope: EventsScope, ctx: PanelQueryContext, range: ResolvedRange, window: TimeBounds): string {
  let cond = `${eventWithFilters(series.event, series.filters, ctx, range, scope.person)} AND ${ts(window.from)} <= e.ts AND ${ts(window.to)} > e.ts`;
  switch (series.math) {
    case 'total':
      return `COUNT(CASE WHEN ${cond} THEN 1 END)`;
    case 'unique_users':
      return `COUNT(DISTINCT CASE WHEN ${cond} THEN ${scope.person} END)`;
    case 'unique_groups': {
      const key = groupKeyExpr(knownGroupType(ctx, series.groupType ?? ''));
      cond = `${cond} AND ${key} IS NOT NULL`;
      return `COUNT(DISTINCT CASE WHEN ${cond} THEN ${key} END)`;
    }
    case 'sessions':
      return `COUNT(DISTINCT CASE WHEN ${cond} THEN COALESCE(e.session_id, e.anon_id) END)`;
    case 'sum':
      return `SUM(CASE WHEN ${cond} THEN ${eventPropertyNumber(series.property ?? '', ctx)} END)`;
    default:
      throw new PanelQueryError('Root cause works on counts and sums');
  }
}

/** The dimensions to split by: the standard ones and the asked properties. */
export function explainDimensions(ctx: PanelQueryContext, properties: readonly PanelBreakdown[], cleanPaths: boolean | undefined): ExplainDimension[] {
  const standard: ExplainDimension[] = [
    { name: 'country', expr: `COALESCE(e.country, '(unknown)')` },
    { name: 'device_type', expr: `COALESCE(e.device_type, '(unknown)')` },
    { name: 'browser', expr: `COALESCE(e.browser, '(unknown)')` },
    { name: 'os', expr: `COALESCE(e.os, '(unknown)')` },
    { name: 'referrer_host', expr: `COALESCE(e.referrer_host, '(direct)')` },
    { name: 'utm_source', expr: `COALESCE(e.utm_source, '(none)')` },
    { name: 'path', expr: `COALESCE(${cleanedPathSql(ctx, cleanPaths)}, '(none)')` },
  ];
  const asked = properties.slice(0, 3).map((b): ExplainDimension => {
    if (b.source !== 'event' && b.source !== 'person') throw new PanelQueryError('Use event or person properties');
    return { name: `${b.source}:${b.key}`, expr: breakdownExpr({ ...b, bucket: undefined }, ctx) };
  });
  return [...standard, ...asked];
}

/** Totals and one statement per dimension, over both windows. */
export function explainQueries(
  spec: ParsedTrendsSpec,
  ctx: PanelQueryContext,
  range: ResolvedRange,
  windows: ExplainWindows,
  dimensions: readonly ExplainDimension[],
  properties: readonly PanelBreakdown[],
): PanelSqlQuery[] {
  const series = spec.series[0];
  if (!series || spec.series.length !== 1) throw new PanelQueryError('Explain one series at a time');
  const bounds: TimeBounds = { from: windows.baseline.from, to: windows.current.to };
  const needs = scopeNeeds(ctx, { filters: [series.filters], events: [series.event], breakdowns: properties });
  const scope = eventsScope(ctx, range, bounds, { filters: spec.filters, ...needs });
  const cur = windowAggregate(series, scope, ctx, range, windows.current);
  const base = windowAggregate(series, scope, ctx, range, windows.baseline);
  const where = scope.where(namesCondition([series.event], ctx));

  const queries: PanelSqlQuery[] = [
    { name: 'explain.totals', sql: `SELECT ${cur} AS cur, ${base} AS base FROM ${scope.from} ${where}`, columns: ['cur', 'base'] },
  ];
  dimensions.forEach((dim, i) => {
    queries.push({
      name: `explain.d${i}`,
      sql:
        `SELECT ${dim.expr} AS value, ${cur} AS cur, ${base} AS base FROM ${scope.from} ${where} ` +
        `GROUP BY ${dim.expr} ORDER BY ABS(COALESCE(${cur}, 0) - COALESCE(${base}, 0)) DESC LIMIT ${MAX_VALUES_READ}`,
      columns: ['value', 'cur', 'base'],
    });
  });
  return queries;
}

export interface ExplainValue {
  value: string;
  current: number;
  baseline: number;
  change: number;
  changePercent: number | null;
  contributionShare: number;
}

export interface ExplainDimensionResult {
  dimension: string;
  values: ExplainValue[];
  explained: number;
}

function percent(change: number, baseline: number): number | null {
  return baseline !== 0 ? Math.round((change / baseline) * 10000) / 10000 : null;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Rows in, ranked dimensions out. */
export function explainFrom(
  dimensions: readonly ExplainDimension[],
  totals: Row | undefined,
  rowsPerDimension: readonly Row[][],
  limit: number,
): { metric: { current: number; baseline: number; change: number; changePercent: number | null }; dimensions: ExplainDimensionResult[] } {
  const current = toNumber(totals?.cur);
  const baseline = toNumber(totals?.base);
  const change = current - baseline;
  const direction = change >= 0 ? 1 : -1;

  const results = dimensions.map((dim, i): ExplainDimensionResult => {
    const rows = rowsPerDimension[i] ?? [];
    const values = rows
      .map((r): ExplainValue => {
        const cur = toNumber(r.cur);
        const base = toNumber(r.base);
        const delta = cur - base;
        return {
          value: toText(r.value),
          current: cur,
          baseline: base,
          change: delta,
          changePercent: percent(delta, base),
          contributionShare: change !== 0 ? round(delta / change) : 0,
        };
      })
      .sort((a, b) => direction * (b.change - a.change));
    const top = values.slice(0, limit);
    // How much more of the change the best value carries than its share of the traffic.
    const share = (v: ExplainValue) => {
      if (baseline > 0) return v.baseline / baseline;
      return current > 0 ? v.current / current : 0;
    };
    const explained = top.reduce((best, v) => Math.max(best, v.contributionShare - share(v)), 0);
    return { dimension: dim.name, values: top, explained: round(Math.min(Math.max(explained, 0), 1)) };
  });
  results.sort((a, b) => b.explained - a.explained);
  return { metric: { current, baseline, change, changePercent: percent(change, baseline) }, dimensions: results };
}
