/** Sample answers for trends reports (series, breakdowns, compare, formulas). */

import type {
  PanelFormulaPoint,
  PanelInterval,
  PanelTrendFormulaResult,
  PanelTrendPoint,
  PanelTrendSeriesResult,
  PanelTrendsResult,
  PanelTrendsSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { bucketsFor, resolveRange, rng, seriesValues, type SampleRange } from '../dataset';
import { breakdownsOf, eventLabel, eventVolume, filterFactor, previousRangeOf, resolved, round, splitValues, sum, uniquePerDay } from './query-common';

interface Measure {
  /** Whether the measure over the range is the sum of its points. */
  additive: boolean;
  /** `avg`/`min`/`max`: no scaling by volume. */
  kind: 'count' | 'avg' | 'min' | 'max';
  perDay: number;
  decimals: number;
}

function measureFor(series: PanelTrendsSpec['series'][number], projectId: string): Measure {
  const volume = eventVolume(series.event, projectId);
  const random = rng(`prop|${series.property ?? ''}|${series.event}`);
  const typical = 18 + random() * 140;
  switch (series.math ?? 'total') {
    case 'unique_users':
      return { additive: false, kind: 'count', perDay: uniquePerDay(series.event, projectId), decimals: 0 };
    case 'sessions':
      return { additive: false, kind: 'count', perDay: volume * 0.45, decimals: 0 };
    case 'unique_groups':
      return { additive: false, kind: 'count', perDay: volume * 0.1, decimals: 0 };
    case 'avg_per_user':
      return { additive: false, kind: 'avg', perDay: 2.1 + random() * 3, decimals: 2 };
    case 'sum':
      return { additive: true, kind: 'count', perDay: volume * typical, decimals: 0 };
    case 'avg':
      return { additive: false, kind: 'avg', perDay: typical, decimals: 2 };
    case 'min':
      return { additive: false, kind: 'min', perDay: typical * 0.12, decimals: 2 };
    case 'max':
      return { additive: false, kind: 'max', perDay: typical * 5.5, decimals: 2 };
    default:
      return { additive: true, kind: 'count', perDay: volume, decimals: 0 };
  }
}

function pointValues(key: string, range: SampleRange, interval: PanelInterval, measure: Measure, factor: number): number[] {
  if (measure.kind === 'count') {
    const base = measure.perDay * factor;
    const values = seriesValues(key, range, base, interval);
    if (measure.perDay * factor < 3) return values.map((v) => Math.max(0, v));
    // Unique measures per bucket are a little less than the plain sum (people come back).
    return measure.additive ? values : values.map((v) => Math.round(v * (interval === 'day' || interval === 'hour' ? 1 : 0.84)));
  }
  // Averages, minimums and maximums keep their level but wobble.
  const buckets = bucketsFor(range, interval);
  return buckets.map((bucket) => round(measure.perDay * (0.88 + rng(`${key}|${bucket}`)() * 0.24), measure.decimals));
}

function totalOf(values: number[], measure: Measure): number {
  if (values.length === 0) return 0;
  if (measure.kind === 'avg') return round(sum(values) / values.length, measure.decimals);
  if (measure.kind === 'min') return Math.min(...values);
  if (measure.kind === 'max') return Math.max(...values);
  if (measure.additive) return sum(values);
  return Math.round(sum(values) * (values.length > 1 ? 0.72 : 1));
}

function scaled(values: number[], share: number, decimals: number): number[] {
  return values.map((v) => round(v * share, decimals));
}

function runningTotals(values: number[]): number[] {
  let acc = 0;
  return values.map((v) => (acc += v));
}

// ---------------------------------------------------------------------------
// Formulas: a tiny parser over the letters A-E
// ---------------------------------------------------------------------------

type Scope = Record<string, number | null>;

function evaluate(expression: string, scope: Scope): number | null {
  const tokens = expression.replace(/−/g, '-').replace(/×/g, '*').replace(/÷/g, '/').match(/[A-Ea-e]|\d+(?:\.\d+)?|[()+\-*/]/g) ?? [];
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const next = (): string | undefined => tokens[pos++];
  const expr = (): number | null => {
    let left = term();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const right = term();
      left = left === null || right === null ? null : op === '+' ? left + right : left - right;
    }
    return left;
  };
  const term = (): number | null => {
    let left = factor();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const right = factor();
      if (left === null || right === null) left = null;
      else if (op === '*') left = left * right;
      else left = right === 0 ? null : left / right;
    }
    return left;
  };
  const factor = (): number | null => {
    const token = next();
    if (token === undefined) return null;
    if (token === '(') {
      const inner = expr();
      next();
      return inner;
    }
    if (token === '-') {
      const inner = factor();
      return inner === null ? null : -inner;
    }
    if (/^[A-Ea-e]$/.test(token)) return scope[token.toUpperCase()] ?? null;
    return Number(token);
  };
  const result = expr();
  return result === null || !Number.isFinite(result) ? null : round(result, 4);
}

function letterScope(values: (number | null)[]): Scope {
  return Object.fromEntries(values.map((v, i) => [String.fromCharCode(65 + i), v]));
}

// ---------------------------------------------------------------------------

