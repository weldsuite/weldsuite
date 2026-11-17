import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import {
  aggregateGroupType,
  flowsSpecSchema,
  frustrationRecordingsSearch,
  funnelCorrelationSpecSchema,
  funnelDropOffRecordingsSearch,
  funnelSpecSchema,
  funnelStepRecordingsSearch,
  groupKeyProperty,
  heatmapSpecSchema,
  impactSpecSchema,
  isComputedPropertyRef,
  isCustomEventRef,
  lifecycleSpecSchema,
  panelBreakdownBucketSchema,
  panelBreakdownSchema,
  panelCohortConditionSchema,
  panelCohortFilterSchema,
  panelDateRangeSchema,
  panelEventNameSchema,
  panelEventPropertyRefSchema,
  panelEventRefSchema,
  panelFilterSchema,
  panelFunnelExclusionSchema,
  panelGroupTypeSchema,
  panelPropertyKeySchema,
  panelQuerySpecSchema,
  panelReportSpecSchema,
  panelTrendFormulaSchema,
  panelTrendSeriesSchema,
  panelWebGoalSchema,
  personRecordingsSearch,
  recordingsSearchSchema,
  recordingsSearchToSpec,
  refId,
  retentionSpecSchema,
  sessionsSpecSchema,
  sessionsSpecToRecordingsSearch,
  signalSpecSchema,
  specBreakdowns,
  stickinessSpecSchema,
  trendsSpecSchema,
  vitalsSpecSchema,
  webSpecSchema,
  type PanelBreakdown,
  type PanelFunnelSpec,
} from './weldpanel-query';

