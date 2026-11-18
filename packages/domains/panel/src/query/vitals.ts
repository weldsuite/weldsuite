/**
 * `vitals`: Core Web Vitals from the SDK's `$webvitals` events (one per page
 * view, `$lcp`, `$inp`, `$cls`, `$fcp`, `$ttfb` and the elements behind LCP,
 * INP and CLS). A percentile (p75 by default, like Google's assessment) over
 * the range, over time and per page, element, country and device, the
 * good / needs-improvement / poor shares by Google's thresholds, and a 0-100
 * score.
 *
 * The score is Lighthouse's: a log-normal curve through the metric's "good"
 * threshold (scores 90) and its "poor" threshold (scores 50), applied to the
 * percentile value.
 *
 * One statement per list, like the web overview; each reads the table once.
 */

import {
  PANEL_VITALS_THRESHOLDS,
  type PanelInterval,
  type PanelVitalsMetric,
  type PanelVitalsRating,
  type PanelVitalsResult,
  type PanelVitalsRow,
  type ParsedVitalsSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelQueryContext } from './context';
import { cleanedPathSql } from './paths';
import { eventsScope, type EventsScope } from './scope';
import { int, lit, num, percentileSql, propertyKey } from './sql';
import { bucketLabel, bucketLabels, bucketSql, resolveRange, type ResolvedRange } from './time';
import { toNumber, toText, type PanelSqlQuery, type Row } from './rows';
import { toResolvedRange } from './result-range';
import { trendsInterval } from './trends';

const WEBVITALS = lit('$webvitals');
const PERCENTILES = { p75: 0.75, p90: 0.9, p95: 0.95, p99: 0.99 } as const;
/** Metrics that say which element they were measured on. */
const ELEMENT_KEYS: Partial<Record<PanelVitalsMetric, string>> = { lcp: '$lcp_el', inp: '$inp_el', cls: '$cls_el' };

/** The rating of a value by Google's thresholds. */
export function vitalsRating(metric: PanelVitalsMetric, value: number | null): PanelVitalsRating | null {
  if (value === null) return null;
  const { good, poor } = PANEL_VITALS_THRESHOLDS[metric];
  if (value <= good) return 'good';
  return value > poor ? 'poor' : 'needs_improvement';
}

/** Standard normal CDF (Abramowitz and Stegun 7.1.26, error < 1.5e-7). */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(x) / Math.SQRT2));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Lighthouse's log-normal score (0-100): 90 at the good threshold, 50 at the poor one. */
export function vitalsScore(metric: PanelVitalsMetric, value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value <= 0) return 100;
  const { good, poor } = PANEL_VITALS_THRESHOLDS[metric];
  // Φ⁻¹(0.9): the good threshold sits 1.2816 standard deviations below the median (the poor threshold).
  const sigma = (Math.log(poor) - Math.log(good)) / 1.2815515655446004;
  const score = 1 - normalCdf((Math.log(value) - Math.log(poor)) / sigma);
  return Math.round(Math.min(Math.max(score, 0), 1) * 100);
}

function valueSql(metric: PanelVitalsMetric): string {
  const key = propertyKey('$' + metric);
  return `json_get_float(e.properties, ${key})`;
}

function vitalsScope(spec: ParsedVitalsSpec, ctx: PanelQueryContext, range: ResolvedRange): { scope: EventsScope; where: string[] } {
  const scope = eventsScope(ctx, range, range, { filters: spec.filters });
  return { scope, where: [`e.name = ${WEBVITALS}`, `${valueSql(spec.metric)} IS NOT NULL`] };
}

function percentileOf(spec: ParsedVitalsSpec): string {
  return percentileSql(valueSql(spec.metric), PERCENTILES[spec.percentile]);
}

function listQuery(name: string, expr: string, spec: ParsedVitalsSpec, ctx: PanelQueryContext, range: ResolvedRange, notNull = false): PanelSqlQuery {
  const { scope, where } = vitalsScope(spec, ctx, range);
  const extra = notNull ? [`${expr} IS NOT NULL`] : [];
  const sql =
    `SELECT ${expr} AS value, ${percentileOf(spec)} AS metric, COUNT(*) AS samples FROM ${scope.from} ${scope.where(...where, ...extra)} ` +
    `GROUP BY ${expr} ORDER BY COUNT(*) DESC LIMIT ${int(spec.limit, 50)}`;
  return { name, sql, columns: ['value', 'metric', 'samples'] };
}