interface Line {
  seriesIndex: number;
  breakdownValue: string | null;
  parts: string[] | null;
  totalValue: number;
  points: number[];
  previousTotal: number | null;
  previousPoints: number[] | null;
}

export function trendsResult(spec: PanelTrendsSpec): PanelTrendsResult {
  const projectId = spec.projectId;
  const range = resolveRange(spec.dateRange);
  const interval: PanelInterval = spec.interval ?? 'day';
  const buckets = bucketsFor(range, interval);
  const previousRange = previousRangeOf(range);
  const previousBuckets = bucketsFor(previousRange, interval);
  const compare = spec.compare === true;
  const cumulative = spec.display === 'cumulative';
  const splits = splitValues(breakdownsOf(spec), projectId);
  const specFactor = filterFactor(spec.filters);

  const lines: Line[] = [];
  spec.series.forEach((series, seriesIndex) => {
    const measure = measureFor(series, projectId);
    const factor = specFactor * filterFactor(series.filters);
    const key = `${projectId}|${series.event}|${series.math ?? 'total'}|${series.property ?? ''}`;
    const points = pointValues(key, range, interval, measure, factor);
    const previousPoints = compare ? pointValues(key, previousRange, interval, measure, factor * 0.91) : null;
    const shapes = splits.length > 0 ? splits : [{ value: null, parts: null, share: 1 }];
    for (const split of shapes) {
      const share = split.share;
      const isAverage = measure.kind !== 'count';
      const own = isAverage ? points.map((p, i) => round(p * (0.85 + rng(`${key}|${split.value}|${i}`)() * 0.3 + share * 0.2), measure.decimals)) : scaled(points, share, measure.decimals);
      const ownPrevious = previousPoints ? (isAverage ? previousPoints.map((p, i) => round(p * (0.85 + rng(`${key}|${split.value}|p${i}`)() * 0.3 + share * 0.2), measure.decimals)) : scaled(previousPoints, share, measure.decimals)) : null;
      const shown = cumulative ? runningTotals(own) : own;
      const shownPrevious = ownPrevious ? (cumulative ? runningTotals(ownPrevious) : ownPrevious) : null;
      lines.push({
        seriesIndex,
        breakdownValue: split.value,
        parts: split.parts,
        totalValue: cumulative ? (shown[shown.length - 1] ?? 0) : totalOf(own, measure),
        points: shown,
        previousTotal: shownPrevious ? (cumulative ? (shownPrevious[shownPrevious.length - 1] ?? 0) : totalOf(shownPrevious, measure)) : null,
        previousPoints: shownPrevious,
      });
    }
  });

  const toPoints = (values: number[], bucketList: string[]): PanelTrendPoint[] => bucketList.map((bucket, i) => ({ bucket, value: values[i] ?? 0 }));

  const series: PanelTrendSeriesResult[] = lines.map((line) => {
    const spec0 = spec.series[line.seriesIndex]!;
    const label = spec0.label ?? eventLabel(spec0.event);
    return {
      seriesIndex: line.seriesIndex,
      label,
      breakdownValue: line.breakdownValue,
      breakdownParts: line.parts,
      total: line.totalValue,
      points: toPoints(line.points, buckets),
      previous: line.previousPoints ? { total: line.previousTotal ?? 0, points: toPoints(line.previousPoints, previousBuckets) } : null,
    };
  });

  const formulas: PanelTrendFormulaResult[] = [];
  (spec.formulas ?? []).forEach((formula, formulaIndex) => {
    const groups = new Map<string | null, Line[]>();
    for (const line of lines) groups.set(line.breakdownValue, [...(groups.get(line.breakdownValue) ?? []), line]);
    for (const [breakdownValue, group] of groups) {
      const byIndex = (i: number): Line | undefined => group.find((l) => l.seriesIndex === i);
      const valueAt = (list: (l: Line) => number[] | null, at: number): Scope => letterScope(spec.series.map((_, i) => list(byIndex(i)!)?.[at] ?? null));
      const points: PanelFormulaPoint[] = buckets.map((bucket, at) => ({ bucket, value: evaluate(formula.expression, valueAt((l) => l.points, at)) }));
      const total = evaluate(formula.expression, letterScope(spec.series.map((_, i) => byIndex(i)?.totalValue ?? null)));
      const previous = compare
        ? {
            total: evaluate(formula.expression, letterScope(spec.series.map((_, i) => byIndex(i)?.previousTotal ?? null))),
            points: previousBuckets.map((bucket, at) => ({ bucket, value: evaluate(formula.expression, valueAt((l) => l.previousPoints, at)) })),
          }
        : null;
      formulas.push({
        formulaIndex,
        label: formula.label ?? formula.expression,
        expression: formula.expression,
        breakdownValue,
        breakdownParts: group[0]?.parts ?? null,
        total,
        points,
        previous,
      });
    }
  });

  const result: PanelTrendsResult = {
    range: resolved(range, compare, spec.timezone),
    interval,
    series: spec.formulaOnly ? [] : series,
  };
  if (spec.formulas && spec.formulas.length > 0) result.formulas = formulas;
  if (cumulative) result.cumulative = true;
  return result;
}
