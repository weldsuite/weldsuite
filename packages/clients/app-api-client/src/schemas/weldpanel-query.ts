/**
 * WeldPanel query specs (ADR PANEL-003): the typed spec a client posts to
 * `POST /api/panel/query`, the result shape per kind, and the cross-page link
 * helpers the UI uses (a funnel drop-off links to the recordings behind it).
 *
 * Clients never send SQL. `@weldsuite/panel-domain/query` compiles a spec to
 * Basin SQL; the workspace and project filters and the time bound come from
 * the authenticated context, never from the spec.
 *
 * Zod v3. Event names and property keys mirror the collector's patterns in
 * `@weldsuite/panel-domain/wire` (`CUSTOM_EVENT_NAME`, `PROPERTY_KEY`); a
 * panel-domain test keeps the copies in step.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Copy of the collector's `CUSTOM_EVENT_NAME` (wire.ts): what a person types for `track('Signed up')`. */
export const PANEL_CUSTOM_EVENT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 _.:/-]{0,98}[A-Za-z0-9_.:/-])?$/;
/** Copy of the collector's `PROPERTY_KEY` (wire.ts). */
export const PANEL_PROPERTY_KEY = /^[A-Za-z_]\w{0,63}$/;
/** `$`-prefixed names the SDK and collector send themselves (`$pageview`, `$rageclick`, ...). */
export const PANEL_SYSTEM_EVENT_NAME = /^\$[a-z]{2,32}$/;

export const PANEL_PAGEVIEW = '$pageview';

/** An event name in a spec: a custom event, or one of the `$` system events. */
export const panelEventNameSchema = z
  .string()
  .max(100)
  .refine((v) => PANEL_CUSTOM_EVENT_NAME.test(v) || PANEL_SYSTEM_EVENT_NAME.test(v), {
    message: 'Not a valid event name',
  });

/** A property key: a custom key, or a `$`-prefixed system one (`$email`, `$name`, `$action`). */
export const panelPropertyKeySchema = z
  .string()
  .max(65)
  .refine((v) => PANEL_PROPERTY_KEY.test(v.startsWith('$') ? v.slice(1) : v), {
    message: 'Not a valid property key',
  });

// ---------------------------------------------------------------------------
// Date range
// ---------------------------------------------------------------------------

export const PANEL_DATE_PRESETS = ['today', '7d', '30d', '90d', '12m'] as const;
export type PanelDatePreset = (typeof PANEL_DATE_PRESETS)[number];

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/**
 * A preset, or custom `from` / `to` days (YYYY-MM-DD, both inclusive, in the
 * spec's timezone). The compiler clamps the range to the plan's event
 * retention (25 months at most).
 */
export const panelDateRangeSchema = z.union([
  z.object({ preset: z.enum(PANEL_DATE_PRESETS) }),
  z.object({ from: ymd, to: ymd }).refine((v) => v.from <= v.to, { message: '`from` must not be after `to`' }),
]);
export type PanelDateRange = z.infer<typeof panelDateRangeSchema>;

export const PANEL_INTERVALS = ['hour', 'day', 'week', 'month'] as const;
export type PanelInterval = (typeof PANEL_INTERVALS)[number];

const timezoneSchema = z.string().min(1).max(64).default('UTC');

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export const PANEL_FILTER_OPERATORS = ['eq', 'neq', 'contains', 'not_contains', 'gt', 'lt', 'is_set', 'is_not_set', 'in'] as const;
export type PanelFilterOperator = (typeof PANEL_FILTER_OPERATORS)[number];

/** Standard `events_v1` columns a filter or breakdown may use. */
export const PANEL_FILTER_COLUMNS = [
  'path',
  'url',
  'host',
  'title',
  'referrer',
  'referrer_host',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'country',
  'region',
  'city',
  'device_type',
  'browser',
  'os',
  'el_selector',
  'el_text',
] as const;
export type PanelFilterColumn = (typeof PANEL_FILTER_COLUMNS)[number];