export function vitalsQueries(spec: ParsedVitalsSpec, ctx: PanelQueryContext, range: ResolvedRange, interval: PanelInterval): PanelSqlQuery[] {
  const { scope, where } = vitalsScope(spec, ctx, range);
  const value = valueSql(spec.metric);
  const { good, poor } = PANEL_VITALS_THRESHOLDS[spec.metric];
  const bucket = bucketSql('e.ts', interval, range.offsetMinutes);
  const queries: PanelSqlQuery[] = [
    {
      name: 'vitals.summary',
      sql:
        `SELECT ${percentileOf(spec)} AS value, COUNT(*) AS samples, SUM(CASE WHEN ${value} <= ${num(good)} THEN 1 ELSE 0 END) AS good, ` +
        `SUM(CASE WHEN ${value} > ${num(poor)} THEN 1 ELSE 0 END) AS poor FROM ${scope.from} ${scope.where(...where)}`,
      columns: ['value', 'samples', 'good', 'poor'],
    },
    {
      name: 'vitals.series',
      sql:
        `SELECT ${bucket} AS bucket, ${percentileOf(spec)} AS value, COUNT(*) AS samples FROM ${scope.from} ${scope.where(...where)} ` +
        `GROUP BY ${bucket} ORDER BY ${bucket} ASC`,
      columns: ['bucket', 'value', 'samples'],
    },
    listQuery('vitals.paths', `COALESCE(${cleanedPathSql(ctx, spec.cleanPaths)}, '(unknown)')`, spec, ctx, range),
    listQuery('vitals.countries', `COALESCE(e.country, '(unknown)')`, spec, ctx, range),
    listQuery('vitals.devices', `COALESCE(e.device_type, '(unknown)')`, spec, ctx, range),
  ];
  const elementKey = ELEMENT_KEYS[spec.metric];
  if (elementKey) queries.push(listQuery('vitals.elements', `json_get_str(e.properties, ${propertyKey(elementKey)})`, spec, ctx, range, true));
  return queries;
}

function metricValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  return Math.round(toNumber(value) * 1000) / 1000;
}

function rowsFrom(metric: PanelVitalsMetric, rows: Row[]): PanelVitalsRow[] {
  return rows.map((r) => {
    const value = metricValue(r.metric);
    return { value: toText(r.value), metric: value, samples: toNumber(r.samples), rating: vitalsRating(metric, value) };
  });
}

export async function runVitals(
  spec: ParsedVitalsSpec,
  ctx: PanelQueryContext,
  run: (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>,
): Promise<PanelVitalsResult> {
  const range = resolveRange(spec.dateRange, spec.timezone, ctx);
  const interval = trendsInterval(range, spec.interval);
  const queries = vitalsQueries(spec, ctx, range, interval);
  const results = await run(queries);
  const at = (name: string): Row[] => results[queries.findIndex((q) => q.name === name)] ?? [];

  const summary = at('vitals.summary')[0] ?? {};
  const samples = toNumber(summary.samples);
  const good = toNumber(summary.good);
  const poor = toNumber(summary.poor);
  const value = samples > 0 ? metricValue(summary.value) : null;
  const byBucket = new Map(at('vitals.series').map((r) => [bucketLabel(r.bucket, interval), r]));

  return {
    range: toResolvedRange(range, null),
    interval,
    metric: spec.metric,
    percentile: spec.percentile,
    unit: spec.metric === 'cls' ? 'unitless' : 'ms',
    thresholds: PANEL_VITALS_THRESHOLDS[spec.metric],
    value,
    rating: vitalsRating(spec.metric, value),
    samples,
    shares: {
      good: samples > 0 ? good / samples : 0,
      needsImprovement: samples > 0 ? Math.max(samples - good - poor, 0) / samples : 0,
      poor: samples > 0 ? poor / samples : 0,
    },
    score: vitalsScore(spec.metric, value),
    series: bucketLabels(range, interval, range.offsetMinutes).map((bucket) => {
      const row = byBucket.get(bucket);
      return { bucket, value: row ? metricValue(row.value) : null, samples: toNumber(row?.samples) };
    }),
    paths: rowsFrom(spec.metric, at('vitals.paths')),
    elements: rowsFrom(spec.metric, at('vitals.elements')),
    countries: rowsFrom(spec.metric, at('vitals.countries')),
    devices: rowsFrom(spec.metric, at('vitals.devices')),
  };
}
