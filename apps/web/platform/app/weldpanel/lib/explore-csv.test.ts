import { describe, expect, it } from 'vitest';
import type {
  PanelFunnelCorrelationResult,
  PanelImpactResult,
  PanelLifecycleResult,
  PanelSignalResult,
  PanelStickinessResult,
  PanelVitalsResult,
  PanelVitalsRow,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelMetricTreeValues } from '@weldsuite/app-api-client/schemas/weldpanel-analysis';
import type { TrendLine } from '../components/results/trends-result';
import { RANGE, makeFunnelResult, makeRetentionResult } from '../analytics-fixtures';
import {
  breakdownCsvRows,
  correlationCsvRows,
  funnelCsvRows,
  funnelTrendCsvRows,
  goalsCsvRows,
  impactCsvRows,
  lifecycleCsvRows,
  metricTreeCsvRows,
  retentionCsvRows,
  signalCsvRows,
  stickinessCsvRows,
  timeToConvertCsvRows,
  trendsCsvRows,
  vitalsCsvRows,
  vitalsListCsvRows,
} from './explore-csv';

function line(overrides: Partial<TrendLine> & Pick<TrendLine, 'label' | 'points'>): TrendLine {
  return { key: overrides.label, kind: 'series', seriesIndex: 0, total: null, previous: null, ...overrides };
}

describe('trendsCsvRows', () => {
  it('writes one row per bucket in order, one column per line, with gaps as null', () => {
    const rows = trendsCsvRows([
      line({ label: 'Signed up', points: [{ bucket: '2026-11-13', value: 7 }, { bucket: '2026-11-12', value: 5 }] }),
      line({ label: 'Paid', kind: 'formula', seriesIndex: null, points: [{ bucket: '2026-11-13', value: null }] }),
    ]);
    expect(rows).toEqual([
      { bucket: '2026-11-12', 'Signed up': 5, Paid: null },
      { bucket: '2026-11-13', 'Signed up': 7, Paid: null },
    ]);
  });

  it('adds the previous period of a line next to it, matched by position', () => {
    const rows = trendsCsvRows([
      line({
        label: 'Visits',
        points: [{ bucket: '2026-11-12', value: 10 }, { bucket: '2026-11-13', value: 12 }],
        previous: { total: 15, points: [{ bucket: '2026-10-12', value: 8 }] },
      }),
    ]);
    expect(rows).toEqual([
      { bucket: '2026-11-12', Visits: 10, 'Visits (previous)': 8 },
      { bucket: '2026-11-13', Visits: 12, 'Visits (previous)': null },
    ]);
  });

  it('is empty without lines', () => {
    expect(trendsCsvRows([])).toEqual([]);
  });
});