const filterScalar = z.union([z.string().max(2048), z.number().finite(), z.boolean()]);
const filterValue = z.union([filterScalar, z.array(z.union([z.string().max(2048), z.number().finite()])).max(100)]);

const filterOperator = z.enum(PANEL_FILTER_OPERATORS);

/** `value` is required except for `is_set` / `is_not_set`, and an array for `in`. */
function checkOperatorValue(
  f: { operator?: PanelFilterOperator; value?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (f.operator === undefined) return;
  const needsValue = f.operator !== 'is_set' && f.operator !== 'is_not_set';
  if (needsValue && f.value === undefined) ctx.addIssue({ code: 'custom', path: ['value'], message: 'A value is required' });
  if (f.operator === 'in' && !Array.isArray(f.value)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Use a list of values' });
  if (f.operator !== 'in' && Array.isArray(f.value)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Only `in` takes a list' });
  if ((f.operator === 'gt' || f.operator === 'lt') && typeof f.value === 'boolean') {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'Use a number or text' });
  }
}

export const panelFilterSchema = z
  .discriminatedUnion('source', [
    /** A standard column of the event (country, path, utm_source...). */
    z.object({ source: z.literal('column'), field: z.enum(PANEL_FILTER_COLUMNS), operator: filterOperator, value: filterValue.optional() }),
    /** A custom property sent with the event (`track('Signed up', { plan: 'pro' })`). */
    z.object({ source: z.literal('event'), key: panelPropertyKeySchema, operator: filterOperator, value: filterValue.optional() }),
    /** A property of the person (`$email`, `plan`), from their latest profile. */
    z.object({ source: z.literal('person'), key: panelPropertyKeySchema, operator: filterOperator, value: filterValue.optional() }),
    /** Membership of a saved cohort. */
    z.object({ source: z.literal('cohort'), cohortId: z.string().min(1).max(30), negate: z.boolean().optional() }),
  ])
  .superRefine((f, ctx) => {
    if (f.source !== 'cohort') checkOperatorValue(f, ctx);
  });
export type PanelFilter = z.infer<typeof panelFilterSchema>;

const filtersSchema = z.array(panelFilterSchema).max(20).default([]);

/** What a breakdown splits by: one property, top N values (the rest are `Other`). */
export const panelBreakdownSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('column'), field: z.enum(PANEL_FILTER_COLUMNS), limit: z.number().int().min(1).max(25).default(10) }),
  z.object({ source: z.literal('event'), key: panelPropertyKeySchema, limit: z.number().int().min(1).max(25).default(10) }),
  z.object({ source: z.literal('person'), key: panelPropertyKeySchema, limit: z.number().int().min(1).max(25).default(10) }),
]);
export type PanelBreakdown = z.infer<typeof panelBreakdownSchema>;

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

const base = {
  projectId: z.string().min(1).max(30),
  dateRange: panelDateRangeSchema.default({ preset: '30d' }),
  timezone: timezoneSchema,
  filters: filtersSchema,
};

export const webSpecSchema = z.object({
  ...base,
  kind: z.literal('web'),
  /** Also run the previous period of the same length for comparison. */
  compare: z.boolean().default(false),
  /** Rows per top list (pages, sources, countries...). */
  limit: z.number().int().min(1).max(50).default(10),
});

export const PANEL_TREND_MATHS = ['total', 'unique_users', 'sessions', 'avg_per_user', 'sum', 'avg', 'min', 'max'] as const;
export type PanelTrendMath = (typeof PANEL_TREND_MATHS)[number];

export const panelTrendSeriesSchema = z
  .object({
    /** The event to count. */
    event: panelEventNameSchema,
    label: z.string().max(100).optional(),
    math: z.enum(PANEL_TREND_MATHS).default('total'),
    /** The event property for `sum`, `avg`, `min` and `max`. */
    property: panelPropertyKeySchema.optional(),
    /** Filters for this series only (on top of the spec's). */
    filters: filtersSchema,
  })
  .refine((s) => !['sum', 'avg', 'min', 'max'].includes(s.math) || s.property !== undefined, {
    path: ['property'],
    message: 'Choose the property to calculate',
  });
