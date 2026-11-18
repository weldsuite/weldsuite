import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { explainPanelChangeSchema, panelMetricTreeValuesSchema, panelSavedMetricTreeValuesSchema } from './weldpanel-analysis';

/** The issues a parse reports, as `path: message`. Empty when it parses. */
function issuesOf(schema: ZodTypeAny, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

const projectId = 'pnp_1';
const TRENDS = { kind: 'trends', projectId, series: [{ event: 'Signed up' }] };
const EXPLAIN = { projectId, spec: TRENDS };

describe('explaining a change', () => {
  it('explains the whole range against the period before by default', () => {
    expect(explainPanelChangeSchema.parse(EXPLAIN)).toMatchObject({ properties: [], limit: 5, narrate: false, regenerate: false });
  });

  it('explains one hour or day bucket, or a period of days', () => {
    expect(explainPanelChangeSchema.safeParse({ ...EXPLAIN, bucket: '2026-11-01' }).success).toBe(true);
    expect(explainPanelChangeSchema.safeParse({ ...EXPLAIN, bucket: '2026-11-01T14:00' }).success).toBe(true);
    expect(explainPanelChangeSchema.safeParse({ ...EXPLAIN, period: { from: '2026-11-01', to: '2026-11-07' } }).success).toBe(true);
    expect(issuesOf(explainPanelChangeSchema, { ...EXPLAIN, bucket: '2026-11-01T14:30' })).toEqual([
      'bucket: Use a bucket label (YYYY-MM-DD or YYYY-MM-DDTHH:00)',
    ]);
    expect(issuesOf(explainPanelChangeSchema, { ...EXPLAIN, period: { from: '2026-11-07', to: '2026-11-01' } })).toEqual([
      'period: `from` must not be after `to`',
    ]);
  });

  it('takes a bucket or a period, not both', () => {
    expect(issuesOf(explainPanelChangeSchema, { ...EXPLAIN, bucket: '2026-11-01', period: { from: '2026-11-01', to: '2026-11-07' } })).toEqual([
      'period: Choose a bucket or a period, not both',
    ]);
  });

  it('needs the spec of the same project', () => {
    expect(issuesOf(explainPanelChangeSchema, { ...EXPLAIN, spec: { ...TRENDS, projectId: 'pnp_2' } })).toEqual([
      'spec.projectId: The spec names another project',
    ]);
  });

  it('explains one series at a time', () => {
    expect(issuesOf(explainPanelChangeSchema, { ...EXPLAIN, spec: { ...TRENDS, series: [{ event: 'A' }, { event: 'B' }] } })).toEqual([
      'spec.series: Explain one series at a time',
    ]);
  });

  it('works on counts and sums only', () => {
    expect(explainPanelChangeSchema.safeParse({ ...EXPLAIN, spec: { ...TRENDS, series: [{ event: 'Purchase', math: 'sum', property: 'price' }] } }).success).toBe(
      true,
    );
    expect(issuesOf(explainPanelChangeSchema, { ...EXPLAIN, spec: { ...TRENDS, series: [{ event: 'Purchase', math: 'avg', property: 'price' }] } })).toEqual([
      'spec.series.0.math: Root cause works on counts and sums',
    ]);
  });

  it('looks at up to three event or person properties besides the standard dimensions', () => {
    const properties = [
      { source: 'event', key: 'plan' },
      { source: 'person', key: '$email', limit: 3 },
    ];
    expect(explainPanelChangeSchema.parse({ ...EXPLAIN, properties }).properties).toEqual([
      { source: 'event', key: 'plan', limit: 10 },
      { source: 'person', key: '$email', limit: 3 },
    ]);
    expect(issuesOf(explainPanelChangeSchema, { ...EXPLAIN, properties: [{ source: 'column', field: 'country' }] })).toEqual([
      'properties: Use event or person properties',
    ]);
  });
});

describe('metric tree values', () => {
  const nodes = [{ id: 'root', label: 'Sign-ups', parentId: null, relation: null, metric: { spec: TRENDS } }];

  it('previews unsaved nodes over a period', () => {
    expect(panelMetricTreeValuesSchema.parse({ projectId, nodes, dateRange: { preset: '7d' }, timezone: 'Europe/Amsterdam' })).toMatchObject({
      dateRange: { preset: '7d' },
      timezone: 'Europe/Amsterdam',
    });
    expect(issuesOf(panelMetricTreeValuesSchema, { projectId, nodes: [{ ...nodes[0], relation: 'sum' }] })).toEqual([
      'nodes: The root has no relation',
    ]);
  });

  it('reads a saved tree over the default or a given period', () => {
    expect(panelSavedMetricTreeValuesSchema.parse({})).toEqual({});
    expect(panelSavedMetricTreeValuesSchema.parse({ dateRange: { from: '2026-10-01', to: '2026-10-31' } })).toEqual({
      dateRange: { from: '2026-10-01', to: '2026-10-31' },
    });
    expect(panelSavedMetricTreeValuesSchema.safeParse({ timezone: '' }).success).toBe(false);
  });
});
