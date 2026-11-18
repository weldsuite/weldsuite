/**
 * What the SQL corpus holds: one case per input, chosen so that every branch
 * that changes the shape of the SQL is taken at least once (every spec kind,
 * math, interval, order, display, filter source and operator, breakdown kind,
 * bucket, timezone offset, context variant and escaping rule), plus the
 * isolation specs of compile.test.ts under three contexts.
 *
 * Ids are `<group>/<kind>/<variant>[@context]`; `panel-api/<file>/<variant>`
 * for the statements panel-api writes itself (./panel-api).
 */

import {
  PANEL_DATE_PRESETS,
  PANEL_DEVICE_CLASSES,
  PANEL_HEATMAP_TYPES,
  PANEL_SESSION_SORTS,
  PANEL_TREND_MATHS,
  PANEL_VITALS_METRICS,
  PANEL_WEB_PANELS,
  type PanelCohortFilter,
  type PanelFilter,
  type PanelFlowsSpec,
  type PanelFunnelCorrelationSpec,
  type PanelFunnelSpec,
  type PanelHeatmapSpec,
  type PanelImpactSpec,
  type PanelLifecycleSpec,
  type PanelQuerySpec,
  type PanelRetentionSpec,
  type PanelSessionsSpec,
  type PanelSignalSpec,
  type PanelStickinessSpec,
  type PanelTrendsSpec,
  type PanelVitalsSpec,
  type PanelWebSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { ExplainPanelChangeInput } from '@weldsuite/app-api-client/schemas/weldpanel-analysis';
import { PANEL_EXPORT_TABLE_NAMES } from '../export';
import type { PanelSqlQuery } from '../rows';
import { corpusContextSchema, toContext, type CorpusContextDraft, type CorpusInputDraft } from './corpus';
import {
  chunkManifestQuery,
  cohortPeopleQuery,
  erasureChunksQuery,
  erasureSessionsQuery,
  groupActivityQueries,
  projectUsageQueries,
  snapshotChunksQuery,
  snapshotVisitsQuery,
} from './panel-api';

export interface CompilerCase {
  id: string;
  input: CorpusInputDraft;
}

export interface PanelApiCase {
  id: string;
  statements: PanelSqlQuery[];
}

type Responses = Record<string, Record<string, unknown>[]>;
type BreakdownInput = NonNullable<PanelTrendsSpec['breakdown']>;

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

const P = 'pnp_1';
/** The frozen clock of every case. */
export const CORPUS_NOW = '2026-11-14T12:00:00.000Z';

const BASE: CorpusContextDraft = { workspaceId: 'ws_1', projectId: P, retentionDays: 365, hasIdentifiedUsers: true, erasedIds: [], now: CORPUS_NOW };
const ANONYMOUS: CorpusContextDraft = { ...BASE, hasIdentifiedUsers: false };
const ERASED: CorpusContextDraft = { ...BASE, erasedIds: ['user_gone', "anon'_gone", 'CORP\\jdoe'] };

/** compile.test.ts's cohort. */
const COHORT_ALL: PanelCohortFilter = {
  match: 'all',
  conditions: [
    { type: 'person_property', key: 'plan', operator: 'eq', value: 'pro' },
    { type: 'performed', event: 'Signed up', filters: [], withinDays: 30, minCount: 1, negate: false },
    { type: 'performed', event: 'Upgraded', filters: [], withinDays: 30, minCount: 1, negate: true },
  ],
};

/** Every condition kind and operator family, matched by any. */
const COHORT_ANY: PanelCohortFilter = {
  match: 'any',
  conditions: [
    { type: 'person_property', key: '$email', operator: 'contains', value: '@example.com' },
    { type: 'person_property', key: 'seats', operator: 'gt', value: 10 },
    { type: 'person_property', key: 'plan', operator: 'in', value: ['pro', 'team'] },
    { type: 'person_property', key: 'churned', operator: 'is_not_set' },
    { type: 'person_property', key: 'trial', operator: 'eq', value: true },
    {
      type: 'performed',
      event: 'Purchase',
      filters: [
        { source: 'event', key: 'amount', operator: 'gt', value: 100 },
        { source: 'column', field: 'country', operator: 'eq', value: 'NL' },
        { source: 'group', groupType: 'company', key: 'plan', operator: 'eq', value: 'enterprise' },
      ],
      withinDays: 762,
      minCount: 3,
    },
    { type: 'performed', event: '$pageview', filters: [{ source: 'person', key: 'plan', operator: 'eq', value: 'free' }], withinDays: 7, negate: true },
  ],
};

/** Everything a spec may refer to. The first custom event and computed properties are compile.test.ts's. */
const FULL: CorpusContextDraft = {
  ...BASE,
  cohorts: { pnc_1: COHORT_ALL, pnc_any: COHORT_ANY },
  customEvents: {
    pnce_signup: {
      match: [
        { event: 'Signed up', filters: [{ source: 'event', key: '@pncp_revenue', operator: 'gt', value: 0 }] },
        { event: '$pageview', filters: [{ source: 'column', field: 'path', operator: 'eq', value: "/welcome'" }] },
      ],
    },
    pnce_checkout: {
      match: [
        { event: 'Checkout', filters: [] },
        {
          event: 'Purchase',
          filters: [
            { source: 'group', groupType: 'company', key: 'plan', operator: 'is_set' },
            { source: 'person', key: 'plan', operator: 'eq', value: 'pro' },
          ],
        },
      ],
    },
  },
  computedProperties: {
    pncp_revenue: { kind: 'formula', expression: 'price * quantity' },
    pncp_label: { kind: 'coalesce', keys: [{ source: 'event', key: 'label' }, { source: 'column', field: 'title' }] },
    pncp_margin: { kind: 'formula', expression: '(price - cost) / price * -100 + 0.5' },
    pncp_tiny: { kind: 'formula', expression: 'price * 0.0000001' },
    pncp_amount: { kind: 'coalesce', keys: [{ source: 'event', key: 'price' }, { source: 'event', key: 'amount' }, { source: 'event', key: '$value' }] },
  },
  pathRules: [
    { pattern: '^/users/\\d+', replacement: '/users/:id' },
    { pattern: "/o'rders/[0-9]+", replacement: '/orders/:id' },
    { pattern: '^/blog/([a-z-]+)/\\d+$', replacement: '/blog/$1/:n' },
  ],
  groupTypes: ['company', 'team'],
  pageGroups: { pnh_1: '/products/*' },
  favoriteSessionIds: ['s_1', "s'2"],
};
const FULL_ANONYMOUS: CorpusContextDraft = { ...FULL, hasIdentifiedUsers: false };
const FULL_ERASED: CorpusContextDraft = { ...FULL, erasedIds: ERASED.erasedIds };

// ---------------------------------------------------------------------------
// Fake Basin answers for the statements a runner reads before writing the next
// ---------------------------------------------------------------------------

const BREAKDOWN_VALUES = [
  { value: 'pro', v0: 'pro', n: 9 },
  { value: "it's", v0: "it's", n: 4 },
];
const BREAKDOWN_RANGE = [{ min0: 3, max0: 97, min1: 0, max1: 1000, min2: -5, max2: 5 }];

const DEFAULT_RESPONSES: Responses = {
  'trends.breakdownRange': BREAKDOWN_RANGE,
  'trends.breakdownValues': BREAKDOWN_VALUES,
  'funnel.breakdownRange': BREAKDOWN_RANGE,
  'funnel.breakdownValues': BREAKDOWN_VALUES,
  'retention.breakdownRange': BREAKDOWN_RANGE,
  'retention.breakdownValues': BREAKDOWN_VALUES,
  'signal.candidates': [
    { name: 'Login', n: 9 },
    { name: 'Purchase', n: 3 },
  ],
  'sessions.list': [{ session_id: 's_1' }, { session_id: "s'2" }],
};

const withResponses = (overrides: Responses): Responses => ({ ...DEFAULT_RESPONSES, ...overrides });

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** compile.test.ts's filters: a column list, an event property, a person property and a cohort. */
const FILTERS: PanelFilter[] = [
  { source: 'column', field: 'country', operator: 'in', value: ['NL', 'BE'] },
  { source: 'event', key: 'plan', operator: 'eq', value: 'pro' },
  { source: 'person', key: '$email', operator: 'contains', value: '@example.com' },
  { source: 'cohort', cohortId: 'pnc_1' },
];

const WEEK = { from: '2026-11-08', to: '2026-11-14' };
const NOVEMBER = { from: '2026-11-01', to: '2026-11-14' };
const COUNTRY: BreakdownInput = { source: 'column', field: 'country' };

const cases: CompilerCase[] = [];
const panelApiCases: PanelApiCase[] = [];

function query(id: string, spec: PanelQuerySpec, context: CorpusContextDraft, responses: Responses): void {
  cases.push({ id: `query/${spec.kind}/${id}`, input: { call: 'runPanelQuery', context, spec, responses } });
}

type Fields<T> = Omit<T, 'kind' | 'projectId'>;

function trends(id: string, fields: Fields<PanelTrendsSpec>, context = BASE, responses = DEFAULT_RESPONSES): void {
  query(id, { kind: 'trends', projectId: P, ...fields }, context, responses);
}
function funnel(id: string, fields: Fields<PanelFunnelSpec>, context = BASE, responses = DEFAULT_RESPONSES): void {
  query(id, { kind: 'funnel', projectId: P, ...fields }, context, responses);
}
function correlation(id: string, fields: Fields<PanelFunnelCorrelationSpec>, context = BASE): void {
  query(id, { kind: 'funnel_correlation', projectId: P, ...fields }, context, DEFAULT_RESPONSES);
}
function retention(id: string, fields: Fields<PanelRetentionSpec>, context = BASE, responses = DEFAULT_RESPONSES): void {
  query(id, { kind: 'retention', projectId: P, ...fields }, context, responses);
}
function flows(id: string, fields: Fields<PanelFlowsSpec>, context = BASE): void {
  query(id, { kind: 'flows', projectId: P, ...fields }, context, DEFAULT_RESPONSES);
}
function stickiness(id: string, fields: Fields<PanelStickinessSpec>, context = BASE): void {
  query(id, { kind: 'stickiness', projectId: P, ...fields }, context, DEFAULT_RESPONSES);
}
function lifecycle(id: string, fields: Fields<PanelLifecycleSpec>, context = BASE): void {
  query(id, { kind: 'lifecycle', projectId: P, ...fields }, context, DEFAULT_RESPONSES);
}
function vitals(id: string, fields: Fields<PanelVitalsSpec>, context = BASE): void {
  query(id, { kind: 'vitals', projectId: P, ...fields }, context, DEFAULT_RESPONSES);
}
function impact(id: string, fields: Fields<PanelImpactSpec>, context = BASE): void {
  query(id, { kind: 'impact', projectId: P, ...fields }, context, DEFAULT_RESPONSES);
}
function signal(id: string, fields: Fields<PanelSignalSpec>, context = BASE, responses = DEFAULT_RESPONSES): void {
  query(id, { kind: 'signal', projectId: P, ...fields }, context, responses);
}
function web(id: string, fields: Fields<PanelWebSpec>, context = BASE): void {
  query(id, { kind: 'web', projectId: P, ...fields }, context, DEFAULT_RESPONSES);
}
function sessions(id: string, fields: Fields<PanelSessionsSpec>, context = BASE, responses = DEFAULT_RESPONSES): void {
  query(id, { kind: 'sessions', projectId: P, ...fields }, context, responses);
}
function heatmap(id: string, fields: Fields<PanelHeatmapSpec>, context = BASE): void {
  query(id, { kind: 'heatmap', projectId: P, ...fields }, context, DEFAULT_RESPONSES);
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

const PROPERTY_MATHS: readonly string[] = ['sum', 'avg', 'min', 'max'];
for (const math of PANEL_TREND_MATHS) {
  trends(`math-${math}`, {
    dateRange: WEEK,
    series: [
      {
        event: 'Purchase',
        math,
        ...(PROPERTY_MATHS.includes(math) ? { property: 'amount' } : {}),
        ...(math === 'unique_groups' ? { groupType: 'company' } : {}),
      },
    ],
  });
}
trends('maths-combined', {
  dateRange: WEEK,
  series: [
    { event: '$pageview', math: 'total' },
    { event: '$pageview', math: 'unique_users' },
    { event: '$pageview', math: 'sessions' },
    { event: 'Purchase', math: 'avg_per_user' },
    { event: 'Purchase', math: 'sum', property: 'amount' },
  ],
});
trends(
  'maths-combined-properties-groups',
  {
    dateRange: WEEK,
    series: [
      { event: 'Purchase', math: 'avg', property: 'amount' },
      { event: 'Purchase', math: 'min', property: '$amount_cents' },
      { event: 'Purchase', math: 'max', property: '@pncp_margin' },
      { event: 'Login', math: 'unique_groups', groupType: 'company' },
      { event: 'Login', math: 'unique_groups', groupType: 'team', label: 'Teams' },
    ],
  },
  FULL,
);

trends('interval-hour', { dateRange: { preset: 'today' }, interval: 'hour', series: [{ event: '$pageview' }] });
trends('interval-hour-coarsened-to-day', { dateRange: { preset: '30d' }, interval: 'hour', series: [{ event: '$pageview' }] });
trends('interval-day', { dateRange: { preset: '7d' }, interval: 'day', series: [{ event: '$pageview' }] });
trends('interval-week', { dateRange: { preset: '90d' }, interval: 'week', series: [{ event: '$pageview' }] });
trends('interval-month', { dateRange: { preset: '12m' }, interval: 'month', series: [{ event: '$pageview' }] });

const ZONES: [string, string, { from: string; to: string }][] = [
  ['europe-amsterdam-winter', 'Europe/Amsterdam', NOVEMBER],
  ['europe-amsterdam-summer', 'Europe/Amsterdam', { from: '2026-07-01', to: '2026-07-02' }],
  ['america-new-york', 'America/New_York', NOVEMBER],
  ['america-los-angeles-summer', 'America/Los_Angeles', { from: '2026-06-01', to: '2026-06-30' }],
  ['america-st-johns', 'America/St_Johns', NOVEMBER],
  ['asia-kolkata', 'Asia/Kolkata', NOVEMBER],
  ['asia-kathmandu', 'Asia/Kathmandu', NOVEMBER],
  ['australia-adelaide', 'Australia/Adelaide', NOVEMBER],
  ['pacific-chatham', 'Pacific/Chatham', NOVEMBER],
];
for (const [name, timezone, dateRange] of ZONES) {
  trends(`timezone-${name}`, { dateRange, timezone, series: [{ event: '$pageview', math: 'unique_users' }] });
}
trends('timezone-hour', { dateRange: { preset: 'today' }, timezone: 'Europe/Amsterdam', interval: 'hour', series: [{ event: '$pageview' }] });
trends('timezone-week', { dateRange: { preset: '90d' }, timezone: 'America/New_York', interval: 'week', series: [{ event: '$pageview' }] });
trends('timezone-month', { dateRange: { preset: '12m' }, timezone: 'Asia/Kolkata', interval: 'month', series: [{ event: '$pageview' }] });

for (const preset of PANEL_DATE_PRESETS) trends(`range-${preset}`, { dateRange: { preset }, series: [{ event: 'Signed up' }] });
trends('range-custom', { dateRange: { from: '2026-10-01', to: '2026-10-31' }, series: [{ event: 'Signed up' }] });
trends('range-clamped-to-retention', { dateRange: { from: '2020-01-01', to: '2026-11-14' }, series: [{ event: 'Signed up' }] }, { ...BASE, retentionDays: 30 });
trends('range-capped-at-25-months', { dateRange: { from: '2020-01-01', to: '2026-11-14' }, series: [{ event: 'Signed up' }] }, { ...BASE, retentionDays: 100000 });
trends('range-ends-in-future', { dateRange: { from: '2026-11-01', to: '2027-12-31' }, series: [{ event: 'Signed up' }] });
trends('range-entirely-in-future', { dateRange: { from: '2027-01-01', to: '2027-01-31' }, series: [{ event: 'Signed up' }] });

trends('compare', { dateRange: { preset: '30d' }, series: [{ event: '$pageview', math: 'unique_users' }], compare: true });
trends('compare-breakdown', { dateRange: { preset: '7d' }, series: [{ event: '$pageview' }], breakdown: COUNTRY, compare: true });
trends('compare-timezone-week', { dateRange: { preset: '90d' }, timezone: 'America/New_York', interval: 'week', series: [{ event: '$pageview' }], compare: true });
trends('compare-clamped-to-retention', { dateRange: { preset: '30d' }, series: [{ event: '$pageview' }], compare: true }, { ...BASE, retentionDays: 30 });

const SIGNED_UP = [{ event: 'Signed up' }];
trends('breakdown-column-country', { series: SIGNED_UP, breakdown: { source: 'column', field: 'country', limit: 2 } });
trends('breakdown-column-path-rules', { series: SIGNED_UP, breakdown: { source: 'column', field: 'path' } }, FULL);
trends('breakdown-column-path-rules-off', { series: SIGNED_UP, breakdown: { source: 'column', field: 'path' }, cleanPaths: false }, FULL);
trends('breakdown-column-path-no-rules', { series: SIGNED_UP, breakdown: { source: 'column', field: 'path' } });
trends('breakdown-event', { series: SIGNED_UP, breakdown: { source: 'event', key: 'plan' } });
trends('breakdown-event-system-key', { series: SIGNED_UP, breakdown: { source: 'event', key: '$browser_language' } });
trends('breakdown-person', { series: SIGNED_UP, breakdown: { source: 'person', key: 'plan', limit: 5 } });
trends('breakdown-group', { series: SIGNED_UP, breakdown: { source: 'group', groupType: 'company', key: 'industry' } }, FULL);
trends('breakdown-computed-formula', { series: SIGNED_UP, breakdown: { source: 'event', key: '@pncp_revenue' } }, FULL);
trends('breakdown-computed-coalesce', { series: SIGNED_UP, breakdown: { source: 'event', key: '@pncp_label' } }, FULL);
trends('breakdown-bucket-custom', { series: SIGNED_UP, breakdown: { source: 'event', key: 'amount', bucket: { kind: 'custom', edges: [10, 50] } } });
trends('breakdown-bucket-custom-decimals', {
  series: SIGNED_UP,
  breakdown: { source: 'event', key: 'amount', bucket: { kind: 'custom', edges: [-1.5, 0, 0.25, 1000000, 1000000000000] } },
});
trends('breakdown-bucket-auto', { series: SIGNED_UP, breakdown: { source: 'event', key: 'amount', bucket: { kind: 'auto', count: 4 } } });
trends('breakdown-bucket-auto-default-count', { series: SIGNED_UP, breakdown: { source: 'event', key: 'amount', bucket: { kind: 'auto' } } });
trends(
  'breakdown-bucket-auto-no-values',
  { series: SIGNED_UP, breakdown: { source: 'event', key: 'amount', bucket: { kind: 'auto' } } },
  BASE,
  withResponses({ 'trends.breakdownRange': [{ min0: null, max0: null }] }),
);
trends(
  'breakdown-bucket-auto-one-value',
  { series: SIGNED_UP, breakdown: { source: 'event', key: 'amount', bucket: { kind: 'auto' } } },
  BASE,
  withResponses({ 'trends.breakdownRange': [{ min0: 5, max0: 5 }] }),
);
trends('breakdown-bucket-person', { series: SIGNED_UP, breakdown: { source: 'person', key: 'age', bucket: { kind: 'custom', edges: [18, 30, 50] } } });
trends('breakdown-bucket-group-auto', { series: SIGNED_UP, breakdown: { source: 'group', groupType: 'company', key: 'employees', bucket: { kind: 'auto', count: 3 } } }, FULL);
trends('breakdown-bucket-computed', { series: SIGNED_UP, breakdown: { source: 'event', key: '@pncp_revenue', bucket: { kind: 'custom', edges: [100] } } }, FULL);
trends(
  'breakdowns-two-columns',
  { series: SIGNED_UP, breakdowns: [COUNTRY, { source: 'column', field: 'browser' }] },
  BASE,
  withResponses({ 'trends.breakdownValues': [{ value: 'NL / Chrome', v0: 'NL', v1: 'Chrome', n: 5 }] }),
);
trends(
  'breakdowns-three-mixed',
  {
    series: SIGNED_UP,
    breakdowns: [
      { source: 'column', field: 'path' },
      { source: 'person', key: 'plan' },
      { source: 'event', key: 'amount', bucket: { kind: 'auto', count: 3 } },
    ],
  },
  FULL,
  withResponses({ 'trends.breakdownValues': [{ value: '/users/:id / pro / 0 – 2', v0: '/users/:id', v1: 'pro', v2: '0 – 2', n: 5 }] }),
);
trends('breakdown-no-values', { series: SIGNED_UP, breakdown: COUNTRY }, BASE, withResponses({ 'trends.breakdownValues': [] }));
trends('breakdown-limit-25', { series: SIGNED_UP, breakdown: { source: 'column', field: 'utm_source', limit: 25 } });
trends(
  'breakdown-escaped-values',
  { series: SIGNED_UP, breakdown: { source: 'column', field: 'path' } },
  BASE,
  withResponses({
    'trends.breakdownValues': [
      { value: "x' OR '1'='1", n: 5 },
      { value: 'C:\\x', n: 4 },
      { value: 'a\nb\tc', n: 3 },
      { value: 'caf\u00e9 \u2615 \u{1F600}', n: 2 },
      { value: '', n: 1 },
    ],
  }),
);

trends('formulas', {
  dateRange: WEEK,
  series: [{ event: 'A' }, { event: 'B' }],
  formulas: [{ expression: 'B / A * 100', label: 'Rate' }, { expression: '(A + B) - -1' }],
});
trends('formula-only', { dateRange: WEEK, series: [{ event: 'A' }], formulas: [{ expression: 'A * 2' }], formulaOnly: true });

trends('cumulative', {
  dateRange: WEEK,
  display: 'cumulative',
  series: [
    { event: 'A' },
    { event: 'A', math: 'unique_users' },
    { event: 'A', math: 'sessions' },
    { event: 'A', math: 'unique_groups', groupType: 'company' },
    { event: 'A', math: 'avg', property: 'amount' },
  ],
});
trends('cumulative-breakdown', { dateRange: WEEK, display: 'cumulative', series: [{ event: 'A', math: 'unique_users' }], breakdown: COUNTRY });
trends('cumulative-compare-timezone', {
  dateRange: WEEK,
  timezone: 'Asia/Kolkata',
  display: 'cumulative',
  compare: true,
  series: [{ event: 'A', math: 'unique_users' }, { event: 'A', math: 'sum', property: 'amount' }],
});
trends('display-bar', { dateRange: WEEK, display: 'bar', series: [{ event: 'A' }] });

// Filters: every source and operator, one statement pair per source.
const PAGEVIEWS = [{ event: '$pageview' }];
const filterCase = (id: string, filters: PanelFilter[], context = BASE) => trends(id, { dateRange: { preset: '7d' }, series: PAGEVIEWS, filters }, context);

filterCase('filters-column', [
  { source: 'column', field: 'country', operator: 'eq', value: 'NL' },
  { source: 'column', field: 'browser', operator: 'neq', value: 'Chrome' },
  { source: 'column', field: 'path', operator: 'contains', value: '/Pricing' },
  { source: 'column', field: 'title', operator: 'not_contains', value: 'Test' },
  { source: 'column', field: 'utm_source', operator: 'gt', value: 'a' },
  { source: 'column', field: 'utm_medium', operator: 'lt', value: 5 },
  { source: 'column', field: 'referrer_host', operator: 'is_set' },
  { source: 'column', field: 'utm_campaign', operator: 'is_not_set' },
  { source: 'column', field: 'device_type', operator: 'in', value: ['mobile', 'tablet'] },
  { source: 'column', field: 'region', operator: 'in', value: [1, 2] },
  { source: 'column', field: 'host', operator: 'eq', value: true },
  { source: 'column', field: 'el_selector', operator: 'eq', value: 42 },
  { source: 'column', field: 'city', operator: 'neq', value: 7 },
]);
filterCase('filters-every-column', [
  { source: 'column', field: 'path', operator: 'is_set' },
  { source: 'column', field: 'url', operator: 'is_set' },
  { source: 'column', field: 'host', operator: 'is_set' },
  { source: 'column', field: 'title', operator: 'is_set' },
  { source: 'column', field: 'referrer', operator: 'is_set' },
  { source: 'column', field: 'referrer_host', operator: 'is_set' },
  { source: 'column', field: 'utm_source', operator: 'is_set' },
  { source: 'column', field: 'utm_medium', operator: 'is_set' },
  { source: 'column', field: 'utm_campaign', operator: 'is_set' },
  { source: 'column', field: 'utm_content', operator: 'is_set' },
  { source: 'column', field: 'utm_term', operator: 'is_set' },
  { source: 'column', field: 'country', operator: 'is_set' },
  { source: 'column', field: 'region', operator: 'is_set' },
  { source: 'column', field: 'city', operator: 'is_set' },
  { source: 'column', field: 'device_type', operator: 'is_set' },
  { source: 'column', field: 'browser', operator: 'is_set' },
  { source: 'column', field: 'os', operator: 'is_set' },
  { source: 'column', field: 'el_selector', operator: 'is_set' },
  { source: 'column', field: 'el_text', operator: 'is_set' },
]);
filterCase('filters-event', [
  { source: 'event', key: 'plan', operator: 'eq', value: 'pro' },
  { source: 'event', key: 'amount', operator: 'eq', value: 3 },
  { source: 'event', key: 'paid', operator: 'eq', value: true },
  { source: 'event', key: 'trial', operator: 'eq', value: false },
  { source: 'event', key: 'plan', operator: 'neq', value: 'free' },
  { source: 'event', key: 'amount', operator: 'neq', value: 0 },
  { source: 'event', key: 'paid', operator: 'neq', value: false },
  { source: 'event', key: 'label', operator: 'contains', value: 'Promo' },
  { source: 'event', key: 'label', operator: 'not_contains', value: 'test' },
  { source: 'event', key: 'sku', operator: 'contains', value: 12 },
  { source: 'event', key: 'amount', operator: 'gt', value: 12.5 },
  { source: 'event', key: 'amount', operator: 'lt', value: -3 },
  { source: 'event', key: 'plan', operator: 'gt', value: 'b' },
  { source: 'event', key: 'plan', operator: 'lt', value: 'y' },
  { source: 'event', key: 'coupon', operator: 'is_set' },
  { source: 'event', key: 'referral', operator: 'is_not_set' },
  { source: 'event', key: 'quantity', operator: 'in', value: [1, 2.5] },
  { source: 'event', key: 'plan', operator: 'in', value: ['pro', 'team'] },
  { source: 'event', key: 'size', operator: 'in', value: [1, 'xl'] },
  { source: 'event', key: '$action', operator: 'eq', value: 'click' },
]);
filterCase('filters-person', [
  { source: 'person', key: 'plan', operator: 'eq', value: 'pro' },
  { source: 'person', key: 'seats', operator: 'eq', value: 10 },
  { source: 'person', key: 'verified', operator: 'eq', value: true },
  { source: 'person', key: 'plan', operator: 'neq', value: 'free' },
  { source: 'person', key: '$email', operator: 'contains', value: '@Example.com' },
  { source: 'person', key: '$name', operator: 'not_contains', value: 'bot' },
  { source: 'person', key: 'seats', operator: 'gt', value: 5 },
  { source: 'person', key: 'seats', operator: 'lt', value: 500 },
  { source: 'person', key: '$created', operator: 'gt', value: '2026-01-01' },
  { source: 'person', key: '$avatar', operator: 'is_set' },
  { source: 'person', key: 'churned', operator: 'is_not_set' },
  { source: 'person', key: 'plan', operator: 'in', value: ['pro', 'team'] },
  { source: 'person', key: 'seats', operator: 'in', value: [5, 10] },
]);
filterCase(
  'filters-group',
  [
    { source: 'group', groupType: 'company', key: 'plan', operator: 'eq', value: 'enterprise' },
    { source: 'group', groupType: 'company', key: 'employees', operator: 'gt', value: 50 },
    { source: 'group', groupType: 'company', key: 'industry', operator: 'neq', value: 'retail' },
    { source: 'group', groupType: 'company', key: 'name', operator: 'contains', value: 'Acme' },
    { source: 'group', groupType: 'company', key: 'domain', operator: 'is_set' },
    { source: 'group', groupType: 'company', key: 'churned', operator: 'is_not_set' },
    { source: 'group', groupType: 'team', key: 'tier', operator: 'in', value: ['a', 'b'] },
    { source: 'group', groupType: 'team', key: 'active', operator: 'eq', value: true },
  ],
  FULL,
);
filterCase(
  'filters-group-key',
  [
    { source: 'group_key', groupType: 'company', operator: 'is_set' },
    { source: 'group_key', groupType: 'team', operator: 'is_not_set' },
    { source: 'group_key', groupType: 'company', operator: 'eq', value: 'acme' },
    { source: 'group_key', groupType: 'company', operator: 'in', value: ['acme', 'globex'] },
    { source: 'group_key', groupType: 'company', operator: 'contains', value: 'corp' },
  ],
  FULL,
);
filterCase(
  'filters-computed-formula',
  [
    { source: 'event', key: '@pncp_revenue', operator: 'gt', value: 0 },
    { source: 'event', key: '@pncp_revenue', operator: 'eq', value: 10 },
    { source: 'event', key: '@pncp_revenue', operator: 'neq', value: 10 },
    { source: 'event', key: '@pncp_revenue', operator: 'in', value: [1, 2] },
    { source: 'event', key: '@pncp_revenue', operator: 'in', value: [1, 'x'] },
    { source: 'event', key: '@pncp_revenue', operator: 'is_set' },
    { source: 'event', key: '@pncp_revenue', operator: 'is_not_set' },
    { source: 'event', key: '@pncp_revenue', operator: 'contains', value: '9' },
    { source: 'event', key: '@pncp_margin', operator: 'lt', value: 0.5 },
    { source: 'event', key: '@pncp_tiny', operator: 'gt', value: 0 },
  ],
  FULL,
);
filterCase(
  'filters-computed-coalesce',
  [
    { source: 'event', key: '@pncp_label', operator: 'eq', value: "it's" },
    { source: 'event', key: '@pncp_label', operator: 'eq', value: 3 },
    { source: 'event', key: '@pncp_label', operator: 'gt', value: 'm' },
    { source: 'event', key: '@pncp_label', operator: 'in', value: ['a', 1] },
    { source: 'event', key: '@pncp_label', operator: 'is_set' },
    { source: 'event', key: '@pncp_amount', operator: 'eq', value: 5 },
    { source: 'event', key: '@pncp_amount', operator: 'lt', value: 3 },
    { source: 'event', key: '@pncp_amount', operator: 'in', value: [1, 2] },
    { source: 'event', key: '@pncp_amount', operator: 'not_contains', value: '0' },
  ],
  FULL,
);
filterCase('filters-cohort', [{ source: 'cohort', cohortId: 'pnc_1' }], FULL);
filterCase('filters-cohort-negated', [{ source: 'cohort', cohortId: 'pnc_1', negate: true }], FULL);
filterCase('filters-cohort-any', [{ source: 'cohort', cohortId: 'pnc_any' }], FULL);
filterCase('filters-cohort-anonymous', [{ source: 'cohort', cohortId: 'pnc_any' }], FULL_ANONYMOUS);
filterCase('filters-cohort-clamped-to-retention', [{ source: 'cohort', cohortId: 'pnc_any' }], { ...FULL, retentionDays: 30 });
filterCase('filters-escaping', [
  { source: 'column', field: 'path', operator: 'eq', value: "x' OR '1'='1" },
  { source: 'column', field: 'path', operator: 'neq', value: 'a\\b' },
  { source: 'column', field: 'title', operator: 'eq', value: 'a\nb' },
  { source: 'column', field: 'title', operator: 'neq', value: '\\' },
  { source: 'column', field: 'url', operator: 'eq', value: "it's\\" },
  { source: 'column', field: 'url', operator: 'neq', value: 'a\u007fb' },
  { source: 'column', field: 'el_text', operator: 'eq', value: '\ttab\r\n' },
  { source: 'column', field: 'el_text', operator: 'neq', value: 'caf\u00e9 \u65e5\u672c \u{1F600}' },
  { source: 'column', field: 'path', operator: 'contains', value: '50%_off!' },
  { source: 'column', field: 'path', operator: 'not_contains', value: "O'Brien\\%" },
  { source: 'event', key: 'note', operator: 'in', value: ["a'b", 'c\\d', 'e\nf'] },
  { source: 'person', key: 'name', operator: 'contains', value: '  spaced  ' },
  { source: 'event', key: 'quote', operator: 'gt', value: "'" },
]);
trends(
  'filters-series',
  {
    dateRange: { preset: '7d' },
    filters: [{ source: 'column', field: 'country', operator: 'eq', value: 'NL' }],
    series: [
      { event: 'Purchase', filters: [{ source: 'event', key: 'currency', operator: 'eq', value: 'EUR' }] },
      { event: 'Purchase', math: 'unique_users', filters: [{ source: 'person', key: 'plan', operator: 'eq', value: 'pro' }, { source: 'cohort', cohortId: 'pnc_1' }] },
      { event: 'Purchase', math: 'sum', property: 'amount', filters: [{ source: 'group', groupType: 'company', key: 'plan', operator: 'is_set' }] },
    ],
  },
  FULL,
);

trends('event-names', {
  dateRange: WEEK,
  series: [{ event: 'Signed up' }, { event: 'checkout.completed' }, { event: 'page/view:x-1' }, { event: '$app_opened' }, { event: 'A_b' }],
});
trends('custom-events', { dateRange: WEEK, series: [{ event: '@pnce_signup', math: 'unique_users' }, { event: '@pnce_checkout' }, { event: 'Login' }] }, FULL);

const CONTEXT_SPEC: Fields<PanelTrendsSpec> = { dateRange: WEEK, series: [{ event: 'Signed up', math: 'unique_users' }], breakdown: { source: 'person', key: 'plan' } };
trends('context-identified', CONTEXT_SPEC, BASE);
trends('context-anonymous', CONTEXT_SPEC, ANONYMOUS);
trends('context-erased', CONTEXT_SPEC, ERASED);
trends('context-workspace-quote', CONTEXT_SPEC, { ...BASE, workspaceId: "ws_'evil" });

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

const ABC = [{ event: 'A' }, { event: 'B' }, { event: 'C' }];
const ABCD = [{ event: 'A' }, { event: 'B' }, { event: 'C' }, { event: 'D' }];

funnel('loose', { steps: ABC });
funnel('window-minute', { steps: ABC, window: { value: 30, unit: 'minute' } });
funnel('window-hour', { steps: ABC, window: { value: 2, unit: 'hour' } });
funnel('window-366-days', { steps: ABC, window: { value: 366, unit: 'day' } });
funnel('loose-same-event-twice', { steps: [{ event: 'A' }, { event: 'A' }, { event: 'B' }] });
funnel('loose-optional-step', { steps: [{ event: 'A' }, { event: 'B', optional: true }, { event: 'C' }] });
funnel('loose-two-optional-steps', { steps: [{ event: 'A' }, { event: 'B', optional: true }, { event: 'C', optional: true }, { event: 'D' }] });
funnel('loose-optional-then-same-event', { steps: [{ event: 'A' }, { event: 'B', optional: true }, { event: 'A' }] });
funnel('loose-exclusions', {
  steps: ABCD,
  exclusions: [
    { event: 'X', fromStep: 0, toStep: 3 },
    { event: 'Y', fromStep: 1, toStep: 2, filters: [{ source: 'column', field: 'country', operator: 'eq', value: 'NL' }] },
  ],
});
funnel('loose-hold-constant-column-path', { steps: ABC, holdConstant: { source: 'column', field: 'path' } }, FULL);
funnel('loose-hold-constant-event', { steps: ABC, holdConstant: { source: 'event', key: 'product' } });
funnel('loose-hold-constant-person', { steps: ABC, holdConstant: { source: 'person', key: 'plan' } });
funnel('loose-hold-constant-group', { steps: ABC, holdConstant: { source: 'group', groupType: 'company', key: 'plan' } }, FULL);
funnel('loose-breakdown', { steps: ABC, breakdown: { source: 'event', key: 'plan' } });
funnel(
  'loose-breakdowns-bucketed',
  { steps: ABC, breakdowns: [COUNTRY, { source: 'event', key: 'amount', bucket: { kind: 'auto', count: 4 } }] },
  BASE,
  withResponses({ 'funnel.breakdownValues': [{ value: 'NL / 0 – 250', v0: 'NL', v1: '0 – 250', n: 7 }] }),
);
funnel('loose-breakdown-no-values', { steps: ABC, breakdown: COUNTRY }, BASE, withResponses({ 'funnel.breakdownValues': [] }));
funnel('loose-breakdown-hold-exclusions', {
  steps: ABCD,
  breakdown: { source: 'person', key: 'plan' },
  holdConstant: { source: 'event', key: 'product' },
  exclusions: [{ event: 'X', fromStep: 1, toStep: 3 }],
});
funnel('strict', { steps: ABC, order: 'strict' });
funnel('strict-optional-step', { steps: [{ event: 'A' }, { event: 'B', optional: true }, { event: 'C' }], order: 'strict' });
funnel('strict-two-optional-steps', { steps: [{ event: 'A' }, { event: 'B', optional: true }, { event: 'C', optional: true }, { event: 'D' }], order: 'strict' });
funnel('strict-optional-hold-constant', { steps: [{ event: 'A' }, { event: 'B', optional: true }, { event: 'C' }], order: 'strict', holdConstant: { source: 'event', key: 'product' } });
funnel('strict-breakdown', { steps: ABC, order: 'strict', breakdown: COUNTRY });
funnel('strict-exclusions', { steps: ABCD, order: 'strict', exclusions: [{ event: 'X', fromStep: 0, toStep: 2 }, { event: 'Y', fromStep: 2, toStep: 3 }] });
funnel('any', { steps: ABC, order: 'any' });
funnel('any-hold-constant-breakdown', { steps: ABC, order: 'any', holdConstant: { source: 'column', field: 'browser' }, breakdown: { source: 'event', key: 'plan' } });
funnel('aggregate-group-loose', { steps: ABC, aggregateBy: { groupType: 'company' } }, FULL);
funnel('aggregate-group-strict', { steps: ABC, order: 'strict', aggregateBy: { groupType: 'company' }, breakdown: COUNTRY }, FULL);
funnel('aggregate-group-any', { steps: ABC, order: 'any', aggregateBy: { groupType: 'team' } }, FULL);
funnel('aggregate-person', { steps: ABC, aggregateBy: 'person' });
funnel('time-to-convert', { steps: ABC, display: 'time_to_convert' });
funnel('time-to-convert-strict-breakdown', { steps: ABC, order: 'strict', breakdown: COUNTRY, display: 'time_to_convert' });
funnel('time-to-convert-any', { steps: ABC, order: 'any', display: 'time_to_convert' });
funnel('time-to-convert-exclusions', { steps: ABC, exclusions: [{ event: 'X', fromStep: 0, toStep: 2 }], display: 'time_to_convert' });
funnel('trends-display-hour', { dateRange: { preset: 'today' }, steps: ABC, display: 'trends', interval: 'hour' });
funnel('trends-display-hour-coarsened', { dateRange: { preset: '30d' }, steps: ABC, display: 'trends', interval: 'hour' });
funnel('trends-display-default-day', { steps: ABC, display: 'trends' });
funnel('trends-display-week-timezone', { dateRange: { preset: '90d' }, timezone: 'America/New_York', steps: ABC, display: 'trends', interval: 'week' });
funnel('trends-display-month', { dateRange: { preset: '12m' }, steps: ABC, display: 'trends', interval: 'month', breakdown: COUNTRY });
funnel('trends-display-strict-groups', { steps: ABC, order: 'strict', aggregateBy: { groupType: 'company' }, display: 'trends', interval: 'week' }, FULL);
funnel('display-steps', { steps: ABC, display: 'steps' });
funnel(
  'custom-events-and-computed',
  {
    steps: [{ event: '@pnce_signup' }, { event: 'Purchase', filters: [{ source: 'event', key: '@pncp_revenue', operator: 'gt', value: 100 }] }, { event: '@pnce_checkout' }],
    exclusions: [{ event: '@pnce_checkout', fromStep: 0, toStep: 1 }],
  },
  FULL,
);
funnel('filters', { steps: ABC, filters: FILTERS }, FULL);
funnel('timezone', { steps: ABC, timezone: 'Asia/Kolkata', dateRange: NOVEMBER, display: 'trends' });
funnel('ten-steps', { steps: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'].map((event) => ({ event })) });
funnel('anonymous', { steps: ABC, breakdown: COUNTRY }, ANONYMOUS);
funnel('erased', { steps: ABC, breakdown: COUNTRY }, ERASED);

correlation('loose', { steps: [{ event: 'A' }, { event: 'B' }] });
correlation('strict-exclusions', { steps: ABC, order: 'strict', exclusions: [{ event: 'X', fromStep: 0, toStep: 2 }], limit: 5 });
correlation('hold-constant-optional', { steps: [{ event: 'A' }, { event: 'B', optional: true }, { event: 'C' }], holdConstant: { source: 'event', key: 'product' } });
correlation('window-hour', { steps: [{ event: 'A' }, { event: 'B' }], window: { value: 3, unit: 'hour' } });
correlation('anonymous', { steps: [{ event: 'A' }, { event: 'B' }] }, ANONYMOUS);
correlation('erased', { steps: [{ event: 'A' }, { event: 'B' }] }, ERASED);

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

retention('week-default', { firstEvent: 'Signed up', returnEvent: 'Login' });
retention('day', { firstEvent: 'Signed up', returnEvent: 'Login', interval: 'day', periods: 14, dateRange: { preset: '30d' } });
retention('month', { firstEvent: 'Signed up', returnEvent: 'Login', interval: 'month', periods: 6, dateRange: { preset: '12m' } });
retention('any-return-event', { firstEvent: '$pageview' });
retention('first-time', { firstEvent: 'Signed up', returnEvent: 'Login', mode: 'first_time' });
retention('recurring', { firstEvent: 'Login', mode: 'recurring' });
retention('recurring-month', { firstEvent: 'Login', mode: 'recurring', interval: 'month', dateRange: { preset: '12m' } });
retention('unbounded', { firstEvent: 'Signed up', returnEvent: 'Login', unbounded: true });
retention('unbounded-breakdown', { firstEvent: 'Signed up', returnEvent: 'Login', unbounded: true, breakdown: COUNTRY });
retention('breakdown-column', { firstEvent: 'Signed up', breakdown: COUNTRY });
retention('breakdown-path-rules', { firstEvent: 'Signed up', breakdown: { source: 'column', field: 'path' } }, FULL);
retention('breakdown-event', { firstEvent: 'Signed up', breakdown: { source: 'event', key: 'plan' } });
retention('breakdown-person', { firstEvent: 'Signed up', breakdown: { source: 'person', key: 'plan' } });
retention('breakdown-group', { firstEvent: 'Signed up', breakdown: { source: 'group', groupType: 'company', key: 'plan' } }, FULL);
retention('breakdown-bucket-auto', { firstEvent: 'Signed up', breakdown: { source: 'event', key: 'amount', bucket: { kind: 'auto', count: 3 } } });
retention('breakdown-no-values', { firstEvent: 'Signed up', breakdown: COUNTRY }, BASE, withResponses({ 'retention.breakdownValues': [] }));
retention('aggregate-group', { firstEvent: 'Login', aggregateBy: { groupType: 'company' } }, FULL);
retention('aggregate-group-first-time-unbounded', { firstEvent: 'Login', returnEvent: 'Purchase', aggregateBy: { groupType: 'company' }, mode: 'first_time', unbounded: true }, FULL);
retention('timezone-day', { firstEvent: 'Signed up', interval: 'day', timezone: 'America/New_York', dateRange: { preset: '30d' } });
retention('timezone-week', { firstEvent: 'Signed up', interval: 'week', timezone: 'Asia/Kathmandu' });
retention('timezone-month', { firstEvent: 'Signed up', interval: 'month', timezone: 'Europe/Amsterdam', dateRange: { preset: '12m' } });
retention('custom-events', { firstEvent: '@pnce_signup', returnEvent: '@pnce_checkout' }, FULL);
retention('filters', { firstEvent: 'Signed up', returnEvent: 'Login', filters: FILTERS }, FULL);
retention('anonymous', { firstEvent: 'Signed up', returnEvent: 'Login' }, ANONYMOUS);
retention('erased', { firstEvent: 'Signed up', returnEvent: 'Login' }, ERASED);

// ---------------------------------------------------------------------------
// Flows, stickiness, lifecycle
// ---------------------------------------------------------------------------

flows('after-all', { anchor: { event: 'Signed up' } });
flows('before-pageviews', { anchor: { event: 'Purchase' }, direction: 'before', depth: 4, scope: 'pageviews' });
flows('custom-scope-depth-5', { anchor: { event: 'Signed up' }, scope: 'custom', depth: 5 });
flows('depth-1', { anchor: { event: 'Signed up' }, depth: 1 });
flows('path-rules', { anchor: { event: '$pageview' }, scope: 'pageviews' }, FULL);
flows('path-rules-off', { anchor: { event: '$pageview' }, scope: 'pageviews', cleanPaths: false }, FULL);
flows('anchor-person-filter', { anchor: { event: 'Purchase', filters: [{ source: 'person', key: 'plan', operator: 'eq', value: 'pro' }] }, direction: 'before' });
flows('anchor-pageview-path', { anchor: { event: '$pageview', filters: [{ source: 'column', field: 'path', operator: 'eq', value: '/pricing' }] } });
flows('filters', { anchor: { event: 'Purchase' }, filters: FILTERS, limit: 50 }, FULL);
flows('anonymous', { anchor: { event: 'Signed up' } }, ANONYMOUS);
flows('erased', { anchor: { event: 'Signed up' } }, ERASED);

stickiness('intervals-day', { event: 'Login' });
stickiness('intervals-week', { event: 'Login', interval: 'week', dateRange: { preset: '90d' } });
stickiness('count', { event: 'Login', measure: 'count' });
stickiness('intervals-groups', { event: 'Login', aggregateBy: { groupType: 'company' } }, FULL);
stickiness('timezone', { event: 'Login', timezone: 'Asia/Kolkata' });
stickiness('anonymous', { event: 'Login' }, ANONYMOUS);
stickiness('erased', { event: 'Login' }, ERASED);

lifecycle('day', { event: 'Login' });
lifecycle('week', { event: 'Login', interval: 'week', dateRange: { preset: '90d' } });
lifecycle('month', { event: 'Login', interval: 'month', dateRange: { preset: '12m' } });
lifecycle('groups', { event: 'Login', interval: 'week', aggregateBy: { groupType: 'company' } }, FULL);
lifecycle('timezone-week', { event: 'Login', interval: 'week', timezone: 'America/New_York' });
lifecycle('timezone-month', { event: 'Login', interval: 'month', timezone: 'Asia/Kolkata', dateRange: { preset: '12m' } });
lifecycle('anonymous', { event: 'Login' }, ANONYMOUS);
lifecycle('erased', { event: 'Login' }, ERASED);

// ---------------------------------------------------------------------------
// Vitals, impact, signal
// ---------------------------------------------------------------------------

for (const metric of PANEL_VITALS_METRICS) vitals(`metric-${metric}`, { metric });
for (const percentile of ['p90', 'p95', 'p99'] as const) vitals(`percentile-${percentile}`, { metric: 'inp', percentile });
vitals('interval-hour', { dateRange: { preset: 'today' }, interval: 'hour' });
vitals('interval-hour-coarsened', { dateRange: { preset: '30d' }, interval: 'hour' });
vitals('interval-week', { dateRange: { preset: '90d' }, interval: 'week', metric: 'cls' });
vitals('interval-month', { dateRange: { preset: '12m' }, interval: 'month' });
vitals('path-rules', { metric: 'lcp' }, FULL);
vitals('path-rules-off', { metric: 'lcp', cleanPaths: false }, FULL);
vitals('timezone', { metric: 'fcp', timezone: 'Europe/Amsterdam', dateRange: NOVEMBER });
vitals('limit-50', { metric: 'ttfb', limit: 50 });
vitals('anonymous', {}, ANONYMOUS);
vitals('erased', {}, ERASED);

impact('total', { launchEvent: 'Used AI', launchDate: '2026-11-01', metric: { event: 'Purchase' }, windowDays: 7 });
impact('unique-users', { launchEvent: 'Used AI', launchDate: '2026-11-01', metric: { event: 'Purchase', math: 'unique_users' }, windowDays: 7 });
impact('sum', { launchEvent: 'Used AI', launchDate: '2026-11-01', metric: { event: 'Purchase', math: 'sum', property: 'amount' }, windowDays: 7 });
impact('avg-computed', { launchEvent: 'Used AI', launchDate: '2026-11-01', metric: { event: 'Purchase', math: 'avg', property: '@pncp_revenue' }, windowDays: 7 }, FULL);
impact('window-1-day', { launchEvent: 'Used AI', launchDate: '2026-11-13', metric: { event: 'Purchase' }, windowDays: 1 });
impact('window-90-days', { launchEvent: 'Used AI', launchDate: '2026-09-01', metric: { event: 'Purchase' }, windowDays: 90 });
impact('default-window', { launchEvent: 'Used AI', launchDate: '2026-10-20', metric: { event: 'Purchase' } });
impact('timezone', { launchEvent: 'Used AI', launchDate: '2026-11-01', metric: { event: 'Purchase' }, windowDays: 7, timezone: 'America/New_York' });
impact(
  'custom-events-filters',
  {
    launchEvent: '@pnce_signup',
    launchDate: '2026-11-01',
    metric: { event: '@pnce_checkout', filters: [{ source: 'column', field: 'country', operator: 'eq', value: 'NL' }] },
    windowDays: 7,
    filters: FILTERS,
  },
  FULL,
);
impact('anonymous', { launchEvent: 'Used AI', launchDate: '2026-11-01', metric: { event: 'Purchase' }, windowDays: 7 }, ANONYMOUS);
impact('erased', { launchEvent: 'Used AI', launchDate: '2026-11-01', metric: { event: 'Purchase' }, windowDays: 7 }, ERASED);

signal('candidates', { goal: { event: 'Purchase' }, candidates: ['Login', 'Signed up', 'Purchase'] });
signal('top-n', { goal: { event: 'Purchase' }, topN: 3 });
signal('top-n-none-found', { goal: { event: 'Purchase' }, topN: 5 }, BASE, withResponses({ 'signal.candidates': [] }));
signal('custom-events', { goal: { event: '@pnce_signup' }, candidates: ['@pnce_checkout', 'Login'] }, FULL);
signal('top-n-custom-goal', { goal: { event: '@pnce_signup' }, topN: 2 }, FULL);
signal(
  'goal-filters-window',
  { goal: { event: 'Purchase', filters: [{ source: 'person', key: 'plan', operator: 'eq', value: 'pro' }] }, candidates: ['Login'], windowDays: 30, filters: FILTERS },
  FULL,
);
signal('anonymous', { goal: { event: 'Purchase' }, candidates: ['Login'] }, ANONYMOUS);
signal('erased', { goal: { event: 'Purchase' }, candidates: ['Login'] }, ERASED);

// ---------------------------------------------------------------------------
// Web, sessions, heatmaps
// ---------------------------------------------------------------------------

web('default', {});
web('compare', { dateRange: { preset: '30d' }, compare: true });
web('today-hour', { dateRange: { preset: 'today' } });
web('all-panels', { panels: [...PANEL_WEB_PANELS] }, FULL);
web('panels-subset', { panels: ['channels', 'screenSizes'] });
web(
  'goals',
  {
    panels: ['topPages'],
    goals: [
      { label: 'Signed up', event: 'Signed up' },
      { label: 'Custom', event: '@pnce_signup' },
      { label: 'Pricing', pathPattern: '/pricing*' },
      { label: 'Escaped', pathPattern: "/50%_off!/*/c'd" },
      { label: 'Filtered', pathPattern: '/checkout', filters: [{ source: 'person', key: 'plan', operator: 'is_set' }] },
    ],
  },
  FULL,
);
web('path-rules-off', { cleanPaths: false }, FULL);
web('limit-50', { limit: 50, panels: ['topPages', 'entryExitPages'] });
web('timezone', { timezone: 'Europe/Amsterdam', dateRange: NOVEMBER });
web('group-filter', { filters: [{ source: 'group', groupType: 'company', key: 'plan', operator: 'eq', value: 'enterprise' }], panels: ['countries'] }, FULL);
web('anonymous', {}, ANONYMOUS);
web('erased', {}, ERASED);

for (const sort of PANEL_SESSION_SORTS) sessions(`sort-${sort.replace('_', '-')}`, { sort });
sessions('has-recording-false', { hasRecording: false });
sessions('favorites-none', { favoritesOnly: true });
sessions('favorites', { favoritesOnly: true }, FULL);
sessions('cohort-any', { cohortId: 'pnc_any' }, FULL);
sessions('custom-events', { didEvents: ['@pnce_signup', 'Purchase'], notDidEvents: ['@pnce_signup', '@pnce_checkout'] }, FULL);
sessions(
  'cursor-page-2',
  { limit: 2, cursor: 'o2' },
  BASE,
  withResponses({ 'sessions.list': ['a', 'b', 'c', 'd', 'e'].map((session_id) => ({ session_id })) }),
);
sessions('furthest-reach', { limit: 100, cursor: 'o400' });
sessions('no-rows', {}, BASE, withResponses({ 'sessions.list': [] }));
sessions('detail', { dateRange: { preset: '90d' }, sessionIds: ['s_1'], limit: 1 });
sessions('detail-wide', { dateRange: { from: '2020-01-01', to: '2026-11-14' }, sessionIds: ['s_1'], limit: 1 });
sessions('person', { dateRange: { preset: '90d' }, distinctId: 'user_1', limit: 10 });
sessions('escaping', { pagesVisited: ['50%_off!', "it's"], entryPage: 'C:\\x', exitPage: '/a_b', distinctId: "o'brien", countries: ["N'L"], browsers: ['Chrome'] });
sessions('anonymous', { distinctId: 'user_1' }, ANONYMOUS);
sessions('erased', { distinctId: 'user_1' }, ERASED);

for (const type of PANEL_HEATMAP_TYPES) {
  for (const deviceClass of PANEL_DEVICE_CLASSES) heatmap(`${type}-${deviceClass}`, { type, deviceClass, urlPattern: '/products/*' });
}
heatmap('page-group', { type: 'click', deviceClass: 'desktop', pageGroupId: 'pnh_1' }, FULL);
heatmap('escaped-pattern', { type: 'area', deviceClass: 'desktop', urlPattern: "/a_b/%/*/c'd" });
heatmap('root-pattern-7d-timezone', { type: 'scroll', deviceClass: 'mobile', urlPattern: '/', dateRange: { preset: '7d' }, timezone: 'Europe/Amsterdam' });
heatmap('anonymous', { type: 'click', deviceClass: 'desktop', urlPattern: '/' }, ANONYMOUS);
heatmap('erased', { type: 'click', deviceClass: 'desktop', urlPattern: '/' }, ERASED);

// ---------------------------------------------------------------------------
// compile.test.ts's isolation specs, under its three contexts
// ---------------------------------------------------------------------------

const ISOLATION_SPECS: Record<string, PanelQuerySpec> = {
  web: { kind: 'web', projectId: P, dateRange: { preset: '30d' }, filters: FILTERS, compare: true },
  'web (hour, no filters)': { kind: 'web', projectId: P, dateRange: { preset: 'today' } },
  trends: {
    kind: 'trends',
    projectId: P,
    dateRange: { from: '2026-10-01', to: '2026-10-31' },
    timezone: 'Europe/Amsterdam',
    filters: FILTERS,
    series: [
      { event: '$pageview', math: 'unique_users' },
      { event: 'Purchase', math: 'sum', property: 'amount', filters: [{ source: 'event', key: 'currency', operator: 'eq', value: 'EUR' }] },
      { event: 'Purchase', math: 'avg_per_user' },
    ],
    interval: 'week',
    breakdown: { source: 'person', key: 'plan', limit: 5 },
    compare: true,
  },
  'trends (column breakdown)': { kind: 'trends', projectId: P, dateRange: { preset: '7d' }, series: [{ event: '$pageview' }], breakdown: COUNTRY },
  funnel: {
    kind: 'funnel',
    projectId: P,
    dateRange: { preset: '90d' },
    filters: FILTERS,
    steps: [
      { event: '$pageview', filters: [{ source: 'column', field: 'path', operator: 'eq', value: '/pricing' }] },
      { event: 'Signed up' },
      { event: 'Added to cart' },
      { event: 'Purchase', filters: [{ source: 'person', key: 'plan', operator: 'is_set' }] },
    ],
    window: { value: 7, unit: 'day' },
    breakdown: { source: 'event', key: 'plan' },
  },
  retention: { kind: 'retention', projectId: P, dateRange: { preset: '90d' }, filters: FILTERS, firstEvent: 'Signed up', returnEvent: 'Login', interval: 'week', periods: 8 },
  flows: {
    kind: 'flows',
    projectId: P,
    dateRange: { preset: '30d' },
    filters: FILTERS,
    anchor: { event: 'Purchase', filters: [{ source: 'person', key: 'plan', operator: 'eq', value: 'pro' }] },
    direction: 'before',
    depth: 4,
    scope: 'pageviews',
  },
  'trends (formulas, refs, groups, buckets)': {
    kind: 'trends',
    projectId: P,
    filters: [{ source: 'group_key', groupType: 'company', operator: 'is_set' }],
    series: [
      { event: '@pnce_signup', math: 'unique_users' },
      { event: 'Purchase', math: 'sum', property: '@pncp_revenue', filters: [{ source: 'event', key: '@pncp_label', operator: 'eq', value: 'x' }] },
      { event: 'Purchase', math: 'unique_groups', groupType: 'company' },
    ],
    breakdowns: [
      { source: 'group', groupType: 'company', key: 'plan' },
      { source: 'event', key: 'amount', bucket: { kind: 'auto', count: 4 } },
      { source: 'column', field: 'path' },
    ],
    formulas: [{ expression: 'B / A' }, { expression: '(A + C) * 100', label: 'Reach' }],
    display: 'cumulative',
    compare: true,
  },
  'funnel (exclusions, hold, optional, ttc)': {
    kind: 'funnel',
    projectId: P,
    filters: FILTERS,
    steps: [{ event: '@pnce_signup' }, { event: 'Added to cart', optional: true }, { event: 'Checkout' }, { event: 'Purchase' }],
    exclusions: [
      { event: 'Refund', fromStep: 0, toStep: 3 },
      { event: '@pnce_signup', fromStep: 1, toStep: 2, filters: [{ source: 'column', field: 'country', operator: 'eq', value: 'NL' }] },
    ],
    holdConstant: { source: 'event', key: 'product' },
    breakdowns: [COUNTRY, { source: 'group', groupType: 'company', key: 'plan' }],
    display: 'time_to_convert',
  },
  'funnel (strict, optional, trends, groups)': {
    kind: 'funnel',
    projectId: P,
    steps: [{ event: 'A' }, { event: 'B', optional: true }, { event: 'C' }],
    order: 'strict',
    aggregateBy: { groupType: 'company' },
    exclusions: [{ event: 'X', fromStep: 0, toStep: 2 }],
    holdConstant: { source: 'column', field: 'path' },
    display: 'trends',
    interval: 'week',
  },
  funnel_correlation: {
    kind: 'funnel_correlation',
    projectId: P,
    filters: FILTERS,
    steps: [{ event: '@pnce_signup' }, { event: 'Purchase' }],
    exclusions: [{ event: 'Refund', fromStep: 0, toStep: 1 }],
    limit: 5,
  },
  'retention (breakdown, first time, unbounded)': {
    kind: 'retention',
    projectId: P,
    filters: FILTERS,
    firstEvent: '@pnce_signup',
    returnEvent: '@pnce_signup',
    breakdown: { source: 'group', groupType: 'company', key: 'plan' },
    mode: 'first_time',
    unbounded: true,
  },
  'stickiness (intervals)': { kind: 'stickiness', projectId: P, filters: FILTERS, event: '@pnce_signup' },
  lifecycle: { kind: 'lifecycle', projectId: P, filters: FILTERS, event: '@pnce_signup', interval: 'week' },
  vitals: { kind: 'vitals', projectId: P, filters: FILTERS, metric: 'inp', percentile: 'p90' },
  impact: {
    kind: 'impact',
    projectId: P,
    filters: FILTERS,
    launchEvent: '@pnce_signup',
    launchDate: '2026-11-01',
    metric: { event: 'Purchase', math: 'avg', property: '@pncp_revenue' },
    windowDays: 7,
  },
  signal: { kind: 'signal', projectId: P, filters: FILTERS, goal: { event: 'Purchase' }, candidates: ['@pnce_signup', 'Login'] },
  'heatmap click': { kind: 'heatmap', projectId: P, dateRange: { preset: '30d' }, type: 'click', deviceClass: 'mobile', pageGroupId: 'pnh_1' },
  'funnel (strict)': {
    kind: 'funnel',
    projectId: P,
    dateRange: { preset: '30d' },
    steps: [{ event: 'Signed up' }, { event: 'Signed up' }, { event: 'Purchase' }],
    order: 'strict',
    window: { value: 30, unit: 'minute' },
  },
  'retention (month, any return)': {
    kind: 'retention',
    projectId: P,
    dateRange: { preset: '12m' },
    timezone: 'America/New_York',
    firstEvent: '$pageview',
    interval: 'month',
    periods: 6,
  },
  'flows (after, custom)': { kind: 'flows', projectId: P, dateRange: { preset: '30d' }, anchor: { event: '$pageview' }, scope: 'custom' },
  sessions: {
    kind: 'sessions',
    projectId: P,
    dateRange: { preset: '30d' },
    minDurationSeconds: 10,
    maxDurationSeconds: 600,
    pagesVisited: ['/pricing', '/checkout'],
    entryPage: '/blog',
    exitPage: '/thanks',
    countries: ['NL'],
    devices: ['mobile'],
    browsers: ['Chrome'],
    distinctId: 'user_1',
    cohortId: 'pnc_1',
    sessionIds: ['s_1', 's_2'],
    didEvents: ['Signed up'],
    notDidEvents: ['Purchase'],
    frustration: ['rage', 'dead', 'quickback', 'excessive_scroll'],
    hasErrors: true,
    favoritesOnly: true,
    hasRecording: true,
    sort: 'frustration_desc',
    limit: 25,
    cursor: 'o25',
  },
  'sessions (defaults)': { kind: 'sessions', projectId: P },
  'heatmap area': { kind: 'heatmap', projectId: P, type: 'area', deviceClass: 'tablet', urlPattern: '/products/*' },
  'heatmap scroll': { kind: 'heatmap', projectId: P, type: 'scroll', deviceClass: 'desktop', urlPattern: '/' },
  'web (all panels, goals)': {
    kind: 'web',
    projectId: P,
    filters: [{ source: 'group', groupType: 'company', key: 'plan', operator: 'eq', value: 'enterprise' }],
    panels: ['topPages', 'entryExitPages', 'channels', 'hostnames', 'regions', 'cities', 'screenSizes'],
    goals: [
      { label: 'Signed up', event: '@pnce_signup' },
      { label: 'Pricing', pathPattern: '/pricing*', filters: [{ source: 'person', key: 'plan', operator: 'is_set' }] },
    ],
  },
  'trends (custom buckets, person)': {
    kind: 'trends',
    projectId: P,
    series: [{ event: '$pageview', math: 'sessions' }],
    breakdown: { source: 'person', key: 'age', bucket: { kind: 'custom', edges: [18, 30, 50] } },
    formulas: [{ expression: 'A * 2' }],
    formulaOnly: true,
  },
  'funnel (any order)': {
    kind: 'funnel',
    projectId: P,
    steps: [{ event: 'A' }, { event: 'B' }, { event: 'C', filters: [{ source: 'group', groupType: 'company', key: 'size', operator: 'gt', value: 10 }] }],
    order: 'any',
    holdConstant: { source: 'person', key: 'plan' },
    breakdown: { source: 'event', key: 'plan' },
    display: 'time_to_convert',
  },
  'funnel_correlation (any, groups)': {
    kind: 'funnel_correlation',
    projectId: P,
    steps: [{ event: 'A' }, { event: 'B' }],
    order: 'any',
    aggregateBy: { groupType: 'company' },
  },
  'retention (recurring, groups)': { kind: 'retention', projectId: P, firstEvent: 'Login', mode: 'recurring', aggregateBy: { groupType: 'company' }, interval: 'month' },
  'flows (path rules, custom event)': { kind: 'flows', projectId: P, anchor: { event: '@pnce_signup' }, scope: 'pageviews' },
  'sessions (custom events)': { kind: 'sessions', projectId: P, didEvents: ['@pnce_signup', 'Purchase'], notDidEvents: ['@pnce_signup'] },
  'stickiness (count, groups)': { kind: 'stickiness', projectId: P, event: 'Login', measure: 'count', interval: 'week', aggregateBy: { groupType: 'company' } },
  'lifecycle (month, groups)': { kind: 'lifecycle', projectId: P, event: 'Login', interval: 'month', aggregateBy: { groupType: 'company' } },
  'vitals (ttfb)': { kind: 'vitals', projectId: P, metric: 'ttfb', cleanPaths: false },
  'signal (top N)': { kind: 'signal', projectId: P, goal: { event: '@pnce_signup' }, topN: 3 },
};

const ISOLATION_CONTEXTS: Record<string, CorpusContextDraft> = { identified: FULL, anonymous: FULL_ANONYMOUS, erased: FULL_ERASED };

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

for (const [name, spec] of Object.entries(ISOLATION_SPECS)) {
  for (const [contextName, context] of Object.entries(ISOLATION_CONTEXTS)) {
    query(`isolation-${slug(name)}@${contextName}`, spec, context, DEFAULT_RESPONSES);
  }
}

// ---------------------------------------------------------------------------
// Explain (root cause)
// ---------------------------------------------------------------------------

function explain(id: string, request: ExplainPanelChangeInput, context = BASE): void {
  cases.push({ id: `explain/trends/${id}`, input: { call: 'explain', context, request } });
}

const EXPLAIN_SPEC: PanelTrendsSpec = { kind: 'trends', projectId: P, dateRange: WEEK, series: [{ event: 'A' }] };
explain('whole-range', { projectId: P, spec: EXPLAIN_SPEC });
explain('bucket-day', { projectId: P, spec: EXPLAIN_SPEC, bucket: '2026-11-12' });
explain('bucket-hour', { projectId: P, spec: { ...EXPLAIN_SPEC, dateRange: { preset: 'today' }, interval: 'hour' }, bucket: '2026-11-14T09:00' });
explain('bucket-week', { projectId: P, spec: { ...EXPLAIN_SPEC, dateRange: { preset: '90d' }, interval: 'week' }, bucket: '2026-11-02' });
explain('bucket-month', { projectId: P, spec: { ...EXPLAIN_SPEC, dateRange: { preset: '12m' }, interval: 'month' }, bucket: '2026-10-01' });
explain('period', { projectId: P, spec: EXPLAIN_SPEC, period: { from: '2026-11-10', to: '2026-11-12' } });
explain(
  'properties',
  {
    projectId: P,
    spec: EXPLAIN_SPEC,
    properties: [
      { source: 'event', key: 'plan' },
      { source: 'person', key: 'plan' },
      { source: 'event', key: '@pncp_label', bucket: { kind: 'custom', edges: [1] } },
    ],
    limit: 10,
  },
  FULL,
);
explain('math-unique-users', { projectId: P, spec: { ...EXPLAIN_SPEC, series: [{ event: 'A', math: 'unique_users' }] } });
explain('math-unique-groups', { projectId: P, spec: { ...EXPLAIN_SPEC, series: [{ event: 'A', math: 'unique_groups', groupType: 'company' }] } }, FULL);
explain('math-sessions', { projectId: P, spec: { ...EXPLAIN_SPEC, series: [{ event: 'A', math: 'sessions' }] } });
explain('math-sum-computed', { projectId: P, spec: { ...EXPLAIN_SPEC, series: [{ event: 'Purchase', math: 'sum', property: '@pncp_revenue' }] } }, FULL);
explain(
  'filters-custom-event',
  {
    projectId: P,
    spec: { ...EXPLAIN_SPEC, filters: FILTERS, series: [{ event: '@pnce_signup', filters: [{ source: 'column', field: 'browser', operator: 'eq', value: 'Chrome' }] }] },
  },
  FULL,
);
explain('path-rules', { projectId: P, spec: EXPLAIN_SPEC }, FULL);
explain('path-rules-off', { projectId: P, spec: { ...EXPLAIN_SPEC, cleanPaths: false } }, FULL);
explain('timezone', { projectId: P, spec: { ...EXPLAIN_SPEC, timezone: 'Europe/Amsterdam' }, bucket: '2026-11-12' });
explain('strips-breakdowns-and-formulas', {
  projectId: P,
  spec: { ...EXPLAIN_SPEC, breakdown: COUNTRY, formulas: [{ expression: 'A * 2' }], compare: true },
});
explain('anonymous', { projectId: P, spec: EXPLAIN_SPEC }, ANONYMOUS);
explain('erased', { projectId: P, spec: EXPLAIN_SPEC }, ERASED);

// ---------------------------------------------------------------------------
// Raw exports (keyset paging)
// ---------------------------------------------------------------------------

type ExportPage = Extract<CorpusInputDraft, { call: 'exportPageQuery' }>['page'];

function exportPage(id: string, page: ExportPage, context = BASE): void {
  cases.push({ id: `export/${page.table}/${id}`, input: { call: 'exportPageQuery', context, page } });
}

const HOUR = { from: '2026-11-14T10:00:00.000Z', to: '2026-11-14T11:00:00.000Z' };
for (const table of PANEL_EXPORT_TABLE_NAMES) {
  exportPage('first-page', { table, ...HOUR });
  exportPage('erased', { table, ...HOUR }, ERASED);
}
exportPage('after-cursor-fractional', { table: 'events', ...HOUR, after: { time: '2026-11-14 10:15:30.123456', keys: ["ev_'1"] } });
exportPage('after-cursor', { table: 'people', ...HOUR, after: { time: '2026-11-14T10:15:30Z', keys: ['user_1', 3] } });
exportPage('after-cursor', { table: 'identities', ...HOUR, after: { time: '2026-11-14T10:15:30.5Z', keys: ['anon_1', 'CORP\\jdoe'] } });
exportPage('after-cursor', { table: 'groups', ...HOUR, after: { time: '2026-11-14 10:15:30', keys: ['company', 'acme', 2] } });
exportPage('limit', { table: 'events', ...HOUR, limit: 100 });
exportPage('partial-window', { table: 'events', from: '2026-11-14T10:20:30.500Z', to: '2026-11-14T10:50:00.000Z' });

// ---------------------------------------------------------------------------
// Activity (feeds, timelines) and the lexicon
// ---------------------------------------------------------------------------

type ActivityOptions = Extract<CorpusInputDraft, { call: 'activityQuery' }>['options'];
const FEED_EXCLUDED = ['$pageleave', '$identify'];

function activity(id: string, options: ActivityOptions, context = BASE): void {
  cases.push({ id: `activity/events/${id}`, input: { call: 'activityQuery', context, options } });
}
function activityCount(id: string, distinctId: string, days: number, context = BASE): void {
  cases.push({ id: `activity/count/${id}`, input: { call: 'activityCountQuery', context, distinctId, days } });
}

activity('person-feed', { distinctId: 'user_1', limit: 25, days: 90, excludeNames: FEED_EXCLUDED });
activity('person-card', { distinctId: 'user_1', limit: 10, days: 90, excludeNames: FEED_EXCLUDED });
activity('session-markers', { sessionId: 's_1', limit: 1000, days: 90, excludeNames: FEED_EXCLUDED });
activity('session-markers-wide', { sessionId: 's_1', limit: 1000, days: 365, excludeNames: FEED_EXCLUDED });
activity('session-summary', { sessionId: 's_1', limit: 400, days: 90, excludeNames: FEED_EXCLUDED });
activity('days-30', { distinctId: 'user_1', limit: 50, days: 30 });
activity('days-default-no-filters', { limit: 20 });
activity('escaping', { distinctId: "o'brien\\x", sessionId: "s'1", limit: 5, excludeNames: ["it's"] });
activity('anonymous', { distinctId: 'anon_1', limit: 25, days: 90, excludeNames: FEED_EXCLUDED }, ANONYMOUS);
activity('erased', { distinctId: 'user_1', limit: 25, days: 90, excludeNames: FEED_EXCLUDED }, ERASED);
activityCount('identified', 'user_1', 90);
activityCount('anonymous', 'anon_1', 90, ANONYMOUS);
activityCount('erased', 'user_1', 90, ERASED);
activityCount('days-400', "o'brien", 400);

for (const [name, context] of Object.entries({ identified: BASE, anonymous: ANONYMOUS, erased: ERASED })) {
  cases.push({ id: `lexicon/scan/${name}`, input: { call: 'lexiconQueries', context } });
}

// ---------------------------------------------------------------------------
// panel-api's own statements
// ---------------------------------------------------------------------------

const contextOf = (draft: CorpusContextDraft) => toContext(corpusContextSchema.parse(draft));

function panelApi(id: string, statements: PanelSqlQuery[]): void {
  panelApiCases.push({ id: `panel-api/${id}`, statements });
}

panelApi('usage-projects.ts/projectUsage', projectUsageQueries('ws_1', '2026-11'));
panelApi('usage-projects.ts/projectUsage-december', projectUsageQueries("ws_'q", '2026-12'));
panelApi('recordings.ts/chunkManifestQuery', [chunkManifestQuery(contextOf(BASE), 's_1')]);
panelApi('recordings.ts/chunkManifestQuery-escaped', [chunkManifestQuery(contextOf(BASE), "s'1\\x")]);
panelApi('erasure.ts/sessionsOf', [erasureSessionsQuery(contextOf(ERASED), ['user_gone', "anon'_gone"])]);
panelApi('erasure.ts/chunkKeysOf', [erasureChunksQuery(contextOf(ERASED), ['s_1', "s'2"])]);
for (const deviceClass of PANEL_DEVICE_CLASSES) {
  panelApi(`heatmaps.ts/findSnapshotChunks-${deviceClass}`, [
    snapshotVisitsQuery(contextOf(BASE), "/products/*_50%'", deviceClass),
    snapshotChunksQuery(contextOf(BASE), ['s_1', "s'2"]),
  ]);
}
panelApi('people.ts/cohortPeople', [cohortPeopleQuery(contextOf(FULL), 'pnc_1')]);
panelApi('people.ts/cohortPeople-any', [cohortPeopleQuery(contextOf(FULL), 'pnc_any')]);
panelApi('people.ts/cohortPeople-anonymous', [cohortPeopleQuery(contextOf(FULL_ANONYMOUS), 'pnc_1')]);
panelApi('groups.ts/groupActivityQueries', groupActivityQueries(contextOf(BASE), 'company', 'acme', 30));
panelApi('groups.ts/groupActivityQueries-erased', groupActivityQueries(contextOf(ERASED), 'team', "o'reilly", 90));

export const COMPILER_CASES: readonly CompilerCase[] = cases;
export const PANEL_API_CASES: readonly PanelApiCase[] = panelApiCases;