export type PanelTrendSeriesSpec = z.infer<typeof panelTrendSeriesSchema>;

/** How a trends report is drawn. */
export const PANEL_TRENDS_DISPLAYS = ['line', 'bar', 'table', 'number'] as const;
export type PanelTrendsDisplay = (typeof PANEL_TRENDS_DISPLAYS)[number];

export const trendsSpecSchema = z.object({
  ...base,
  kind: z.literal('trends'),
  series: z.array(panelTrendSeriesSchema).min(1).max(5),
  interval: z.enum(PANEL_INTERVALS).default('day'),
  breakdown: panelBreakdownSchema.optional(),
  compare: z.boolean().default(false),
  /** Kept with a saved report so it reopens as it was drawn; the compiler ignores it. */
  display: z.enum(PANEL_TRENDS_DISPLAYS).optional(),
});

export const panelFunnelStepSchema = z.object({
  event: panelEventNameSchema,
  label: z.string().max(100).optional(),
  filters: filtersSchema,
});
export type PanelFunnelStep = z.infer<typeof panelFunnelStepSchema>;

export const PANEL_WINDOW_UNITS = ['minute', 'hour', 'day'] as const;

export const funnelSpecSchema = z.object({
  ...base,
  kind: z.literal('funnel'),
  steps: z.array(panelFunnelStepSchema).min(2).max(10),
  /** Time allowed from the first step to the last. */
  window: z
    .object({ value: z.number().int().min(1).max(366), unit: z.enum(PANEL_WINDOW_UNITS) })
    .default({ value: 7, unit: 'day' }),
  /** `loose`: other events may happen between steps. `strict`: each step must be the very next event. */
  order: z.enum(['loose', 'strict']).default('loose'),
  /** The property's value on the first step; one result per top value. */
  breakdown: panelBreakdownSchema.optional(),
});

export const PANEL_RETENTION_INTERVALS = ['day', 'week', 'month'] as const;

export const retentionSpecSchema = z.object({
  ...base,
  kind: z.literal('retention'),
  /** People are placed in the cohort of the period they first did this. */
  firstEvent: panelEventNameSchema,
  /** The event that counts as coming back. Omit for any event. */
  returnEvent: panelEventNameSchema.optional(),
  interval: z.enum(PANEL_RETENTION_INTERVALS).default('week'),
  /** Periods after the first one to show. */
  periods: z.number().int().min(1).max(30).default(8),
});

export const flowsSpecSchema = z.object({
  ...base,
  kind: z.literal('flows'),
  /** The event the paths start from (`after`) or end at (`before`). */
  anchor: panelFunnelStepSchema,
  direction: z.enum(['after', 'before']).default('after'),
  /** Steps shown on the far side of the anchor. */
  depth: z.number().int().min(1).max(5).default(3),
  /** `pageviews` shows pages by path, `custom` leaves out `$` events, `all` shows everything. */
  scope: z.enum(['all', 'pageviews', 'custom']).default('all'),
  limit: z.number().int().min(1).max(50).default(20),
});

export const PANEL_FRUSTRATION_TYPES = ['rage', 'dead', 'quickback', 'excessive_scroll'] as const;
export type PanelFrustrationType = (typeof PANEL_FRUSTRATION_TYPES)[number];

export const PANEL_SESSION_SORTS = ['started_desc', 'duration_desc', 'pages_desc', 'frustration_desc', 'errors_desc'] as const;
export type PanelSessionSort = (typeof PANEL_SESSION_SORTS)[number];

const stringList = z.array(z.string().min(1).max(255)).max(20);

/**
 * The recordings list: sessions of one project with their metrics. Only
 * consented visits have a session id, so cookieless visits are not listed.
 * The same fields (as URL search params) drive `/weldpanel/recordings`
 * (`recordingsSearchSchema`).
 */
