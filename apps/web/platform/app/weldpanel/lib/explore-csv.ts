/**
 * Rows for "Export CSV" (`lib/csv.ts`, the chart card's `csv` prop) from each
 * analysis result: plain values, machine-readable (ISO buckets, 0-1 shares,
 * seconds, milliseconds), one row per bucket, step, cohort or value.
 */

import type {
  PanelBreakdownRow,
  PanelFunnelCorrelationResult,
  PanelFunnelResult,
  PanelImpactResult,
  PanelLifecycleResult,
  PanelRetentionResult,
  PanelSignalResult,
  PanelStickinessResult,
  PanelVitalsResult,
  PanelVitalsRow,
  PanelWebGoalResult,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelMetricTreeValues } from '@weldsuite/app-api-client/schemas/weldpanel-analysis';
import type { CsvRow } from './csv';
import type { TrendLine } from '../components/results/trends-result';

/** One row per bucket, one column per line (series, formulas, and their previous periods). */
export function trendsCsvRows(lines: readonly TrendLine[]): CsvRow[] {
  const buckets = [...new Set(lines.flatMap((l) => l.points.map((p) => p.bucket)))].sort((a, b) => a.localeCompare(b));
  return buckets.map((bucket, index) => {
    const row: CsvRow = { bucket };
    for (const line of lines) {
      row[line.label] = line.points.find((p) => p.bucket === bucket)?.value ?? null;
      if (line.previous) row[`${line.label} (previous)`] = line.previous.points[index]?.value ?? null;
    }
    return row;
  });
}

export function funnelCsvRows(result: PanelFunnelResult): CsvRow[] {
  const rows: CsvRow[] = result.steps.map((s) => ({
    breakdown: null,
    step: s.index + 1,
    event: s.label || s.event,
    count: s.count,
    conversion_from_previous: s.conversionFromPrevious,
    conversion_from_first: s.conversionFromFirst,
    dropped_off: s.droppedOff,
    avg_seconds_from_previous: s.avgSecondsFromPrevious,
  }));
  for (const b of result.breakdowns ?? []) {
    for (const s of b.steps) {
      rows.push({
        breakdown: b.value,
        step: s.index + 1,
        event: s.label || s.event,
        count: s.count,
        conversion_from_previous: s.conversionFromPrevious,
        conversion_from_first: s.conversionFromFirst,
        dropped_off: s.droppedOff,
        avg_seconds_from_previous: s.avgSecondsFromPrevious,
      });
    }
  }
  return rows;
}

export function funnelTrendCsvRows(result: PanelFunnelResult): CsvRow[] {
  return (result.trend ?? []).map((p) => ({ bucket: p.bucket, entered: p.entered, converted: p.converted, conversion: p.conversion }));
}

export function timeToConvertCsvRows(result: PanelFunnelResult): CsvRow[] {
  const ttc = result.timeToConvert;
  if (!ttc) return [];
  const stats = [{ scope: 'overall', ...ttc.overall }, ...ttc.steps.map((s) => ({ ...s, scope: `step ${s.index}` }))];
  return stats.flatMap((s) =>
    s.histogram.map((b) => ({ scope: s.scope, from_seconds: b.fromSeconds, to_seconds: b.toSeconds, count: b.count, median_seconds: s.medianSeconds, p90_seconds: s.p90Seconds })),
  );
}

export function correlationCsvRows(result: PanelFunnelCorrelationResult): CsvRow[] {
  return [...result.events, ...result.properties].map((r) => ({
    type: r.type,
    property: r.property,
    value: r.value,
    converted: r.successCount,
    dropped: r.failureCount,
    conversion_with: r.successRateWith,
    conversion_without: r.successRateWithout,
    odds_ratio: r.oddsRatio,
    correlation: r.correlation,
  }));
}

export function retentionCsvRows(result: PanelRetentionResult): CsvRow[] {
  const tables = result.breakdowns && result.breakdowns.length > 0 ? result.breakdowns : [{ value: null as string | null, cohorts: result.cohorts }];
  return tables.flatMap((table) =>
    table.cohorts.map((c) => {
      const row: CsvRow = { breakdown: table.value, cohort: c.cohort, size: c.size };
      c.counts.forEach((count, n) => {
        row[`period_${n}`] = count;
      });
      return row;
    }),
  );
}

export function stickinessCsvRows(result: PanelStickinessResult): CsvRow[] {
  return result.buckets.map((b) => ({ bucket: b.label, from: b.from, to: b.to, count: b.count, share: b.share }));
}

export function lifecycleCsvRows(result: PanelLifecycleResult): CsvRow[] {
  return result.buckets.map((b) => ({ bucket: b.bucket, new: b.new, returning: b.returning, resurrecting: b.resurrecting, dormant: b.dormant }));
}

function vitalsRows(kind: string, rows: readonly PanelVitalsRow[]): CsvRow[] {
  return rows.map((r) => ({ list: kind, value: r.value, metric: r.metric, samples: r.samples, rating: r.rating }));
}

export function vitalsCsvRows(result: PanelVitalsResult): CsvRow[] {
  return [
    ...result.series.map((p) => ({ list: 'series', value: p.bucket, metric: p.value, samples: p.samples, rating: null })),
    ...vitalsRows('path', result.paths),
    ...vitalsRows('element', result.elements),
    ...vitalsRows('country', result.countries),
    ...vitalsRows('device', result.devices),
  ];
}

export function vitalsListCsvRows(rows: readonly PanelVitalsRow[]): CsvRow[] {
  return rows.map((r) => ({ value: r.value, metric: r.metric, samples: r.samples, rating: r.rating }));
}

export function impactCsvRows(result: PanelImpactResult): CsvRow[] {
  return result.adoption.map((p) => ({ day: p.bucket, new_adopters: p.newAdopters, adopters: p.adopters, rate: p.rate }));
}

export function signalCsvRows(result: PanelSignalResult): CsvRow[] {
  return result.candidates.map((c) => ({
    event: c.event,
    did: c.didUsers,
    goal_rate_with: c.didGoalRate,
    did_not: c.didNotUsers,
    goal_rate_without: c.didNotGoalRate,
    lift: c.lift,
    correlation: c.correlation,
  }));
}

export function metricTreeCsvRows(values: PanelMetricTreeValues): CsvRow[] {
  return values.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    parent: n.parentId,
    relation: n.relation,
    value: n.value,
    previous: n.previous,
    change_percent: n.changePercent,
    correlation_with_parent: n.correlationWithParent,
  }));
}

export function breakdownCsvRows(rows: readonly PanelBreakdownRow[]): CsvRow[] {
  return rows.map((r) => ({ value: r.value, visitors: r.visitors, events: r.events }));
}

export function goalsCsvRows(goals: readonly PanelWebGoalResult[]): CsvRow[] {
  return goals.map((g) => ({ goal: g.label, conversions: g.conversions, unique_converters: g.uniqueConverters, conversion_rate: g.conversionRate }));
}