/** The issues a parse reports, as `path: message`. Empty when it parses. */
function issuesOf(schema: ZodTypeAny, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

const projectId = 'pnp_1';

describe('event names and property keys', () => {
  it('takes tracked names and $ system events where a spec takes an event name', () => {
    expect(panelEventNameSchema.safeParse('Signed up').success).toBe(true);
    expect(panelEventNameSchema.safeParse('$pageview').success).toBe(true);
    expect(issuesOf(panelEventNameSchema, '@pnce_abc')).toEqual([': Not a valid event name']);
    expect(issuesOf(panelEventNameSchema, ' leading space')).toEqual([': Not a valid event name']);
  });

  it('also takes a custom event ref where a spec takes an event', () => {
    expect(panelEventRefSchema.safeParse('@pnce_abc123').success).toBe(true);
    expect(panelEventRefSchema.safeParse('$webvitals').success).toBe(true);
    expect(issuesOf(panelEventRefSchema, '$X')).toEqual([': Not a valid event name']);
  });

  it('takes plain and $-prefixed property keys, and computed property refs only for event properties', () => {
    expect(panelPropertyKeySchema.safeParse('plan').success).toBe(true);
    expect(panelPropertyKeySchema.safeParse('$email').success).toBe(true);
    expect(issuesOf(panelPropertyKeySchema, '1plan')).toEqual([': Not a valid property key']);
    expect(issuesOf(panelPropertyKeySchema, '@pncp_abc')).toEqual([': Not a valid property key']);

    expect(panelEventPropertyRefSchema.safeParse('@pncp_abc').success).toBe(true);
    expect(panelEventPropertyRefSchema.safeParse('$current_url').success).toBe(true);
    expect(issuesOf(panelEventPropertyRefSchema, 'bad-key')).toEqual([': Not a valid property key']);
  });

  it('tells custom event refs from computed property refs and strips the @ for the row id', () => {
    expect(isCustomEventRef('@pnce_abc')).toBe(true);
    expect(isCustomEventRef('@pncp_abc')).toBe(false);
    expect(isComputedPropertyRef('@pncp_abc')).toBe(true);
    expect(isComputedPropertyRef('pncp_abc')).toBe(false);
    expect(refId('@pnce_abc')).toBe('pnce_abc');
    expect(refId('pnce_abc')).toBe('pnce_abc');
  });

  it('names the group key property and takes lower-case group types', () => {
    expect(groupKeyProperty('company')).toBe('$group_company');
    expect(panelGroupTypeSchema.safeParse('company_2').success).toBe(true);
    expect(issuesOf(panelGroupTypeSchema, 'Company')).toEqual([': Use lower-case letters, digits and _']);
  });
});

describe('date ranges', () => {
  it('takes a preset or custom days in order', () => {
    expect(panelDateRangeSchema.parse({ preset: '7d' })).toEqual({ preset: '7d' });
    expect(panelDateRangeSchema.parse({ from: '2026-11-01', to: '2026-11-01' })).toEqual({ from: '2026-11-01', to: '2026-11-01' });
  });

  it('refuses a range that ends before it starts, or days in another format', () => {
    expect(issuesOf(panelDateRangeSchema, { from: '2026-11-02', to: '2026-11-01' })).toEqual([': `from` must not be after `to`']);
    expect(panelDateRangeSchema.safeParse({ from: '01-11-2026', to: '2026-11-02' }).success).toBe(false);
    expect(panelDateRangeSchema.safeParse({ preset: '1y' }).success).toBe(false);
  });
});

describe('filters', () => {
  it('needs a value for every operator but is_set and is_not_set', () => {
    expect(panelFilterSchema.safeParse({ source: 'column', field: 'country', operator: 'eq', value: 'NL' }).success).toBe(true);
    expect(panelFilterSchema.safeParse({ source: 'column', field: 'country', operator: 'is_set' }).success).toBe(true);
    expect(issuesOf(panelFilterSchema, { source: 'event', key: 'plan', operator: 'eq' })).toEqual(['value: A value is required']);
  });

  it('takes a list for in, and only for in', () => {
    expect(panelFilterSchema.safeParse({ source: 'person', key: '$email', operator: 'in', value: ['a@x.com', 'b@x.com'] }).success).toBe(true);
    expect(issuesOf(panelFilterSchema, { source: 'person', key: '$email', operator: 'in', value: 'a@x.com' })).toEqual([
      'value: Use a list of values',
    ]);
    expect(issuesOf(panelFilterSchema, { source: 'column', field: 'path', operator: 'eq', value: ['/a'] })).toEqual([
      'value: Only `in` takes a list',
    ]);
  });

  it('compares gt and lt with numbers or text, not true or false', () => {
    expect(panelFilterSchema.safeParse({ source: 'event', key: 'price', operator: 'gt', value: 10 }).success).toBe(true);
    expect(issuesOf(panelFilterSchema, { source: 'event', key: 'price', operator: 'lt', value: true })).toEqual(['value: Use a number or text']);
  });

  it('reads cohort, group and group key filters, checking no operator on a cohort', () => {
    expect(panelFilterSchema.parse({ source: 'cohort', cohortId: 'pnco_1', negate: true })).toEqual({
      source: 'cohort',
      cohortId: 'pnco_1',
      negate: true,
    });
    expect(panelFilterSchema.safeParse({ source: 'group', groupType: 'company', key: 'plan', operator: 'eq', value: 'pro' }).success).toBe(true);
    expect(panelFilterSchema.safeParse({ source: 'group_key', groupType: 'company', operator: 'is_not_set' }).success).toBe(true);
    expect(issuesOf(panelFilterSchema, { source: 'group_key', groupType: 'company', operator: 'eq' })).toEqual(['value: A value is required']);
  });
});

describe('breakdowns', () => {
  it('buckets numbers automatically or at edges listed from low to high', () => {
    expect(panelBreakdownBucketSchema.parse({ kind: 'auto' })).toEqual({ kind: 'auto' });
    expect(panelBreakdownBucketSchema.parse({ kind: 'custom', edges: [10, 50, 100] })).toEqual({ kind: 'custom', edges: [10, 50, 100] });
    expect(issuesOf(panelBreakdownBucketSchema, { kind: 'custom', edges: [10, 10] })).toEqual(['edges: List the edges from low to high']);
    expect(issuesOf(panelBreakdownBucketSchema, { kind: 'custom', edges: [50, 10] })).toEqual(['edges: List the edges from low to high']);
  });

  it('shows the top 10 values unless told otherwise', () => {
    expect(panelBreakdownSchema.parse({ source: 'column', field: 'browser' })).toEqual({ source: 'column', field: 'browser', limit: 10 });
    expect(panelBreakdownSchema.parse({ source: 'group', groupType: 'company', key: 'plan', limit: 3 })).toMatchObject({ limit: 3 });
  });

  it('reads `breakdowns` first, then `breakdown`, else none', () => {
    const country: PanelBreakdown = { source: 'column', field: 'country', limit: 10 };
    const plan: PanelBreakdown = { source: 'person', key: 'plan', limit: 5 };
    expect(specBreakdowns({ breakdowns: [country, plan], breakdown: country })).toEqual([country, plan]);
    expect(specBreakdowns({ breakdowns: [], breakdown: plan })).toEqual([plan]);
    expect(specBreakdowns({ breakdown: plan })).toEqual([plan]);
    expect(specBreakdowns({})).toEqual([]);
  });

  it('names the group type a measure counts, or null for people', () => {
    expect(aggregateGroupType(undefined)).toBeNull();
    expect(aggregateGroupType('person')).toBeNull();
    expect(aggregateGroupType({ groupType: 'company' })).toBe('company');
  });
});

const TRENDS = { kind: 'trends', projectId, series: [{ event: '$pageview' }] };
const FUNNEL = { kind: 'funnel', projectId, steps: [{ event: 'Viewed' }, { event: 'Added' }, { event: 'Bought' }] };

describe('trends specs', () => {
  it('fills in the defaults', () => {
    expect(trendsSpecSchema.parse(TRENDS)).toEqual({
      kind: 'trends',
      projectId,
      dateRange: { preset: '30d' },
      timezone: 'UTC',
      filters: [],
      series: [{ event: '$pageview', math: 'total', filters: [] }],
      interval: 'day',
      compare: false,
    });
  });

  it('needs a property for sum, avg, min and max, and a group type for unique_groups', () => {
    expect(issuesOf(panelTrendSeriesSchema, { event: 'Purchase', math: 'sum' })).toEqual(['property: Choose the property to calculate']);
    expect(panelTrendSeriesSchema.safeParse({ event: 'Purchase', math: 'max', property: 'price' }).success).toBe(true);
    expect(issuesOf(panelTrendSeriesSchema, { event: 'Login', math: 'unique_groups' })).toEqual(['groupType: Choose the group type to count']);
    expect(panelTrendSeriesSchema.safeParse({ event: 'Login', math: 'unique_groups', groupType: 'company' }).success).toBe(true);
  });

  it('refuses `breakdown` together with `breakdowns`', () => {
    const column = { source: 'column', field: 'country' };
    expect(issuesOf(trendsSpecSchema, { ...TRENDS, breakdown: column, breakdowns: [column] })).toEqual([
      'breakdowns: Use `breakdowns` or `breakdown`, not both',
    ]);
    expect(trendsSpecSchema.safeParse({ ...TRENDS, breakdowns: [column] }).success).toBe(true);
  });

  it('needs a formula before it shows the formulas only', () => {
    expect(issuesOf(trendsSpecSchema, { ...TRENDS, formulaOnly: true })).toEqual(['formulaOnly: Add a formula first']);
    expect(issuesOf(trendsSpecSchema, { ...TRENDS, formulaOnly: true, formulas: [] })).toEqual(['formulaOnly: Add a formula first']);
    const twoSeries = { ...TRENDS, series: [{ event: 'Signed up' }, { event: '$pageview' }] };
    expect(trendsSpecSchema.safeParse({ ...twoSeries, formulaOnly: true, formulas: [{ expression: 'A / B * 100' }] }).success).toBe(true);
  });

  it('takes formulas of series letters, numbers and operators only', () => {
    expect(panelTrendFormulaSchema.safeParse({ expression: '(A − B) ÷ 2', label: 'Gap' }).success).toBe(true);
    expect(issuesOf(panelTrendFormulaSchema, { expression: 'A; drop' })).toEqual([
      'expression: Use the letters A to E, numbers, + - * / and parentheses',
    ]);
  });
});

describe('web specs', () => {
  it('fills in the defaults', () => {
    expect(webSpecSchema.parse({ kind: 'web', projectId })).toMatchObject({ compare: false, limit: 10, dateRange: { preset: '30d' } });
  });

  it('takes a goal on an event or on a page, not both and not neither', () => {
    expect(panelWebGoalSchema.safeParse({ label: 'Signed up', event: 'Signed up' }).success).toBe(true);
    expect(panelWebGoalSchema.parse({ label: 'Pricing', pathPattern: '/pricing*' })).toEqual({ label: 'Pricing', pathPattern: '/pricing*', filters: [] });
    expect(issuesOf(panelWebGoalSchema, { label: 'Both', event: 'Signed up', pathPattern: '/pricing' })).toEqual([
      'event: Choose an event or a page',
    ]);
    expect(issuesOf(panelWebGoalSchema, { label: 'Neither' })).toEqual(['event: Choose an event or a page']);
    expect(issuesOf(panelWebGoalSchema, { label: 'Relative', pathPattern: 'pricing' })).toEqual(['pathPattern: Start with /']);
  });
});

describe('funnel specs', () => {
  it('fills in the defaults', () => {
    expect(funnelSpecSchema.parse(FUNNEL)).toMatchObject({ window: { value: 7, unit: 'day' }, order: 'loose' });
  });

  it('lets only a middle step be optional', () => {
    const steps = [{ event: 'Viewed', optional: true }, { event: 'Added', optional: true }, { event: 'Bought', optional: true }];
    expect(issuesOf(funnelSpecSchema, { ...FUNNEL, steps })).toEqual([
      'steps.0.optional: The first and the last step cannot be optional',
      'steps.2.optional: The first and the last step cannot be optional',
    ]);
  });

  it('refuses an exclusion past the last step, and exclusions in any order', () => {
    expect(issuesOf(funnelSpecSchema, { ...FUNNEL, exclusions: [{ event: 'Refund', fromStep: 0, toStep: 5 }] })).toEqual([
      'exclusions.0.toStep: The funnel has no such step',
    ]);
    expect(issuesOf(funnelSpecSchema, { ...FUNNEL, order: 'any', exclusions: [{ event: 'Refund', fromStep: 0, toStep: 2 }] })).toEqual([
      'exclusions: Exclusions need the steps in order',
    ]);
    expect(funnelSpecSchema.safeParse({ ...FUNNEL, exclusions: [{ event: 'Refund', fromStep: 0, toStep: 2 }] }).success).toBe(true);
  });

  it('needs an exclusion to end after it starts', () => {
    expect(issuesOf(panelFunnelExclusionSchema, { event: 'Refund', fromStep: 2, toStep: 2 })).toEqual([
      'toStep: The end step must come after the start step',
    ]);
  });

  it('gives funnel correlation the funnel checks and a default limit', () => {
    expect(funnelCorrelationSpecSchema.parse({ ...FUNNEL, kind: 'funnel_correlation' })).toMatchObject({ limit: 10 });
    const column = { source: 'column', field: 'os' };
    expect(issuesOf(funnelCorrelationSpecSchema, { ...FUNNEL, kind: 'funnel_correlation', breakdown: column, breakdowns: [column] })).toEqual([
      'breakdowns: Use `breakdowns` or `breakdown`, not both',
    ]);
  });
});

describe('other report kinds', () => {
  it('fills in the defaults of retention, flows, stickiness, lifecycle, vitals, signal and sessions', () => {
    expect(retentionSpecSchema.parse({ kind: 'retention', projectId, firstEvent: 'Signed up' })).toMatchObject({ interval: 'week', periods: 8 });
    expect(flowsSpecSchema.parse({ kind: 'flows', projectId, anchor: { event: '$pageview' } })).toMatchObject({
      direction: 'after',
      depth: 3,
      scope: 'all',
      limit: 20,
    });
    expect(stickinessSpecSchema.parse({ kind: 'stickiness', projectId, event: 'Login' })).toMatchObject({ interval: 'day', measure: 'intervals' });
    expect(lifecycleSpecSchema.parse({ kind: 'lifecycle', projectId, event: 'Login' })).toMatchObject({ interval: 'day' });
    expect(vitalsSpecSchema.parse({ kind: 'vitals', projectId })).toMatchObject({ metric: 'lcp', percentile: 'p75', interval: 'day', limit: 10 });
    expect(signalSpecSchema.parse({ kind: 'signal', projectId, goal: { event: 'Upgraded' } })).toMatchObject({ topN: 10, windowDays: 7 });
    expect(sessionsSpecSchema.parse({ kind: 'sessions', projectId })).toMatchObject({ sort: 'started_desc', limit: 25 });
  });

  it('needs a property for an impact on a sum or average', () => {
    const impact = { kind: 'impact', projectId, launchEvent: 'Used export', launchDate: '2026-10-01' };
    expect(issuesOf(impactSpecSchema, { ...impact, metric: { event: 'Purchase', math: 'avg' } })).toEqual([
      'metric.property: Choose the property to calculate',
    ]);
    expect(impactSpecSchema.parse({ ...impact, metric: { event: 'Purchase', math: 'sum', property: 'price' } })).toMatchObject({ windowDays: 28 });
    expect(impactSpecSchema.parse({ ...impact, metric: { event: 'Purchase' } }).metric.math).toBe('total');
  });

  it('needs a page group or a URL pattern for a heatmap', () => {
    const heatmap = { kind: 'heatmap', projectId, type: 'click', deviceClass: 'desktop' };
    expect(issuesOf(heatmapSpecSchema, heatmap)).toEqual(['pageGroupId: Choose a page group or a URL pattern']);
    expect(heatmapSpecSchema.safeParse({ ...heatmap, urlPattern: '/products/*' }).success).toBe(true);
    expect(heatmapSpecSchema.safeParse({ ...heatmap, pageGroupId: 'pnhp_1' }).success).toBe(true);
  });

  const SPECS = [
    { kind: 'web', projectId },
    TRENDS,
    FUNNEL,
    { kind: 'retention', projectId, firstEvent: 'Signed up', returnEvent: '@pnce_abc' },
    { kind: 'flows', projectId, anchor: { event: '$pageview' }, direction: 'before' },
    { kind: 'sessions', projectId, countries: ['NL'], hasRecording: true },
    { kind: 'heatmap', projectId, type: 'scroll', deviceClass: 'mobile', urlPattern: '/' },
    { ...FUNNEL, kind: 'funnel_correlation' },
    { kind: 'stickiness', projectId, event: 'Login', aggregateBy: { groupType: 'company' } },
    { kind: 'lifecycle', projectId, event: 'Login', aggregateBy: 'person' },
    { kind: 'vitals', projectId, metric: 'cls', percentile: 'p95' },
    { kind: 'impact', projectId, launchEvent: 'Used export', launchDate: '2026-10-01', metric: { event: 'Purchase' } },
    { kind: 'signal', projectId, goal: { event: 'Upgraded' }, candidates: ['Invited', '$pageview'] },
  ];

  it.each(SPECS.map((spec) => [spec.kind, spec] as const))('runs a %s spec through the query union', (kind, spec) => {
    expect(panelQuerySpecSchema.parse(spec).kind).toBe(kind);
  });

  it('saves every kind but sessions, heatmaps and funnel correlation as a report', () => {
    const saveable = SPECS.filter((spec) => panelReportSpecSchema.safeParse(spec).success).map((spec) => spec.kind);
    expect(saveable).toEqual(['web', 'trends', 'funnel', 'retention', 'flows', 'stickiness', 'lifecycle', 'vitals', 'impact', 'signal']);
  });
});

describe('cohort filters', () => {
  it('reads person property and performed conditions with their defaults', () => {
    expect(panelCohortFilterSchema.parse({ conditions: [{ type: 'person_property', key: 'plan', operator: 'eq', value: 'pro' }] })).toEqual({
      match: 'all',
      conditions: [{ type: 'person_property', key: 'plan', operator: 'eq', value: 'pro' }],
    });
    expect(panelCohortConditionSchema.parse({ type: 'performed', event: 'Signed up', withinDays: 30 })).toEqual({
      type: 'performed',
      event: 'Signed up',
      filters: [],
      withinDays: 30,
      minCount: 1,
      negate: false,
    });
  });

  it('refuses a cohort inside a cohort', () => {
    const nested = { type: 'performed', event: 'Signed up', withinDays: 30, filters: [{ source: 'cohort', cohortId: 'pnco_1' }] };
    expect(issuesOf(panelCohortConditionSchema, nested)).toEqual(['filters: Cohorts cannot nest']);
  });
});

describe('recordings links', () => {
  it('reads recordings search params', () => {
    expect(recordingsSearchSchema.parse({ range: '7d', devices: ['mobile'], errors: true })).toEqual({ range: '7d', devices: ['mobile'], errors: true });
    expect(recordingsSearchSchema.safeParse({ range: 'forever' }).success).toBe(false);
  });

  it('turns a search into a sessions spec: custom days, a preset, or the last 30 days', () => {
    expect(recordingsSearchToSpec({ from: '2026-11-01', to: '2026-11-07', did: ['Signed up'], didNot: ['Upgraded'], user: 'u_1' }, projectId)).toMatchObject({
      kind: 'sessions',
      projectId,
      dateRange: { from: '2026-11-01', to: '2026-11-07' },
      didEvents: ['Signed up'],
      notDidEvents: ['Upgraded'],
      distinctId: 'u_1',
    });
    expect(recordingsSearchToSpec({ range: '7d', from: '2026-11-01' }, projectId).dateRange).toEqual({ preset: '7d' });
    expect(recordingsSearchToSpec({}, projectId).dateRange).toEqual({ preset: '30d' });
  });

  it('turns a sessions spec back into a search, leaving out what is not set', () => {
    expect(sessionsSpecToRecordingsSearch({ kind: 'sessions', projectId, dateRange: { preset: '90d' }, hasErrors: true }, projectId)).toStrictEqual({
      project: projectId,
      range: '90d',
      errors: true,
    });
    expect(sessionsSpecToRecordingsSearch({ kind: 'sessions', projectId, dateRange: { from: '2026-11-01', to: '2026-11-02' } })).toStrictEqual({
      from: '2026-11-01',
      to: '2026-11-02',
    });
    expect(sessionsSpecToRecordingsSearch({ kind: 'sessions', projectId })).toStrictEqual({ range: '30d' });
  });

  it('round-trips a search through a spec', () => {
    const search = {
      project: projectId,
      range: '7d' as const,
      minDuration: 10,
      maxDuration: 600,
      pages: ['/pricing'],
      entryPage: '/',
      exitPage: '/checkout',
      countries: ['NL'],
      devices: ['desktop' as const],
      browsers: ['Firefox'],
      user: 'u_1',
      cohort: 'pnco_1',
      did: ['Signed up'],
      didNot: ['Upgraded'],
      frustration: ['rage' as const],
      errors: true,
      favorites: true,
      sort: 'duration_desc' as const,
    };
    expect(sessionsSpecToRecordingsSearch(recordingsSearchToSpec(search, projectId), projectId)).toStrictEqual(search);
  });

  const funnel: PanelFunnelSpec = { kind: 'funnel', projectId, dateRange: { preset: '7d' }, steps: [{ event: 'Viewed' }, { event: 'Added' }, { event: 'Bought' }] };

  it('links a funnel drop-off to the sessions that did the previous step but not this one', () => {
    expect(funnelDropOffRecordingsSearch(funnel, 2, projectId)).toStrictEqual({ project: projectId, range: '7d', did: ['Added'], didNot: ['Bought'] });
    expect(funnelDropOffRecordingsSearch({ ...funnel, dateRange: { from: '2026-11-01', to: '2026-11-07' } }, 1)).toStrictEqual({
      from: '2026-11-01',
      to: '2026-11-07',
      did: ['Viewed'],
      didNot: ['Added'],
    });
    expect(funnelDropOffRecordingsSearch({ ...funnel, dateRange: undefined }, 1)).toStrictEqual({ did: ['Viewed'], didNot: ['Added'] });
  });

  it('refuses a drop-off or step the funnel does not have', () => {
    expect(() => funnelDropOffRecordingsSearch(funnel, 0)).toThrow(new RangeError('The funnel has no step 1'));
    expect(() => funnelDropOffRecordingsSearch(funnel, 3)).toThrow(RangeError);
    expect(() => funnelStepRecordingsSearch(funnel, 3)).toThrow(new RangeError('The funnel has no step 4'));
  });

  it('links a funnel step to the sessions that completed it', () => {
    expect(funnelStepRecordingsSearch(funnel, 0, projectId)).toStrictEqual({ project: projectId, range: '7d', did: ['Viewed'] });
  });

  it('links frustration signals and errors to their recordings, worst first', () => {
    expect(frustrationRecordingsSearch('errors')).toStrictEqual({ errors: true, sort: 'errors_desc' });
    expect(
      frustrationRecordingsSearch('rage', { range: { preset: '7d' }, entryPage: '/pricing', pages: ['/pricing'], project: projectId }),
    ).toStrictEqual({ project: projectId, range: '7d', pages: ['/pricing'], entryPage: '/pricing', frustration: ['rage'], sort: 'frustration_desc' });
  });

  it("links a person's recordings over the last 90 days", () => {
    expect(personRecordingsSearch('u_1', projectId)).toStrictEqual({ project: projectId, user: 'u_1', range: '90d' });
    expect(personRecordingsSearch('u_1')).toStrictEqual({ user: 'u_1', range: '90d' });
  });
});