export const sessionsSpecSchema = z.object({
  projectId: base.projectId,
  dateRange: base.dateRange,
  timezone: base.timezone,
  kind: z.literal('sessions'),
  minDurationSeconds: z.number().int().min(0).max(86400).optional(),
  maxDurationSeconds: z.number().int().min(0).max(86400).optional(),
  /** The session visited a page whose path contains any of these (all of them must match). */
  pagesVisited: stringList.optional(),
  entryPage: z.string().min(1).max(500).optional(),
  exitPage: z.string().min(1).max(500).optional(),
  countries: stringList.optional(),
  devices: z.array(z.enum(['desktop', 'tablet', 'mobile'])).max(3).optional(),
  browsers: stringList.optional(),
  /** Only these sessions (a detail view, or the sessions an AI summary reads). */
  sessionIds: z.array(z.string().min(1).max(64)).max(100).optional(),
  /** One person: their user id or anonymous id. */
  distinctId: z.string().min(1).max(255).optional(),
  cohortId: z.string().min(1).max(30).optional(),
  /** The session did all of these events. */
  didEvents: z.array(panelEventNameSchema).max(10).optional(),
  /** The session did none of these events. */
  notDidEvents: z.array(panelEventNameSchema).max(10).optional(),
  /** The session has at least one of each of these frustration signals. */
  frustration: z.array(z.enum(PANEL_FRUSTRATION_TYPES)).max(4).optional(),
  hasErrors: z.boolean().optional(),
  favoritesOnly: z.boolean().optional(),
  /** Only sessions that have a recording. */
  hasRecording: z.boolean().optional(),
  sort: z.enum(PANEL_SESSION_SORTS).default('started_desc'),
  limit: z.number().int().min(1).max(100).default(25),
  /** Opaque, from the previous page's `nextCursor`. */
  cursor: z.string().max(40).nullish(),
});

export const PANEL_HEATMAP_TYPES = ['click', 'area', 'scroll'] as const;
export type PanelHeatmapType = (typeof PANEL_HEATMAP_TYPES)[number];
export const PANEL_DEVICE_CLASSES = ['desktop', 'tablet', 'mobile'] as const;
export type PanelDeviceClass = (typeof PANEL_DEVICE_CLASSES)[number];

/** Viewport width at which a device class starts (below `tablet`: mobile, below `desktop`: tablet). */
export const PANEL_DEVICE_CLASS_BREAKPOINTS = { tablet: 768, desktop: 1024 } as const;

