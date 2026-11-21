/**
 * Any query result as CSV rows, for "Export CSV" on dashboard tiles and for
 * views that have no rows of their own to hand `ChartCard`'s `csv` prop. One
 * row per point, step, cohort, path or bucket; column names are plain
 * English keys (data, not UI text), like an API export.
 */

import type { PanelQueryResult } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { CsvRow } from './csv';

function webRows(result: Extract<PanelQueryResult, { kind: 'web' }>['result']): CsvRow[] {
  const previous = new Map((result.previousSeries ?? []).map((p, i) => [i, p]));
  return result.series.map((point, i) => ({
    bucket: point.bucket,
    visitors: point.visitors,
    pageviews: point.pageviews,
    ...(result.previousSeries ? { previous_visitors: previous.get(i)?.visitors ?? null, previous_pageviews: previous.get(i)?.pageviews ?? null } : {}),
  }));
}

function trendsRows(result: Extract<PanelQueryResult, { kind: 'trends' }>['result']): CsvRow[] {
  const lines = [
    ...result.series.map((s) => ({ label: s.label, breakdown: s.breakdownValue, points: s.points as { bucket: string; value: number | null }[] })),
    ...(result.formulas ?? []).map((f) => ({ label: f.label || f.expression, breakdown: f.breakdownValue, points: f.points })),
  ];
  return lines.flatMap((line) => line.points.map((point) => ({ series: line.label, breakdown: line.breakdown, bucket: point.bucket, value: point.value })));
}

function funnelRows(result: Extract<PanelQueryResult, { kind: 'funnel' }>['result']): CsvRow[] {
  const groups = result.breakdowns && result.breakdowns.length > 0 ? result.breakdowns.map((b) => ({ breakdown: b.value as string | null, steps: b.steps })) : [{ breakdown: null, steps: result.steps }];
  return groups.flatMap((group) =>
    group.steps.map((step) => ({
      breakdown: group.breakdown,
      step: step.index + 1,
      event: step.label || step.event,
      count: step.count,
      conversion_from_previous: step.conversionFromPrevious,
      conversion_from_first: step.conversionFromFirst,
      dropped_off: step.droppedOff,
      avg_seconds_from_previous: step.avgSecondsFromPrevious,
    })),
  );
}

function retentionRows(result: Extract<PanelQueryResult, { kind: 'retention' }>['result']): CsvRow[] {
  return result.cohorts.map((cohort) => {
    const row: CsvRow = { cohort: cohort.cohort, size: cohort.size };
    cohort.counts.forEach((count, i) => {
      row[`${result.interval}_${i}`] = count;
    });
    return row;
  });
}

function flowsRows(result: Extract<PanelQueryResult, { kind: 'flows' }>['result']): CsvRow[] {
  return result.paths.map((path) => {
    const row: CsvRow = { count: path.count };
    path.steps.forEach((step, i) => {
      row[`step_${i + 1}`] = step;
    });
    return row;
  });
}

/** The rows of a result, or an empty list for kinds that have no table (heatmaps). */
export function resultCsvRows(data: PanelQueryResult): CsvRow[] {
  switch (data.kind) {
    case 'web':
      return webRows(data.result);
    case 'trends':
      return trendsRows(data.result);
    case 'funnel':
      return funnelRows(data.result);
    case 'retention':
      return retentionRows(data.result);
    case 'flows':
      return flowsRows(data.result);
    case 'stickiness':
      return data.result.buckets.map((b) => ({ bucket: b.label, from: b.from, to: b.to, count: b.count, share: b.share }));
    case 'lifecycle':
      return data.result.buckets.map((b) => ({ bucket: b.bucket, new: b.new, returning: b.returning, resurrecting: b.resurrecting, dormant: b.dormant }));
    case 'vitals':
      return data.result.series.map((p) => ({ bucket: p.bucket, [data.result.metric]: p.value, samples: p.samples }));
    case 'impact':
      return data.result.adoption.map((p) => ({ bucket: p.bucket, new_adopters: p.newAdopters, adopters: p.adopters, rate: p.rate }));
    case 'signal':
      return data.result.candidates.map((c) => ({
        event: c.event,
        did_users: c.didUsers,
        did_goal_rate: c.didGoalRate,
        did_not_users: c.didNotUsers,
        did_not_goal_rate: c.didNotGoalRate,
        lift: c.lift,
        correlation: c.correlation,
      }));
    case 'funnel_correlation':
      return [...data.result.events, ...data.result.properties].map((r) => ({
        type: r.type,
        property: r.property,
        value: r.value,
        success_count: r.successCount,
        failure_count: r.failureCount,
        success_rate_with: r.successRateWith,
        success_rate_without: r.successRateWithout,
        odds_ratio: r.oddsRatio,
        correlation: r.correlation,
      }));
    case 'sessions':
      return data.result.sessions.map((s) => ({
        session_id: s.sessionId,
        started_at: s.startedAt,
        duration_seconds: s.durationSeconds,
        pageviews: s.pageviews,
        entry_page: s.entryPage,
        exit_page: s.exitPage,
        country: s.country,
        device: s.deviceType,
      }));
    default:
      return [];
  }
}
