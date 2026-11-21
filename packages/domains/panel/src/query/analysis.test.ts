/**
 * Section B of the WeldPanel gaps: what the new spec options compile to (the
 * pieces that matter: custom events, computed properties, groups, path rules,
 * buckets) and how fake Basin rows become results for every new kind and
 * option. Isolation of every statement is in compile.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  panelQuerySpecSchema,
  panelReportSpecSchema,
  type PanelQueryResult,
  type PanelQuerySpec,
  type ParsedTrendsSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import {
  applyPathRules,
  autoEdges,
  explainDimensions,
  explainFrom,
  explainQueries,
  explainWindows,
  pathRuleProblem,
  resolveRange,
  runPanelQuery,
  signalCandidate,
  specReferences,
  vitalsScore,
  PanelQueryError,
  type PanelQueryContext,
  type PanelSqlQuery,
  type RawRow,
} from './index';

const NOW = new Date('2026-11-14T12:00:00Z');
const ctx: PanelQueryContext = {
  workspaceId: 'ws_1',
  projectId: 'pnp_1',
  retentionDays: 365,
  hasIdentifiedUsers: false,
  erasedIds: [],
  now: NOW,
  customEvents: {
    pnce_signup: {
      match: [
        { event: 'Signed up', filters: [] },
        { event: '$pageview', filters: [{ source: 'column', field: 'path', operator: 'eq', value: '/welcome' }] },
      ],
    },
  },
  computedProperties: {
    pncp_revenue: { kind: 'formula', expression: 'price * quantity / 100' },
    pncp_label: { kind: 'coalesce', keys: [{ source: 'event', key: 'label' }, { source: 'column', field: 'title' }] },
    pncp_broken: { kind: 'formula', expression: 'price *' },
  },
  pathRules: [
    { pattern: '^/users/\\d+', replacement: '/users/:id' },
    { pattern: "/o'rders/[0-9]+", replacement: '/orders/:id' },
  ],
  groupTypes: ['company'],
};

async function run(spec: PanelQuerySpec, canned: Record<string, RawRow[]> = {}, context = ctx): Promise<{ result: PanelQueryResult; sent: PanelSqlQuery[] }> {
  const sent: PanelSqlQuery[] = [];
  const out = await runPanelQuery(panelQuerySpecSchema.parse(spec), context, async (q) => {
    sent.push(q);
    return { rows: canned[q.name] ?? [] };
  });
  return { result: out.result, sent };
}

const sqlOf = (sent: PanelSqlQuery[], name: string) => sent.find((q) => q.name === name)?.sql ?? '';

describe('saved specs from before still parse, unchanged', () => {
  const OLD: PanelQuerySpec[] = [
    { kind: 'web', projectId: 'p', dateRange: { preset: '30d' }, compare: true, limit: 10, filters: [] },
    {
      kind: 'trends',
      projectId: 'p',
      series: [{ event: '$pageview', math: 'unique_users' }, { event: 'Purchase', math: 'sum', property: 'amount' }],
      breakdown: { source: 'person', key: 'plan', limit: 5 },
      interval: 'week',
      display: 'bar',
    },
    { kind: 'funnel', projectId: 'p', steps: [{ event: 'A' }, { event: 'B' }], window: { value: 2, unit: 'hour' }, order: 'strict', breakdown: { source: 'column', field: 'country' } },
    { kind: 'retention', projectId: 'p', firstEvent: 'Signed up', returnEvent: 'Login', interval: 'month', periods: 6 },
    { kind: 'flows', projectId: 'p', anchor: { event: 'Purchase' }, direction: 'before', depth: 4, scope: 'pageviews' },
  ];
  const NEW_KEYS = ['breakdowns', 'formulas', 'formulaOnly', 'cleanPaths', 'panels', 'goals', 'exclusions', 'holdConstant', 'aggregateBy', 'mode', 'unbounded'];

  it('parses with the report schema and gains no new keys (so cache keys stay the same)', () => {
    for (const spec of OLD) {
      const parsed = panelReportSpecSchema.parse(spec) as Record<string, unknown>;
      for (const key of NEW_KEYS) expect(parsed, `${spec.kind}.${key}`).not.toHaveProperty(key);
      const steps = parsed.steps as Record<string, unknown>[] | undefined;
      for (const step of steps ?? []) expect(step).not.toHaveProperty('optional');
    }
  });

  it('saves the new report kinds, not funnel correlation', () => {
    expect(panelReportSpecSchema.safeParse({ kind: 'stickiness', projectId: 'p', event: 'A' }).success).toBe(true);
    expect(panelReportSpecSchema.safeParse({ kind: 'impact', projectId: 'p', launchEvent: 'A', launchDate: '2026-11-01', metric: { event: 'B' } }).success).toBe(true);
    expect(panelReportSpecSchema.safeParse({ kind: 'funnel_correlation', projectId: 'p', steps: [{ event: 'A' }, { event: 'B' }] }).success).toBe(false);
  });

  it('refuses what does not make sense', () => {
    const bad: unknown[] = [
      { kind: 'funnel', projectId: 'p', steps: [{ event: 'A', optional: true }, { event: 'B' }] },
      { kind: 'funnel', projectId: 'p', steps: [{ event: 'A' }, { event: 'B' }], exclusions: [{ event: 'X', fromStep: 0, toStep: 3 }] },
      { kind: 'funnel', projectId: 'p', steps: [{ event: 'A' }, { event: 'B' }], order: 'any', exclusions: [{ event: 'X', fromStep: 0, toStep: 1 }] },
      { kind: 'trends', projectId: 'p', series: [{ event: 'A' }], breakdown: { source: 'column', field: 'path' }, breakdowns: [{ source: 'column', field: 'path' }] },
      { kind: 'trends', projectId: 'p', series: [{ event: 'A' }], formulaOnly: true },
      { kind: 'trends', projectId: 'p', series: [{ event: 'A', math: 'unique_groups' }] },
      { kind: 'trends', projectId: 'p', series: [{ event: 'A' }], formulas: [{ expression: "A'; DROP" }] },
      { kind: 'trends', projectId: 'p', series: [{ event: '@pnce_x;' }] },
      { kind: 'trends', projectId: 'p', series: [{ event: 'A' }], breakdowns: [{ source: 'event', key: 'n', bucket: { kind: 'custom', edges: [5, 1] } }] },
      { kind: 'web', projectId: 'p', filters: [{ source: 'group', groupType: 'Company', key: 'plan', operator: 'eq', value: 'x' }] },
      { kind: 'web', projectId: 'p', goals: [{ label: 'x' }] },
    ];
    for (const spec of bad) expect(panelQuerySpecSchema.safeParse(spec).success, JSON.stringify(spec)).toBe(false);
  });
});

describe('references compile from the context, never from the spec', () => {
  it('expands a custom event into its events and filters, and pre-filters by name', async () => {
    const { sent } = await run({ kind: 'trends', projectId: 'pnp_1', series: [{ event: '@pnce_signup' }] });
    const sql = sqlOf(sent, 'trends.series');
    expect(sql).toContain("COUNT(CASE WHEN ((e.name = 'Signed up') OR (e.name = '$pageview' AND (e.path = '/welcome'))) THEN 1 END)");
    expect(sql).toContain("e.name IN ('Signed up', '$pageview')");
  });

  it('refuses a custom event or computed property the context does not hold', async () => {
    await expect(run({ kind: 'trends', projectId: 'pnp_1', series: [{ event: '@pnce_other' }] })).rejects.toThrow('custom event does not exist');
    await expect(
      run({ kind: 'web', projectId: 'pnp_1', filters: [{ source: 'event', key: '@pncp_other', operator: 'is_set' }] }),
    ).rejects.toThrow('computed property does not exist');
    await expect(
      run({ kind: 'trends', projectId: 'pnp_1', series: [{ event: 'A', math: 'sum', property: '@pncp_broken' }] }),
    ).rejects.toThrow(PanelQueryError);
  });

  it('writes a formula computed property through the expression compiler, division by zero as NULL', async () => {
    const { sent } = await run({ kind: 'trends', projectId: 'pnp_1', series: [{ event: 'Purchase', math: 'sum', property: '@pncp_revenue' }] });
    expect(sqlOf(sent, 'trends.series')).toContain(
      "SUM(CASE WHEN e.name = 'Purchase' THEN (((json_get_float(e.properties, 'price')) * (json_get_float(e.properties, 'quantity'))) / NULLIF(100.0, 0)) END)",
    );
  });

  it('writes a coalesce computed property over properties and columns', async () => {
    const { sent } = await run({ kind: 'web', projectId: 'pnp_1', filters: [{ source: 'event', key: '@pncp_label', operator: 'eq', value: "it's" }] });
    expect(sent[0]?.sql).toContain("(COALESCE(json_get_str(e.properties, 'label'), CAST(e.title AS VARCHAR)) = 'it''s')");
  });

  it('joins the latest group profile for group filters and breakdowns, and refuses unknown group types', async () => {
    const { sent } = await run({
      kind: 'trends',
      projectId: 'pnp_1',
      filters: [{ source: 'group', groupType: 'company', key: 'plan', operator: 'eq', value: 'pro' }],
      series: [{ event: 'A', math: 'unique_groups', groupType: 'company' }],
    });
    const sql = sqlOf(sent, 'trends.series');
    expect(sql).toContain('FROM panel.groups_v1 WHERE workspace_id = ');
    expect(sql).toContain("group_type = 'company'");
    expect(sql).toContain("g_company ON g_company.group_key = json_get_str(e.properties, '$group_company')");
    expect(sql).toContain("(json_get_str(g_company.properties, 'plan') = 'pro')");
    expect(sql).toContain("COUNT(DISTINCT CASE WHEN e.name = 'A' AND json_get_str(e.properties, '$group_company') IS NOT NULL THEN json_get_str(e.properties, '$group_company') END)");
    await expect(
      run({ kind: 'web', projectId: 'pnp_1', filters: [{ source: 'group_key', groupType: 'team', operator: 'is_set' }] }),
    ).rejects.toThrow('group type does not exist');
  });

  it('cleans paths with the rules in order, every pattern through lit(), unless switched off', async () => {
    const { sent } = await run({ kind: 'web', projectId: 'pnp_1' });
    const top = sqlOf(sent, 'web.topPages');
    expect(top).toContain(
      "regexp_replace(regexp_replace(e.path, ('^/users/' || chr(92) || 'd+'), '/users/:id', 'g'), '/o''rders/[0-9]+', '/orders/:id', 'g')",
    );
    expect(sqlOf(sent, 'web.entryExit')).toContain('regexp_replace(');
    const off = await run({ kind: 'web', projectId: 'pnp_1', cleanPaths: false });
    expect(off.sent.some((q) => q.sql.includes('regexp_replace'))).toBe(false);
  });

  it('refuses path rules the engine cannot run', async () => {
    for (const pattern of ['(?=x)', '(a)\\1', '[', 'x*']) {
      await expect(run({ kind: 'flows', projectId: 'pnp_1', anchor: { event: 'A' } }, {}, { ...ctx, pathRules: [{ pattern, replacement: '' }] })).rejects.toThrow(
        PanelQueryError,
      );
    }
    expect(pathRuleProblem({ pattern: '/a', replacement: '$&' })).toContain('$1');
    expect(pathRuleProblem({ pattern: '^/users/\\d+', replacement: '/users/:id' })).toBeNull();
    expect(applyPathRules('/users/42/settings', ctx.pathRules ?? [])).toBe('/users/:id/settings');
  });

  it('buckets numbers with custom edges and auto edges from a first statement', async () => {
    const custom = await run({ kind: 'trends', projectId: 'pnp_1', series: [{ event: 'A' }], breakdown: { source: 'event', key: 'amount', bucket: { kind: 'custom', edges: [10, 50] } } });
    expect(sqlOf(custom.sent, 'trends.breakdownValues')).toContain(
      "CASE WHEN json_get_float(e.properties, 'amount') IS NULL THEN '(none)' WHEN json_get_float(e.properties, 'amount') < 10 THEN '< 10' WHEN json_get_float(e.properties, 'amount') < 50 THEN '10 – 50' ELSE '≥ 50' END",
    );
    const auto = await run(
      { kind: 'trends', projectId: 'pnp_1', series: [{ event: 'A' }], breakdown: { source: 'event', key: 'amount', bucket: { kind: 'auto', count: 4 } } },
      { 'trends.breakdownRange': [{ min0: 3, max0: 97 }] },
    );
    expect(auto.sent.map((q) => q.name)).toEqual(['trends.breakdownRange', 'trends.breakdownValues', 'trends.series', 'trends.totals']);
    expect(sqlOf(auto.sent, 'trends.breakdownValues')).toContain("< 25 THEN '< 25'");
    expect(autoEdges(3, 97, 4)).toEqual([25, 50, 75]);
    expect(autoEdges(5, 5, 4)).toEqual([5]);
  });

  it('collects what a spec refers to, for panel-api to load', () => {
    const refs = specReferences(
      panelQuerySpecSchema.parse({
        kind: 'funnel',
        projectId: 'p',
        filters: [{ source: 'cohort', cohortId: 'pnc_1' }],
        steps: [{ event: '@pnce_a' }, { event: 'B', filters: [{ source: 'event', key: '@pncp_x', operator: 'is_set' }] }],
        exclusions: [{ event: '@pnce_b', fromStep: 0, toStep: 1 }],
        breakdowns: [{ source: 'column', field: 'path' }],
        aggregateBy: { groupType: 'company' },
      }),
    );
    expect(refs).toEqual({
      cohortIds: ['pnc_1'],
      customEventIds: ['pnce_a', 'pnce_b'],
      computedPropertyIds: ['pncp_x'],
      groupTypes: ['company'],
      usesPathRules: true,
    });
  });
});

describe('trends results', () => {
  it('evaluates formulas per bucket and on the totals, null where it divides by zero', async () => {
    const { result } = await run(
      {
        kind: 'trends',
        projectId: 'pnp_1',
        dateRange: { from: '2026-11-10', to: '2026-11-11' },
        series: [{ event: 'A' }, { event: 'B' }],
        formulas: [{ expression: 'B / A * 100', label: 'Rate' }],
      },
      {
        'trends.series': [
          { bucket: '2026-11-10', s0_v: 4, s1_v: 1 },
          { bucket: '2026-11-11', s0_v: 0, s1_v: 3 },
        ],
        'trends.totals': [{ s0_v: 4, s1_v: 4 }],
      },
    );
    if (result.kind !== 'trends') throw new Error('kind');
    expect(result.result.series).toHaveLength(2);
    expect(result.result.formulas).toEqual([
      {
        formulaIndex: 0,
        label: 'Rate',
        expression: 'B / A * 100',
        breakdownValue: null,
        total: 100,
        points: [
          { bucket: '2026-11-10', value: 25 },
          { bucket: '2026-11-11', value: null },
        ],
        previous: null,
      },
    ]);
  });

  it('shows only the formulas with formulaOnly, and refuses a letter past the series', async () => {
    const { result } = await run({ kind: 'trends', projectId: 'pnp_1', series: [{ event: 'A' }], formulas: [{ expression: 'A * 2' }], formulaOnly: true });
    if (result.kind !== 'trends') throw new Error('kind');
    expect(result.result.series).toEqual([]);
    expect(result.result.formulas).toHaveLength(1);
    await expect(run({ kind: 'trends', projectId: 'pnp_1', series: [{ event: 'A' }], formulas: [{ expression: 'A / B' }] })).rejects.toThrow('no series B');
  });

  it('runs cumulative totals: summed for counts, first-seen for people', async () => {
    const { result, sent } = await run(
      {
        kind: 'trends',
        projectId: 'pnp_1',
        dateRange: { from: '2026-11-10', to: '2026-11-12' },
        series: [{ event: 'A' }, { event: 'A', math: 'unique_users' }],
        display: 'cumulative',
      },
      {
        'trends.series': [
          { bucket: '2026-11-10', s0_v: 2, s1_v: 2 },
          { bucket: '2026-11-11', s0_v: 3, s1_v: 2 },
          { bucket: '2026-11-12', s0_v: 1, s1_v: 1 },
        ],
        'trends.firstSeen.s1': [
          { bucket: '2026-11-10', n: 2 },
          { bucket: '2026-11-11', n: 1 },
        ],
      },
    );
    if (result.kind !== 'trends') throw new Error('kind');
    expect(result.result.cumulative).toBe(true);
    expect(result.result.series[0]?.points.map((p) => p.value)).toEqual([2, 5, 6]);
    expect(result.result.series[1]?.points.map((p) => p.value)).toEqual([2, 3, 3]);
    expect(sent.map((q) => q.name)).toContain('trends.firstSeen.s1');
    expect(sent.map((q) => q.name)).not.toContain('trends.firstSeen.s0');
  });

  it('joins several breakdowns with " / " and keeps their parts', async () => {
    const { result } = await run(
      {
        kind: 'trends',
        projectId: 'pnp_1',
        dateRange: { from: '2026-11-10', to: '2026-11-10' },
        series: [{ event: 'A' }],
        breakdowns: [{ source: 'column', field: 'country' }, { source: 'column', field: 'browser' }],
      },
      {
        'trends.breakdownValues': [{ value: 'NL / Chrome', v0: 'NL', v1: 'Chrome', n: 5 }],
        'trends.series': [{ bucket: '2026-11-10', bd: 'NL / Chrome', s0_v: 5 }, { bucket: '2026-11-10', bd: 'Other', s0_v: 1 }],
        'trends.totals': [{ bd: 'NL / Chrome', s0_v: 5 }, { bd: 'Other', s0_v: 1 }],
      },
    );
    if (result.kind !== 'trends') throw new Error('kind');
    expect(result.result.series.map((s) => [s.breakdownValue, s.breakdownParts, s.total])).toEqual([
      ['NL / Chrome', ['NL', 'Chrome'], 5],
      ['Other', null, 1],
    ]);
  });
});

describe('funnel results', () => {
  const steps = [{ event: 'A' }, { event: 'B', optional: true }, { event: 'C' }];

  it('measures conversion after an optional step against the last required one', async () => {
    const { result } = await run(
      { kind: 'funnel', projectId: 'pnp_1', steps },
      { 'funnel.steps': [{ step: 1, bd: '', persons: 10 }, { step: 2, bd: '', persons: 2 }, { step: 3, bd: '', persons: 5, avg_secs: 60 }] },
    );
    if (result.kind !== 'funnel') throw new Error('kind');
    expect(result.result.steps.map((s) => [s.count, s.conversionFromPrevious, s.optional ?? false])).toEqual([
      [10, 1, false],
      [2, 0.2, true],
      [5, 0.5, false],
    ]);
    expect(result.result.overallConversion).toBe(0.5);
  });

  it('adds time to convert (median, p90, histogram) per step and overall', async () => {
    const { result } = await run(
      { kind: 'funnel', projectId: 'pnp_1', steps: [{ event: 'A' }, { event: 'B' }], display: 'time_to_convert' },
      {
        'funnel.steps': [{ step: 1, bd: '', persons: 4 }, { step: 2, bd: '', persons: 2 }],
        'funnel.timeToConvert': [
          { step: 0, n: 2, p50: 45.4, p90: 80, avg_secs: 50, h0: 0, h1: 1, h2: 1 },
          { step: 2, n: 2, p50: 45.4, p90: 80, avg_secs: 50, h1: 1, h3: 1 },
        ],
      },
    );
    if (result.kind !== 'funnel') throw new Error('kind');
    const ttc = result.result.timeToConvert;
    expect(ttc?.overall).toMatchObject({ count: 2, medianSeconds: 45, p90Seconds: 80, avgSeconds: 50 });
    expect(ttc?.overall.histogram).toHaveLength(11);
    expect(ttc?.overall.histogram[1]).toEqual({ fromSeconds: 10, toSeconds: 30, count: 1 });
    expect(ttc?.overall.histogram[10]).toEqual({ fromSeconds: 604800, toSeconds: null, count: 0 });
    expect(ttc?.steps).toHaveLength(1);
    expect(ttc?.steps[0]?.index).toBe(1);
  });

  it('adds conversion per entry bucket for the trends display', async () => {
    const { result } = await run(
      { kind: 'funnel', projectId: 'pnp_1', dateRange: { from: '2026-11-10', to: '2026-11-11' }, steps: [{ event: 'A' }, { event: 'B' }], display: 'trends' },
      { 'funnel.trend': [{ bucket: '2026-11-10 00:00:00', entered: 4, converted: 1 }] },
    );
    if (result.kind !== 'funnel') throw new Error('kind');
    expect(result.result.interval).toBe('day');
    expect(result.result.trend).toEqual([
      { bucket: '2026-11-10', entered: 4, converted: 1, conversion: 0.25 },
      { bucket: '2026-11-11', entered: 0, converted: 0, conversion: 0 },
    ]);
  });

  it('ranks correlated events and properties by odds ratio, with the group sizes from the $total row', async () => {
    const { result } = await run(
      { kind: 'funnel_correlation', projectId: 'pnp_1', steps: [{ event: 'A' }, { event: 'B' }], limit: 1 },
      {
        'correlation.events': [
          { value: 'Watched demo', success: 40, failure: 10 },
          { value: 'Opened help', success: 5, failure: 45 },
          { value: 'Rare', success: 1, failure: 0 },
          { value: 'Neutral', success: 25, failure: 25 },
        ],
        'correlation.properties': [
          { prop: '$total', value: '', success: 50, failure: 50 },
          { prop: 'country', value: 'NL', success: 30, failure: 10 },
        ],
      },
    );
    if (result.kind !== 'funnel_correlation') throw new Error('kind');
    expect(result.result.converted).toBe(50);
    expect(result.result.dropped).toBe(50);
    expect(result.result.events.map((r) => [r.value, r.correlation])).toEqual([
      ['Opened help', 'negative'],
      ['Watched demo', 'positive'],
    ]);
    const demo = result.result.events.find((r) => r.value === 'Watched demo');
    expect(demo?.successRateWith).toBe(0.8);
    expect(demo?.successRateWithout).toBe(0.2);
    expect(result.result.properties[0]).toMatchObject({ type: 'property', property: 'country', value: 'NL', correlation: 'positive' });
  });
});

describe('retention results', () => {
  it('counts people in period N or later when unbounded', async () => {
    const { result } = await run(
      { kind: 'retention', projectId: 'pnp_1', dateRange: { from: '2026-11-02', to: '2026-11-14' }, firstEvent: 'A', interval: 'week', periods: 2, unbounded: true },
      {
        'retention.sizes': [{ cohort: '2026-11-02', size: 10 }],
        'retention.returns': [
          { cohort: '2026-11-02', period: 0, n: 3 },
          { cohort: '2026-11-02', period: 2, n: 2 },
          { cohort: '2026-11-02', period: 5, n: 1 },
        ],
      },
    );
    if (result.kind !== 'retention') throw new Error('kind');
    expect(result.result.cohorts[0]?.counts).toEqual([6, 3, 3]);
    expect(result.result.unbounded).toBe(true);
  });

  it('splits the table by breakdown value', async () => {
    const { result, sent } = await run(
      { kind: 'retention', projectId: 'pnp_1', dateRange: { from: '2026-11-02', to: '2026-11-14' }, firstEvent: 'A', periods: 1, breakdown: { source: 'column', field: 'country' }, mode: 'first_time' },
      {
        'retention.breakdownValues': [{ value: 'NL', n: 4 }],
        'retention.sizes': [{ cohort: '2026-11-02', bd: 'NL', size: 4 }, { cohort: '2026-11-02', bd: 'Other', size: 2 }],
        'retention.returns': [{ cohort: '2026-11-02', bd: 'NL', period: 1, n: 2 }],
      },
    );
    if (result.kind !== 'retention') throw new Error('kind');
    expect(result.result.cohorts[0]?.size).toBe(6);
    expect(result.result.breakdowns?.map((b) => [b.value, b.cohorts[0]?.size, b.cohorts[0]?.counts])).toEqual([
      ['NL', 4, [0, 2]],
      ['Other', 2, [0, 0]],
    ]);
    expect(sqlOf(sent, 'retention.sizes')).toContain('HAVING MIN(e.ts) >= TIMESTAMP');
    expect(result.result.mode).toBe('first_time');
  });
});

describe('stickiness, lifecycle, vitals, impact and signal results', () => {
  it('stickiness: people per number of active days, every day of the range listed', async () => {
    const { result } = await run(
      { kind: 'stickiness', projectId: 'pnp_1', dateRange: { from: '2026-11-10', to: '2026-11-12' }, event: 'A' },
      { 'stickiness.units': [{ n: 1, units: 6 }, { n: 3, units: 2 }] },
    );
    if (result.kind !== 'stickiness') throw new Error('kind');
    expect(result.result.total).toBe(8);
    expect(result.result.intervalsInRange).toBe(3);
    expect(result.result.buckets.map((b) => [b.label, b.count, b.share])).toEqual([
      ['1', 6, 0.75],
      ['2', 0, 0],
      ['3', 2, 0.25],
    ]);
  });

  it('stickiness: times done, in buckets', async () => {
    const { result } = await run({ kind: 'stickiness', projectId: 'pnp_1', event: 'A', measure: 'count' }, { 'stickiness.units': [{ n: 4, units: 3 }, { n: 8, units: 1 }] });
    if (result.kind !== 'stickiness') throw new Error('kind');
    expect(result.result.buckets.map((b) => b.label)).toEqual(['1', '2', '3', '4–5', '6–10', '11–20', '21–50', '51–100', '101+']);
    expect(result.result.buckets[4]?.count).toBe(3);
    expect(result.result.buckets[8]?.count).toBe(1);
  });

  it('lifecycle: new, returning, resurrecting per bucket, dormant in the bucket after', async () => {
    const { result } = await run(
      { kind: 'lifecycle', projectId: 'pnp_1', dateRange: { from: '2026-11-10', to: '2026-11-11' }, event: 'A' },
      {
        'lifecycle.buckets': [
          { bucket: '2026-11-09', status: 'returning', n: 4, dormant_next: 3 },
          { bucket: '2026-11-10', status: 'new', n: 2, dormant_next: 1 },
          { bucket: '2026-11-10', status: 'returning', n: 1, dormant_next: 0 },
          { bucket: '2026-11-11', status: 'resurrecting', n: 5, dormant_next: 5 },
        ],
      },
    );
    if (result.kind !== 'lifecycle') throw new Error('kind');
    expect(result.result.buckets).toEqual([
      { bucket: '2026-11-10', new: 2, returning: 1, resurrecting: 0, dormant: 3 },
      { bucket: '2026-11-11', new: 0, returning: 0, resurrecting: 5, dormant: 1 },
    ]);
    expect(result.result.totals).toEqual({ new: 2, returning: 1, resurrecting: 5, dormant: 4 });
  });

  it('vitals: percentile, shares by Google thresholds, Lighthouse score, element list only where there is one', async () => {
    const { result, sent } = await run(
      { kind: 'vitals', projectId: 'pnp_1', metric: 'lcp' },
      {
        'vitals.summary': [{ value: 2500, samples: 10, good: 6, poor: 1 }],
        'vitals.paths': [{ value: '/users/:id', metric: 4200, samples: 3 }],
      },
    );
    if (result.kind !== 'vitals') throw new Error('kind');
    expect(result.result).toMatchObject({ value: 2500, rating: 'good', samples: 10, score: 90, unit: 'ms' });
    expect(result.result.shares).toEqual({ good: 0.6, needsImprovement: 0.3, poor: 0.1 });
    expect(result.result.paths).toEqual([{ value: '/users/:id', metric: 4200, samples: 3, rating: 'poor' }]);
    expect(sqlOf(sent, 'vitals.summary')).toContain("approx_percentile_cont(json_get_float(e.properties, '$lcp'), 0.75)");
    expect(sent.some((q) => q.name === 'vitals.elements')).toBe(true);
    const ttfb = await run({ kind: 'vitals', projectId: 'pnp_1', metric: 'ttfb' });
    expect(ttfb.sent.some((q) => q.name === 'vitals.elements')).toBe(false);
    expect(vitalsScore('lcp', 4000)).toBe(50);
    expect(vitalsScore('cls', 0.1)).toBe(90);
    expect(vitalsScore('inp', 50)).toBeGreaterThan(98);
  });

  it('impact: adopters against everyone else, before against after, difference in differences', async () => {
    const { result, sent } = await run(
      { kind: 'impact', projectId: 'pnp_1', launchEvent: 'Used AI', launchDate: '2026-11-10', metric: { event: 'Purchase' }, windowDays: 3 },
      {
        'impact.groups': [
          { adopted: 1, users: 10, mb: 10, ma: 30, active_after: 10 },
          { adopted: 0, users: 30, mb: 30, ma: 36, active_after: 20 },
        ],
        'impact.adoption': [{ bucket: '2026-11-10', n: 6 }, { bucket: '2026-11-12', n: 4 }],
      },
    );
    if (result.kind !== 'impact') throw new Error('kind');
    expect(result.result.adopters).toEqual({ users: 10, before: 1, after: 3, change: 2 });
    expect(result.result.nonAdopters).toEqual({ users: 30, before: 1, after: 1.2, change: 0.2 });
    expect(result.result.differenceInDifferences).toBe(1.8);
    expect(result.result.relativeImpact).toBe(1.8);
    expect(result.result.adoption.map((a) => [a.bucket, a.adopters, a.rate])).toEqual([
      ['2026-11-10', 6, 0.2],
      ['2026-11-11', 6, 0.2],
      ['2026-11-12', 10, 1 / 3],
    ]);
    // The launch is written literal-first, so the scope's bounds stay the only `e.ts >=` of the statement.
    expect(sqlOf(sent, 'impact.groups')).toContain("TIMESTAMP '2026-11-10 00:00:00' <= e.ts");
    await expect(
      run({ kind: 'impact', projectId: 'pnp_1', launchEvent: 'A', launchDate: '2026-12-01', metric: { event: 'B' } }),
    ).rejects.toThrow('in the future');
  });

  it('signal: goal rate with and without, lift and phi; candidates picked automatically when none are given', async () => {
    expect(signalCandidate('A', 100, 30, 15, 5)).toEqual({
      event: 'A',
      didUsers: 30,
      didGoalRate: 0.5,
      didNotUsers: 70,
      didNotGoalRate: 0.0714,
      lift: 7,
      correlation: 0.491,
    });
    expect(signalCandidate('B', 10, 5, 0, 0).correlation).toBeNull();

    const { result, sent } = await run(
      { kind: 'signal', projectId: 'pnp_1', goal: { event: 'Purchase' }, topN: 2 },
      {
        'signal.candidates': [{ name: 'Login', n: 9 }, { name: 'bad name\n', n: 3 }],
        'signal.main': [{ users: 100, goal_users: 20, c0_n: 30, c0_g: 15, c0_ng: 5 }],
      },
    );
    if (result.kind !== 'signal') throw new Error('kind');
    expect(result.result.candidates.map((c) => c.event)).toEqual(['Login']);
    expect(result.result.candidates[0]?.lift).toBe(7);
    expect(result.result.goalRate).toBe(0.2);
    expect(sqlOf(sent, 'signal.candidates')).toContain("e.name NOT IN ('Purchase', '$pageleave'");
    // A doer counts as reaching the goal only after their first candidate event.
    expect(sqlOf(sent, 'signal.main')).toContain('lg > f0');
  });
});

describe('web results', () => {
  it('computes goals against visitors and returns the asked panels only', async () => {
    const { result, sent } = await run(
      {
        kind: 'web',
        projectId: 'pnp_1',
        panels: ['channels', 'screenSizes'],
        goals: [{ label: 'Signup', event: '@pnce_signup' }, { label: 'Pricing', pathPattern: '/pricing*' }],
      },
      {
        'web.summary': [{ visitors: 50, visits: 60 }],
        'web.goals': [{ g0_n: 12, g0_u: 10, g1_n: 30, g1_u: 25 }],
        'web.channels': [{ value: 'Organic Search', visitors: 20, events: 40 }],
      },
    );
    if (result.kind !== 'web') throw new Error('kind');
    expect(result.result.goals).toEqual([
      { label: 'Signup', conversions: 12, uniqueConverters: 10, conversionRate: 0.2 },
      { label: 'Pricing', conversions: 30, uniqueConverters: 25, conversionRate: 0.5 },
    ]);
    expect(result.result.channels).toEqual([{ value: 'Organic Search', visitors: 20, events: 40 }]);
    expect(result.result.screenSizes).toEqual([]);
    expect(result.result.hostnames).toBeUndefined();
    expect(sent.map((q) => q.name).sort()).toEqual(['web.channels', 'web.goals', 'web.screenSizes', 'web.series', 'web.summary']);
    expect(sqlOf(sent, 'web.goals')).toContain("e.path LIKE '/pricing%' ESCAPE '!'");
    expect(sqlOf(sent, 'web.channels')).toContain("THEN 'Organic Search'");
  });
});

describe('explain', () => {
  const spec = panelQuerySpecSchema.parse({ kind: 'trends', projectId: 'pnp_1', dateRange: { from: '2026-11-08', to: '2026-11-14' }, series: [{ event: 'A' }] }) as ParsedTrendsSpec;
  const range = resolveRange(spec.dateRange, spec.timezone, ctx);

  it('picks the window: a bucket and the one before, a period, or the range and the period before', () => {
    const bucket = explainWindows(ctx, range, 'day', { bucket: '2026-11-12' });
    expect(bucket.current.from.toISOString()).toBe('2026-11-12T00:00:00.000Z');
    expect(bucket.current.to.toISOString()).toBe('2026-11-13T00:00:00.000Z');
    expect(bucket.baseline.from.toISOString()).toBe('2026-11-11T00:00:00.000Z');
    const whole = explainWindows(ctx, range, 'day', {});
    expect(whole.baseline.to.toISOString()).toBe(whole.current.from.toISOString());
    expect(() => explainWindows(ctx, range, 'day', { bucket: '2026-12-01' })).toThrow('not started');
  });

  it('reads both windows in one scan per dimension, scoped, with the literal first in window bounds', () => {
    const windows = explainWindows(ctx, range, 'day', { bucket: '2026-11-12' });
    const dims = explainDimensions(ctx, [{ source: 'person', key: 'plan', limit: 10 }], undefined);
    const queries = explainQueries(spec, ctx, range, windows, dims, [{ source: 'person', key: 'plan', limit: 10 }]);
    expect(queries).toHaveLength(1 + 8);
    for (const q of queries) {
      expect(q.sql).toContain("e.workspace_id = 'ws_1' AND e.project_id = 'pnp_1'");
      expect(q.sql.match(/\be\.ts >= TIMESTAMP/g)).toHaveLength(1);
      expect(q.sql).toContain("TIMESTAMP '2026-11-12 00:00:00' <= e.ts");
    }
    expect(queries[7]?.sql).toContain('regexp_replace(e.path');
    expect(queries[8]?.sql).toContain('panel.people_v1');
  });

  it('ranks dimensions by how much more of the change their top value carries than its traffic share', () => {
    const out = explainFrom(
      [
        { name: 'country', expr: '' },
        { name: 'browser', expr: '' },
      ],
      { cur: 150, base: 100 },
      [
        [
          { value: 'NL', cur: 75, base: 50 },
          { value: 'BE', cur: 75, base: 50 },
        ],
        [
          { value: 'Safari', cur: 55, base: 10 },
          { value: 'Chrome', cur: 95, base: 90 },
        ],
      ],
      5,
    );
    expect(out.metric).toEqual({ current: 150, baseline: 100, change: 50, changePercent: 0.5 });
    expect(out.dimensions.map((d) => d.dimension)).toEqual(['browser', 'country']);
    expect(out.dimensions[0]?.values[0]).toEqual({ value: 'Safari', current: 55, baseline: 10, change: 45, changePercent: 4.5, contributionShare: 0.9 });
    expect(out.dimensions[0]?.explained).toBe(0.8);
    expect(out.dimensions[1]?.explained).toBe(0);
  });
});