export const heatmapSpecSchema = z
  .object({
    projectId: base.projectId,
    dateRange: base.dateRange,
    timezone: base.timezone,
    kind: z.literal('heatmap'),
    type: z.enum(PANEL_HEATMAP_TYPES),
    deviceClass: z.enum(PANEL_DEVICE_CLASSES),
    /** A saved page group (`panel_heatmap_pages`)... */
    pageGroupId: z.string().min(1).max(30).optional(),
    /** ...or an ad-hoc path pattern (`/products/*`). */
    urlPattern: z.string().min(1).max(1000).regex(/^\//, 'Start with /').optional(),
  })
  .refine((s) => s.pageGroupId !== undefined || s.urlPattern !== undefined, {
    path: ['pageGroupId'],
    message: 'Choose a page group or a URL pattern',
  });

export const panelQuerySpecSchema = z.union([
  webSpecSchema,
  trendsSpecSchema,
  funnelSpecSchema,
  retentionSpecSchema,
  flowsSpecSchema,
  sessionsSpecSchema,
  heatmapSpecSchema,
]);

export type PanelWebSpec = z.input<typeof webSpecSchema>;
export type PanelTrendsSpec = z.input<typeof trendsSpecSchema>;
export type PanelFunnelSpec = z.input<typeof funnelSpecSchema>;
export type PanelRetentionSpec = z.input<typeof retentionSpecSchema>;
export type PanelFlowsSpec = z.input<typeof flowsSpecSchema>;
export type PanelSessionsSpec = z.input<typeof sessionsSpecSchema>;
export type PanelHeatmapSpec = z.input<typeof heatmapSpecSchema>;
/** What a client builds; defaults are filled in by the server. */
export type PanelQuerySpec = z.input<typeof panelQuerySpecSchema>;
/** After parsing: every default filled in. */
export type ParsedPanelQuerySpec = z.output<typeof panelQuerySpecSchema>;
export type ParsedWebSpec = z.output<typeof webSpecSchema>;
export type ParsedTrendsSpec = z.output<typeof trendsSpecSchema>;
export type ParsedFunnelSpec = z.output<typeof funnelSpecSchema>;
export type ParsedRetentionSpec = z.output<typeof retentionSpecSchema>;
export type ParsedFlowsSpec = z.output<typeof flowsSpecSchema>;
export type ParsedSessionsSpec = z.output<typeof sessionsSpecSchema>;
export type ParsedHeatmapSpec = z.output<typeof heatmapSpecSchema>;

export type PanelQueryKind = PanelQuerySpec['kind'];
export const PANEL_QUERY_KINDS = ['web', 'trends', 'funnel', 'retention', 'flows', 'sessions', 'heatmap'] as const;

/** The kinds a saved report can hold (`panel_reports.kind`). */
export const PANEL_REPORT_SPEC_KINDS = ['web', 'trends', 'funnel', 'retention', 'flows'] as const;
export const panelReportSpecSchema = z.union([webSpecSchema, trendsSpecSchema, funnelSpecSchema, retentionSpecSchema, flowsSpecSchema]);
export type PanelReportSpec = z.input<typeof panelReportSpecSchema>;

// ---------------------------------------------------------------------------
// Cohort filters
// ---------------------------------------------------------------------------

/**
 * A cohort: a saved filter on people ("signed up in the last 30 days and did
 * not upgrade"), evaluated at query time. `panel_cohorts.filter`.
 */
export const panelCohortConditionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('person_property'),
    key: panelPropertyKeySchema,
    operator: filterOperator,
    value: filterValue.optional(),
  }),
  z.object({
    type: z.literal('performed'),
    event: panelEventNameSchema,
    filters: filtersSchema.refine((fs) => fs.every((f) => f.source !== 'cohort'), { message: 'Cohorts cannot nest' }),
    /** In the last N days. */
    withinDays: z.number().int().min(1).max(762),
    /** At least this many times (default once). */
    minCount: z.number().int().min(1).max(100000).default(1),
    /** True for "did not perform". */
    negate: z.boolean().default(false),
  }),
]);
export type PanelCohortCondition = z.input<typeof panelCohortConditionSchema>;

export const panelCohortFilterSchema = z.object({
  match: z.enum(['all', 'any']).default('all'),
  conditions: z.array(panelCohortConditionSchema).min(1).max(10),
});
export type PanelCohortFilter = z.input<typeof panelCohortFilterSchema>;
export type ParsedPanelCohortFilter = z.output<typeof panelCohortFilterSchema>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** The concrete time range a query ran over, after presets and retention were applied. ISO 8601, UTC. */
export interface PanelResolvedRange {
  from: string;
  to: string;
  timezone: string;
  /** Set when the range was shortened to the plan's event retention. */
  clampedToRetention: boolean;
  previousFrom: string | null;
  previousTo: string | null;
}

export interface PanelTotals {
  visitors: number;
  visits: number;
  pageviews: number;
  /** 0-1: visits with a single pageview and no other event. */
  bounceRate: number;
  avgVisitDurationSeconds: number;
}

export interface PanelBreakdownRow {
  value: string;
  visitors: number;
  /** Pageviews (events of any kind for sources that have none). */
  events: number;
}

export interface PanelEntryExitRow {
  value: string;
  entries: number;
  exits: number;
}

