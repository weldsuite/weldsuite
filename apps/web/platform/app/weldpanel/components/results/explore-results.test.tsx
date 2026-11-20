import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelFunnelSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { makeFunnelResult, makeRetentionResult, makeTrendsResult } from '../../analytics-fixtures';
import { makeCorrelationResult } from '../../explore-fixtures';
import { parseBucketEdges, completeBreakdowns } from '../breakdown-picker';
import { CorrelationResultView, correlationRecordingsSearch } from './correlation-result';
import { FunnelResultView } from './funnel-result';
import { RetentionResultView, retentionCurve } from './retention-result';
import { TrendsResultView, trendLines, trendsSeriesLabel } from './trends-result';
import { formatVital } from './vitals-result';

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

const funnelSpec = {
  kind: 'funnel',
  projectId: 'wpp_1',
  dateRange: { preset: '30d' },
  steps: [{ event: '$pageview' }, { event: 'Signed up' }],
} as unknown as PanelFunnelSpec;

describe('trends', () => {
  it('label lines with their breakdown values, `Other` translated', () => {
    expect(trendsSeriesLabel({ label: 'Signed up', breakdownValue: 'NL / mobile', breakdownParts: ['NL', 'mobile'] }, 'Other')).toBe('Signed up · NL / mobile');
    expect(trendsSeriesLabel({ label: 'Signed up', breakdownValue: 'Other' }, 'Overig')).toBe('Signed up · Overig');
  });

  it('draw formulas next to the series, and a formula without value as a dash', () => {
    const result = makeTrendsResult({
      formulas: [{ formulaIndex: 0, label: '', expression: 'A / B', breakdownValue: null, total: null, points: [{ bucket: '2026-11-12', value: null }], previous: null }],
    });
    const lines = trendLines(result, 'Other');
    expect(lines.map((l) => [l.kind, l.label])).toEqual([
      ['series', 'Signed up'],
      ['formula', 'A / B'],
    ]);
    render(<TrendsResultView result={result} chartType="table" />);
    expect(screen.getByText('A / B')).toBeTruthy();
    expect(screen.getAllByText('–').length).toBeGreaterThan(0);
  });

  it('show formulas only when the series are left out', () => {
    const result = makeTrendsResult({
      series: [],
      formulas: [{ formulaIndex: 0, label: 'Conversion', expression: 'B / A * 100', breakdownValue: null, total: 12.5, points: [], previous: null }],
    });
    render(<TrendsResultView result={result} chartType="number" />);
    expect(screen.getByText('Conversion')).toBeTruthy();
    expect(screen.getByText('12.5')).toBeTruthy();
  });
});

describe('funnel displays', () => {
  it('mark optional steps', () => {
    const base = makeFunnelResult();
    const result = makeFunnelResult({ steps: [base.steps[0]!, { ...base.steps[1]!, optional: true }] });
    render(<FunnelResultView result={result} spec={funnelSpec} projectId="wpp_1" />);
    expect(screen.getByText(en.weldpanel.explore.funnels.optionalBadge)).toBeTruthy();
  });

  it('show the conversion over time', () => {
    const result = makeFunnelResult({ trend: [{ bucket: '2026-11-12', entered: 200, converted: 50, conversion: 0.25 }], interval: 'day' });
    render(<FunnelResultView result={result} spec={{ ...funnelSpec, display: 'trends' }} projectId="wpp_1" />);
    expect(screen.getByText('200')).toBeTruthy();
    expect(screen.getByText('25%')).toBeTruthy();
  });

  it('show how long converting took', () => {
    const stats = { count: 40, medianSeconds: 90, p90Seconds: 600, avgSeconds: 200, histogram: [{ fromSeconds: 0, toSeconds: 60, count: 10 }, { fromSeconds: 60, toSeconds: null, count: 30 }] };
    const result = makeFunnelResult({ timeToConvert: { overall: stats, steps: [{ ...stats, index: 1 }] } });
    render(<FunnelResultView result={result} spec={{ ...funnelSpec, display: 'time_to_convert' }} projectId="wpp_1" />);
    expect(screen.getByText('1m 30s')).toBeTruthy();
    expect(screen.getByText('10m 00s')).toBeTruthy();
  });

  it('correlation rows that go with dropping off link to those recordings', () => {
    render(<CorrelationResultView result={makeCorrelationResult()} spec={funnelSpec} projectId="wpp_1" canWatch />);
    expect(screen.getByText('Watched demo')).toBeTruthy();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
    const search = correlationRecordingsSearch(funnelSpec, makeCorrelationResult().events[1]!, 'wpp_1');
    expect(search).toMatchObject({ did: ['$pageview', 'Opened pricing'], didNot: ['Signed up'], range: '30d' });
    expect(correlationRecordingsSearch(funnelSpec, makeCorrelationResult().properties[0]!)).toMatchObject({ countries: ['DE'] });
  });
});

describe('retention', () => {
  it('draws a curve next to the grid, one line per breakdown value', () => {
    const base = makeRetentionResult();
    const result = makeRetentionResult({ breakdowns: [{ value: 'NL', cohorts: base.cohorts, averageRetention: [1, 0.5, 0.25] }] });
    const curve = retentionCurve(result, 'Week {n}', 'Average', 'Other');
    expect(curve.series).toEqual([{ key: 'b0', label: 'NL' }]);
    expect(curve.data[1]).toEqual({ label: 'Week 1', b0: 0.5 });
    render(<RetentionResultView result={result} />);
    expect(screen.getByText('Breakdown: NL')).toBeTruthy();
    expect(screen.getByText(en.weldpanel.explore.retention.curve)).toBeTruthy();
  });
});

describe('helpers', () => {
  it('format web vitals', () => {
    expect(formatVital(2340, 'ms', 'en')).toBe('2.34 s');
    expect(formatVital(180, 'ms', 'en')).toBe('180 ms');
    expect(formatVital(0.1, 'unitless', 'en')).toBe('0.10');
    expect(formatVital(null, 'ms', 'en')).toBe('–');
  });

  it('read bucket edges and keep only complete breakdowns', () => {
    expect(parseBucketEdges('10, 50 100')).toEqual([10, 50, 100]);
    expect(parseBucketEdges('50, 10')).toBeNull();
    expect(parseBucketEdges('a')).toBeNull();
    expect(completeBreakdowns([{ source: 'event', key: '' }, { source: 'column', field: 'country' }])).toEqual([{ source: 'column', field: 'country' }]);
    expect(completeBreakdowns([{ source: 'event', key: 'amount', bucket: { kind: 'custom', edges: [] } }])).toBeUndefined();
  });
});