describe('funnel rows', () => {
  it('lists the steps, numbered from 1 and named by label or event', () => {
    const funnel = makeFunnelResult();
    funnel.steps[1] = { ...funnel.steps[1]!, label: '' };
    expect(funnelCsvRows(funnel)).toEqual([
      { breakdown: null, step: 1, event: '$pageview', count: 1000, conversion_from_previous: 1, conversion_from_first: 1, dropped_off: 0, avg_seconds_from_previous: null },
      { breakdown: null, step: 2, event: 'Signed up', count: 250, conversion_from_previous: 0.25, conversion_from_first: 0.25, dropped_off: 750, avg_seconds_from_previous: 90 },
    ]);
  });

  it('adds the steps of every breakdown value after the overall ones', () => {
    const funnel = makeFunnelResult();
    funnel.breakdowns = [{ value: 'NL', steps: [{ ...funnel.steps[0]!, count: 400 }], overallConversion: 0.3 }];
    const rows = funnelCsvRows(funnel);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ breakdown: 'NL', step: 1, count: 400 });
  });

  it('writes the conversion trend per bucket, and nothing without one', () => {
    const trend = [{ bucket: '2026-11-12', entered: 100, converted: 20, conversion: 0.2 }];
    expect(funnelTrendCsvRows(makeFunnelResult({ trend }))).toEqual([{ bucket: '2026-11-12', entered: 100, converted: 20, conversion: 0.2 }]);
    expect(funnelTrendCsvRows(makeFunnelResult())).toEqual([]);
  });

  it('writes the time-to-convert histogram overall and per step', () => {
    const stats = (count: number) => ({ count, medianSeconds: 60, p90Seconds: 300, avgSeconds: 90, histogram: [{ fromSeconds: 0, toSeconds: 60, count }] });
    const funnel = makeFunnelResult({ timeToConvert: { overall: stats(10), steps: [{ ...stats(4), index: 1 }] } });
    expect(timeToConvertCsvRows(funnel)).toEqual([
      { scope: 'overall', from_seconds: 0, to_seconds: 60, count: 10, median_seconds: 60, p90_seconds: 300 },
      { scope: 'step 1', from_seconds: 0, to_seconds: 60, count: 4, median_seconds: 60, p90_seconds: 300 },
    ]);
    expect(timeToConvertCsvRows(makeFunnelResult({ timeToConvert: null }))).toEqual([]);
  });

  it('lists correlated events before properties', () => {
    const row = { successCount: 30, failureCount: 5, successRateWith: 0.8, successRateWithout: 0.2, oddsRatio: 4.5 };
    const result: PanelFunnelCorrelationResult = {
      range: RANGE,
      converted: 40,
      dropped: 60,
      events: [{ type: 'event', property: null, value: 'Viewed pricing', correlation: 'positive', ...row }],
      properties: [{ type: 'property', property: 'country', value: 'NL', correlation: 'negative', ...row }],
    };
    expect(correlationCsvRows(result)).toEqual([
      { type: 'event', property: null, value: 'Viewed pricing', converted: 30, dropped: 5, conversion_with: 0.8, conversion_without: 0.2, odds_ratio: 4.5, correlation: 'positive' },
      { type: 'property', property: 'country', value: 'NL', converted: 30, dropped: 5, conversion_with: 0.8, conversion_without: 0.2, odds_ratio: 4.5, correlation: 'negative' },
    ]);
  });
});

describe('retentionCsvRows', () => {
  it('writes one row per cohort with a column per period', () => {
    expect(retentionCsvRows(makeRetentionResult())).toEqual([
      { breakdown: null, cohort: '2026-10-19', size: 100, period_0: 100, period_1: 40, period_2: 20 },
      { breakdown: null, cohort: '2026-10-26', size: 80, period_0: 80, period_1: 30 },
    ]);
  });

  it('writes the cohorts of each breakdown value instead of the overall table', () => {
    const result = makeRetentionResult({
      breakdowns: [
        { value: 'NL', cohorts: [{ cohort: '2026-10-19', size: 10, counts: [10, 4] }], averageRetention: [1, 0.4] },
        { value: 'DE', cohorts: [{ cohort: '2026-10-19', size: 5, counts: [5] }], averageRetention: [1] },
      ],
    });
    expect(retentionCsvRows(result)).toEqual([
      { breakdown: 'NL', cohort: '2026-10-19', size: 10, period_0: 10, period_1: 4 },
      { breakdown: 'DE', cohort: '2026-10-19', size: 5, period_0: 5 },
    ]);
  });

  it('keeps the overall table when the breakdown list is empty', () => {
    expect(retentionCsvRows(makeRetentionResult({ breakdowns: [] }))).toHaveLength(2);
  });
});