export interface PanelWebResult {
  range: PanelResolvedRange;
  interval: PanelInterval;
  totals: PanelTotals;
  previousTotals: PanelTotals | null;
  series: { bucket: string; visitors: number; pageviews: number }[];
  previousSeries: { bucket: string; visitors: number; pageviews: number }[] | null;
  topPages: PanelBreakdownRow[];
  entryExitPages: PanelEntryExitRow[];
  sources: PanelBreakdownRow[];
  utmSources: PanelBreakdownRow[];
  utmMediums: PanelBreakdownRow[];
  utmCampaigns: PanelBreakdownRow[];
  countries: PanelBreakdownRow[];
  devices: PanelBreakdownRow[];
  browsers: PanelBreakdownRow[];
  operatingSystems: PanelBreakdownRow[];
}

export interface PanelTrendPoint {
  bucket: string;
  value: number;
}

export interface PanelTrendSeriesResult {
  /** Index of the series in the spec. */
  seriesIndex: number;
  label: string;
  /** The breakdown value this line is for; null without a breakdown. `Other` collects the rest. */
  breakdownValue: string | null;
  /** The measure over the whole range (not the sum of the points for unique measures). */
  total: number;
  points: PanelTrendPoint[];
  previous: { total: number; points: PanelTrendPoint[] } | null;
}

export interface PanelTrendsResult {
  range: PanelResolvedRange;
  interval: PanelInterval;
  series: PanelTrendSeriesResult[];
}

export interface PanelFunnelStepResult {
  index: number;
  event: string;
  label: string;
  /** People who reached this step. */
  count: number;
  /** 0-1 of the previous step (1 for the first). */
  conversionFromPrevious: number;
  /** 0-1 of the first step. */
  conversionFromFirst: number;
  /** People lost since the previous step. */
  droppedOff: number;
  /** Average seconds from the previous step; null for the first or when nobody converted. */
  avgSecondsFromPrevious: number | null;
}

export interface PanelFunnelResult {
  range: PanelResolvedRange;
  steps: PanelFunnelStepResult[];
  /** 0-1: last step over first. */
  overallConversion: number;
  /** One funnel per top breakdown value, when the spec has a breakdown. */
  breakdowns: { value: string; steps: PanelFunnelStepResult[]; overallConversion: number }[] | null;
}

export interface PanelRetentionCohort {
  /** The cohort's bucket (first period), `YYYY-MM-DD`. */
  cohort: string;
  /** People whose first event fell in this period. */
  size: number;
  /** `counts[n]`: how many of them came back in period n after the first (0 = the first period). */
  counts: number[];
}

export interface PanelRetentionResult {
  range: PanelResolvedRange;
  interval: (typeof PANEL_RETENTION_INTERVALS)[number];
  periods: number;
  cohorts: PanelRetentionCohort[];
  /** Weighted average share (0-1) retained per period, from all cohorts old enough to have it. */
  averageRetention: number[];
}

export interface PanelFlowPath {
  /** Steps on the far side of the anchor, nearest first (for `before` also nearest first, i.e. reversed in time). A missing next step is `null` (the person left). */
  steps: (string | null)[];
  count: number;
}

export interface PanelFlowsResult {
  range: PanelResolvedRange;
  anchor: string;
  direction: 'after' | 'before';
  depth: number;
  /** Times the anchor happened (path counts add up to this, less the paths cut by `limit`). */
  anchorCount: number;
  paths: PanelFlowPath[];
}

export interface PanelSessionRow {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  pageviews: number;
  clicks: number;
  events: number;
  rageClicks: number;
  deadClicks: number;
  quickBacks: number;
  excessiveScrolls: number;
  errors: number;
  entryPage: string | null;
  exitPage: string | null;
  deviceType: 'desktop' | 'mobile' | 'tablet' | null;
  browser: string | null;
  os: string | null;
  country: string | null;
  /** The person: user id when known, else the anonymous id. */
  distinctId: string;
  userId: string | null;
  /** At least one recording chunk is stored. */
  hasRecording: boolean;
  chunkCount: number;
  /** Set by panel-api from `panel_session_favorites`. */
  favorite: boolean;
}

