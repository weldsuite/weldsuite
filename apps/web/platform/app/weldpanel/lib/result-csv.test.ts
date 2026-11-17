import { describe, expect, it } from 'vitest';
import type { PanelHeatmapResult, PanelSessionRow, PanelVitalsResult } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { RANGE, makeFlowsResult, makeFunnelResult, makeRetentionResult, makeTrendsResult, makeWebResult } from '../analytics-fixtures';
import { resultCsvRows } from './result-csv';

describe('resultCsvRows', () => {
  it('web: one row per bucket, with the previous period beside it when there is one', () => {
    expect(resultCsvRows({ kind: 'web', result: makeWebResult({ previousSeries: [{ bucket: '2026-10-12', visitors: 30, pageviews: 90 }] }) })).toEqual([
      { bucket: '2026-11-12', visitors: 40, pageviews: 120, previous_visitors: 30, previous_pageviews: 90 },
      { bucket: '2026-11-13', visitors: 55, pageviews: 150, previous_visitors: null, previous_pageviews: null },
    ]);
    expect(resultCsvRows({ kind: 'web', result: makeWebResult({ previousSeries: undefined }) })[0]).toEqual({ bucket: '2026-11-12', visitors: 40, pageviews: 120 });
  });

  it('trends: a row per point of every series and formula, named by label or expression', () => {
    const result = makeTrendsResult({
      formulas: [
        { formulaIndex: 0, label: '', expression: 'A / 2', breakdownValue: 'NL', total: 60, points: [{ bucket: '2026-11-12', value: null }], previous: null },
      ],
    });
    expect(resultCsvRows({ kind: 'trends', result })).toEqual([
      { series: 'Signed up', breakdown: null, bucket: '2026-11-12', value: 50 },
      { series: 'Signed up', breakdown: null, bucket: '2026-11-13', value: 70 },
      { series: 'A / 2', breakdown: 'NL', bucket: '2026-11-12', value: null },
    ]);
  });

  it('funnel: the steps of each breakdown value when there are some', () => {
    const funnel = makeFunnelResult();
    const result = makeFunnelResult({ breakdowns: [{ value: 'NL', steps: [{ ...funnel.steps[0]!, label: '' }], overallConversion: 1 }] });
    expect(resultCsvRows({ kind: 'funnel', result })).toEqual([
      { breakdown: 'NL', step: 1, event: '$pageview', count: 1000, conversion_from_previous: 1, conversion_from_first: 1, dropped_off: 0, avg_seconds_from_previous: null },
    ]);
    expect(resultCsvRows({ kind: 'funnel', result: makeFunnelResult({ breakdowns: [] }) })[0]).toMatchObject({ breakdown: null, step: 1 });
  });

  it('retention: periods named after the interval', () => {
    expect(resultCsvRows({ kind: 'retention', result: makeRetentionResult({ interval: 'month' }) })[1]).toEqual({ cohort: '2026-10-26', size: 80, month_0: 80, month_1: 30 });
  });

  it('flows: a column per step, with the dropped-off steps empty', () => {
    expect(resultCsvRows({ kind: 'flows', result: makeFlowsResult() })[1]).toEqual({ count: 25, step_1: '/docs', step_2: null });
  });

  it('stickiness and lifecycle: one row per bucket', () => {
    expect(
      resultCsvRows({
        kind: 'stickiness',
        result: { range: RANGE, interval: 'week', measure: 'intervals', total: 10, intervalsInRange: 4, buckets: [{ label: '2', from: 2, to: 2, count: 10, share: 1 }] },
      }),
    ).toEqual([{ bucket: '2', from: 2, to: 2, count: 10, share: 1 }]);
    expect(
      resultCsvRows({
        kind: 'lifecycle',
        result: { range: RANGE, interval: 'day', buckets: [{ bucket: '2026-11-12', new: 1, returning: 2, resurrecting: 3, dormant: 4 }], totals: { new: 1, returning: 2, resurrecting: 3, dormant: 4 } },
      }),
    ).toEqual([{ bucket: '2026-11-12', new: 1, returning: 2, resurrecting: 3, dormant: 4 }]);
  });

  it('vitals: the series, with the metric as its column', () => {
    const result: PanelVitalsResult = {
      range: RANGE,
      interval: 'day',
      metric: 'cls',
      percentile: 'p90',
      unit: 'unitless',
      thresholds: { good: 0.1, poor: 0.25 },
      value: 0.05,
      rating: 'good',
      samples: 8,
      shares: { good: 1, needsImprovement: 0, poor: 0 },
      score: 99,
      series: [{ bucket: '2026-11-12', value: 0.05, samples: 8 }],
      paths: [],
      elements: [],
      countries: [],
      devices: [],
    };
    expect(resultCsvRows({ kind: 'vitals', result })).toEqual([{ bucket: '2026-11-12', cls: 0.05, samples: 8 }]);
  });

  it('impact: adoption per bucket', () => {
    const group = { users: 1, before: null, after: null, change: null };
    expect(
      resultCsvRows({
        kind: 'impact',
        result: {
          range: RANGE,
          launchDate: '2026-11-01',
          windowDays: 7,
          adoption: [{ bucket: '2026-11-02', newAdopters: 3, adopters: 5, rate: 0.25 }],
          adopters: group,
          nonAdopters: group,
          differenceInDifferences: null,
          relativeImpact: null,
        },
      }),
    ).toEqual([{ bucket: '2026-11-02', new_adopters: 3, adopters: 5, rate: 0.25 }]);
  });

  it('signal: one row per candidate', () => {
    expect(
      resultCsvRows({
        kind: 'signal',
        result: {
          range: RANGE,
          goal: 'Paid',
          windowDays: 7,
          users: 10,
          goalUsers: 2,
          goalRate: 0.2,
          candidates: [{ event: 'Invited', didUsers: 4, didGoalRate: 0.5, didNotUsers: 6, didNotGoalRate: 0, lift: null, correlation: null }],
        },
      }),
    ).toEqual([{ event: 'Invited', did_users: 4, did_goal_rate: 0.5, did_not_users: 6, did_not_goal_rate: 0, lift: null, correlation: null }]);
  });

  it('funnel correlation: events, then properties', () => {
    const base = { successCount: 3, failureCount: 1, successRateWith: 0.75, successRateWithout: 0.4, oddsRatio: 2 };
    const rows = resultCsvRows({
      kind: 'funnel_correlation',
      result: {
        range: RANGE,
        converted: 4,
        dropped: 6,
        events: [{ type: 'event', property: null, value: 'Viewed docs', correlation: 'positive', ...base }],
        properties: [{ type: 'property', property: 'browser', value: 'Safari', correlation: 'negative', ...base }],
      },
    });
    expect(rows).toEqual([
      { type: 'event', property: null, value: 'Viewed docs', success_count: 3, failure_count: 1, success_rate_with: 0.75, success_rate_without: 0.4, odds_ratio: 2, correlation: 'positive' },
      { type: 'property', property: 'browser', value: 'Safari', success_count: 3, failure_count: 1, success_rate_with: 0.75, success_rate_without: 0.4, odds_ratio: 2, correlation: 'negative' },
    ]);
  });

  it('sessions: one row per session, without the person', () => {
    const session: PanelSessionRow = {
      sessionId: 'sess_1',
      startedAt: '2026-11-12T10:00:00.000Z',
      endedAt: '2026-11-12T10:05:00.000Z',
      durationSeconds: 300,
      pageviews: 4,
      clicks: 10,
      events: 20,
      rageClicks: 0,
      deadClicks: 0,
      quickBacks: 0,
      excessiveScrolls: 0,
      errors: 0,
      entryPage: '/',
      exitPage: '/pricing',
      deviceType: 'mobile',
      browser: 'Safari',
      os: 'iOS',
      country: 'NL',
      distinctId: 'anon_1',
      userId: null,
      hasRecording: true,
      chunkCount: 2,
      favorite: false,
    };
    expect(resultCsvRows({ kind: 'sessions', result: { range: RANGE, sessions: [session], hasMore: false, nextCursor: null } })).toEqual([
      { session_id: 'sess_1', started_at: '2026-11-12T10:00:00.000Z', duration_seconds: 300, pageviews: 4, entry_page: '/', exit_page: '/pricing', country: 'NL', device: 'mobile' },
    ]);
  });

  it('heatmap: no rows', () => {
    const heatmap: PanelHeatmapResult = {
      range: RANGE,
      type: 'click',
      deviceClass: 'desktop',
      urlPattern: '/pricing',
      pageviews: 10,
      clicks: 4,
      elements: [],
      points: [],
      scroll: { leaves: 0, buckets: [] },
    };
    expect(resultCsvRows({ kind: 'heatmap', result: heatmap })).toEqual([]);
  });
});