describe('new report kinds', () => {
  it('stickiness: one row per bucket with its share', () => {
    const result: PanelStickinessResult = {
      range: RANGE,
      interval: 'day',
      measure: 'count',
      total: 50,
      intervalsInRange: 30,
      buckets: [
        { label: '1', from: 1, to: 1, count: 30, share: 0.6 },
        { label: '6+', from: 6, to: null, count: 20, share: 0.4 },
      ],
    };
    expect(stickinessCsvRows(result)).toEqual([
      { bucket: '1', from: 1, to: 1, count: 30, share: 0.6 },
      { bucket: '6+', from: 6, to: null, count: 20, share: 0.4 },
    ]);
  });

  it('lifecycle: the four groups per bucket', () => {
    const result: PanelLifecycleResult = {
      range: RANGE,
      interval: 'week',
      buckets: [{ bucket: '2026-11-09', new: 5, returning: 10, resurrecting: 2, dormant: 3 }],
      totals: { new: 5, returning: 10, resurrecting: 2, dormant: 3 },
    };
    expect(lifecycleCsvRows(result)).toEqual([{ bucket: '2026-11-09', new: 5, returning: 10, resurrecting: 2, dormant: 3 }]);
  });

  it('vitals: the series first, then each breakdown list, tagged by list', () => {
    const row = (value: string): PanelVitalsRow => ({ value, metric: 1800, samples: 12, rating: 'good' });
    const result: PanelVitalsResult = {
      range: RANGE,
      interval: 'day',
      metric: 'lcp',
      percentile: 'p75',
      unit: 'ms',
      thresholds: { good: 2500, poor: 4000 },
      value: 1900,
      rating: 'good',
      samples: 40,
      shares: { good: 0.9, needsImprovement: 0.1, poor: 0 },
      score: 92,
      series: [{ bucket: '2026-11-12', value: 2100, samples: 20 }],
      paths: [row('/pricing')],
      elements: [row('img.hero')],
      countries: [row('NL')],
      devices: [row('mobile')],
    };
    expect(vitalsCsvRows(result)).toEqual([
      { list: 'series', value: '2026-11-12', metric: 2100, samples: 20, rating: null },
      { list: 'path', value: '/pricing', metric: 1800, samples: 12, rating: 'good' },
      { list: 'element', value: 'img.hero', metric: 1800, samples: 12, rating: 'good' },
      { list: 'country', value: 'NL', metric: 1800, samples: 12, rating: 'good' },
      { list: 'device', value: 'mobile', metric: 1800, samples: 12, rating: 'good' },
    ]);
    expect(vitalsListCsvRows(result.paths)).toEqual([{ value: '/pricing', metric: 1800, samples: 12, rating: 'good' }]);
  });

  it('impact: adoption per day', () => {
    const group = { users: 10, before: 1, after: 2, change: 1 };
    const result: PanelImpactResult = {
      range: RANGE,
      launchDate: '2026-11-01',
      windowDays: 28,
      adoption: [{ bucket: '2026-11-01', newAdopters: 4, adopters: 4, rate: 0.1 }],
      adopters: group,
      nonAdopters: group,
      differenceInDifferences: 0.5,
      relativeImpact: 0.2,
    };
    expect(impactCsvRows(result)).toEqual([{ day: '2026-11-01', new_adopters: 4, adopters: 4, rate: 0.1 }]);
  });

  it('signal: one row per candidate event', () => {
    const result: PanelSignalResult = {
      range: RANGE,
      goal: 'Paid',
      windowDays: 7,
      users: 100,
      goalUsers: 20,
      goalRate: 0.2,
      candidates: [{ event: 'Invited a teammate', didUsers: 30, didGoalRate: 0.5, didNotUsers: 70, didNotGoalRate: 0.07, lift: 7.1, correlation: 0.45 }],
    };
    expect(signalCsvRows(result)).toEqual([
      { event: 'Invited a teammate', did: 30, goal_rate_with: 0.5, did_not: 70, goal_rate_without: 0.07, lift: 7.1, correlation: 0.45 },
    ]);
  });

  it('metric tree: one row per node with its parent and change', () => {
    const values: PanelMetricTreeValues = {
      range: RANGE,
      dataAsOf: '2026-11-14T12:00:00.000Z',
      nodes: [
        { id: 'root', label: 'Revenue', parentId: null, relation: null, value: 100, previous: 80, changePercent: 0.25, correlationWithParent: null, points: [], error: null },
        { id: 'orders', label: 'Orders', parentId: 'root', relation: 'influence', value: null, previous: null, changePercent: null, correlationWithParent: 0.9, points: [], error: 'query_failed' },
      ],
    };
    expect(metricTreeCsvRows(values)).toEqual([
      { id: 'root', label: 'Revenue', parent: null, relation: null, value: 100, previous: 80, change_percent: 0.25, correlation_with_parent: null },
      { id: 'orders', label: 'Orders', parent: 'root', relation: 'influence', value: null, previous: null, change_percent: null, correlation_with_parent: 0.9 },
    ]);
  });
});

describe('web rows', () => {
  it('breakdown rows keep value, visitors and events', () => {
    expect(breakdownCsvRows([{ value: '/pricing', visitors: 5, events: 9 }])).toEqual([{ value: '/pricing', visitors: 5, events: 9 }]);
  });

  it('goal rows use plain column names', () => {
    expect(goalsCsvRows([{ label: 'Signed up', conversions: 12, uniqueConverters: 10, conversionRate: 0.05 }])).toEqual([
      { goal: 'Signed up', conversions: 12, unique_converters: 10, conversion_rate: 0.05 },
    ]);
  });
});