export interface PanelSessionsResult {
  range: PanelResolvedRange;
  sessions: PanelSessionRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface PanelHeatmapElement {
  selector: string;
  /** Visible text of a recent click on it (masked per the project's masking level). */
  text: string | null;
  clicks: number;
  /** 0-1 of all clicks on the page group. */
  share: number;
  /** Average click position inside the element, 0-1. */
  relX: number;
  relY: number;
}

export interface PanelHeatmapPoint {
  selector: string;
  /** Position inside the element, 0-1, snapped to a 0.1 grid. */
  relX: number;
  relY: number;
  count: number;
}

export interface PanelHeatmapResult {
  range: PanelResolvedRange;
  type: PanelHeatmapType;
  deviceClass: PanelDeviceClass;
  urlPattern: string;
  pageviews: number;
  /** Clicks counted (`click` and `area`). */
  clicks: number;
  /** `area`: one row per element, most clicked first. */
  elements: PanelHeatmapElement[];
  /** `click`: points per element position. */
  points: PanelHeatmapPoint[];
  /** `scroll`: `reachedShare` is the 0-1 share of page leaves that scrolled at least `depth` percent. */
  scroll: { leaves: number; buckets: { depth: number; reachedShare: number }[] };
}

export type PanelQueryResult =
  | { kind: 'web'; result: PanelWebResult }
  | { kind: 'trends'; result: PanelTrendsResult }
  | { kind: 'funnel'; result: PanelFunnelResult }
  | { kind: 'retention'; result: PanelRetentionResult }
  | { kind: 'flows'; result: PanelFlowsResult }
  | { kind: 'sessions'; result: PanelSessionsResult }
  | { kind: 'heatmap'; result: PanelHeatmapResult };

/** `POST /api/panel/query` answers `{ data: PanelQueryResponse }`. */
export type PanelQueryResponse = PanelQueryResult & {
  /** When the data was read from Basin (ISO). Up to two minutes old when cached, and the pipeline is itself one to two minutes behind. */
  dataAsOf: string;
  cached: boolean;
};

export type PanelQueryResultOf<K extends PanelQueryKind> = Extract<PanelQueryResult, { kind: K }>['result'];

// ---------------------------------------------------------------------------
// Cross-page links
// ---------------------------------------------------------------------------

/**
 * `/weldpanel/recordings` search params: the recordings list's filters, kept in
 * the URL so a chart can link to the sessions behind it. Use
 * {@link recordingsSearchToSpec} to run them.
 */
export const recordingsSearchSchema = z.object({
  project: z.string().optional(),
  /** Preset or `custom`. */
  range: z.enum(PANEL_DATE_PRESETS).optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  minDuration: z.number().int().min(0).optional(),
  maxDuration: z.number().int().min(0).optional(),
  pages: stringList.optional(),
  entryPage: z.string().optional(),
  exitPage: z.string().optional(),
  countries: stringList.optional(),
  devices: z.array(z.enum(['desktop', 'tablet', 'mobile'])).optional(),
  browsers: stringList.optional(),
  user: z.string().optional(),
  cohort: z.string().optional(),
  did: z.array(z.string()).optional(),
  didNot: z.array(z.string()).optional(),
  frustration: z.array(z.enum(PANEL_FRUSTRATION_TYPES)).optional(),
  errors: z.boolean().optional(),
  favorites: z.boolean().optional(),
  sort: z.enum(PANEL_SESSION_SORTS).optional(),
  /** The recording open in the player. */
  session: z.string().optional(),
});
export type RecordingsSearch = z.infer<typeof recordingsSearchSchema>;

/** The sessions spec a recordings search stands for. */
export function recordingsSearchToSpec(search: RecordingsSearch, projectId: string): PanelSessionsSpec {
  const dateRange: PanelDateRange =
    search.from && search.to ? { from: search.from, to: search.to } : { preset: search.range ?? '30d' };
  return {
    kind: 'sessions',
    projectId,
    dateRange,
    minDurationSeconds: search.minDuration,
    maxDurationSeconds: search.maxDuration,
    pagesVisited: search.pages,
    entryPage: search.entryPage,
    exitPage: search.exitPage,
    countries: search.countries,
    devices: search.devices,
    browsers: search.browsers,
    distinctId: search.user,
    cohortId: search.cohort,
    didEvents: search.did,
    notDidEvents: search.didNot,
    frustration: search.frustration,
    hasErrors: search.errors,
    favoritesOnly: search.favorites,
    sort: search.sort,
  } as PanelSessionsSpec;
}

/** The recordings search a sessions spec stands for (the reverse of {@link recordingsSearchToSpec}). */
export function sessionsSpecToRecordingsSearch(spec: PanelSessionsSpec, project?: string): RecordingsSearch {
  const range: PanelDateRange = spec.dateRange ?? { preset: '30d' };
  return stripUndefined({
    project,
    range: 'preset' in range ? range.preset : undefined,
    from: 'from' in range ? range.from : undefined,
    to: 'to' in range ? range.to : undefined,
    minDuration: spec.minDurationSeconds,
    maxDuration: spec.maxDurationSeconds,
    pages: spec.pagesVisited,
    entryPage: spec.entryPage,
    exitPage: spec.exitPage,
    countries: spec.countries,
    devices: spec.devices,
    browsers: spec.browsers,
    user: spec.distinctId,
    cohort: spec.cohortId,
    did: spec.didEvents,
    didNot: spec.notDidEvents,
    frustration: spec.frustration,
    errors: spec.hasErrors,
    favorites: spec.favoritesOnly,
    sort: spec.sort,
  });
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

type RangeLike = { dateRange?: PanelDateRange };

function rangeSearch(spec: RangeLike): Pick<RecordingsSearch, 'range' | 'from' | 'to'> {
  const range = spec.dateRange;
  if (!range) return {};
  return 'preset' in range ? { range: range.preset } : { from: range.from, to: range.to };
}

/**
 * "Watch the people who dropped here": sessions that did the previous step's
 * event but not this step's. `stepIndex` is the step people dropped before
 * (1 to steps - 1).
 */
export function funnelDropOffRecordingsSearch(spec: PanelFunnelSpec, stepIndex: number, project?: string): RecordingsSearch {
  const previous = spec.steps[stepIndex - 1];
  const step = spec.steps[stepIndex];
  if (!previous || !step) throw new RangeError(`The funnel has no step ${stepIndex + 1}`);
  return stripUndefined({
    project,
    ...rangeSearch(spec),
    did: [previous.event],
    didNot: [step.event],
  });
}

/** "Watch the people who completed this step". */
export function funnelStepRecordingsSearch(spec: PanelFunnelSpec, stepIndex: number, project?: string): RecordingsSearch {
  const step = spec.steps[stepIndex];
  if (!step) throw new RangeError(`The funnel has no step ${stepIndex + 1}`);
  return stripUndefined({ project, ...rangeSearch(spec), did: [step.event] });
}

/** Recordings with a frustration signal, optionally on one page: the Frustration page's "watch these". */
export function frustrationRecordingsSearch(
  type: PanelFrustrationType | 'errors',
  options: { range?: PanelDateRange; entryPage?: string; pages?: string[]; project?: string } = {},
): RecordingsSearch {
  return stripUndefined({
    project: options.project,
    ...rangeSearch({ dateRange: options.range }),
    pages: options.pages,
    entryPage: options.entryPage,
    ...(type === 'errors' ? { errors: true } : { frustration: [type] }),
    sort: type === 'errors' ? ('errors_desc' as const) : ('frustration_desc' as const),
  });
}

/** A person's recordings: the profile page's "Recordings" tab. */
export function personRecordingsSearch(distinctId: string, project?: string): RecordingsSearch {
  return stripUndefined({ project, user: distinctId, range: '90d' as const });
}
