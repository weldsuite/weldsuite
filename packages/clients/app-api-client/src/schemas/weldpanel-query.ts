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
/** `$`-prefixed names the SDKs and collector send themselves (`$pageview`, `$rageclick`, `$webvitals`, `$app_opened`, ...). */
export const PANEL_SYSTEM_EVENT_NAME = /^\$[a-z][a-z_]{1,31}$/;

export const PANEL_PAGEVIEW = '$pageview';
/** One per page view with the Core Web Vitals the page reported (`$lcp`, `$inp`, `$cls`, `$fcp`, `$ttfb`). */
export const PANEL_WEBVITALS = '$webvitals';

/**
 * A custom event (`panel_custom_events`) in a spec: `@` and its id. Wherever a
 * report spec takes an event, it may name one; the compiler expands it to
 * `((e.name = 'A' AND …filters) OR (e.name = 'B' AND …))`.
 */
export const PANEL_CUSTOM_EVENT_REF = /^@pnce_[A-Za-z0-9]{1,26}$/;
/**
 * A computed property (`panel_computed_properties`): `@` and its id. Wherever
 * a spec takes an **event** property key (filters, breakdowns, the math
 * property), it may name one.
 */
export const PANEL_COMPUTED_PROPERTY_REF = /^@pncp_[A-Za-z0-9]{1,26}$/;
/** A group type (`company`, `workspace`): events carry the group's key as the `$group_<type>` property. */
export const PANEL_GROUP_TYPE = /^[a-z][a-z0-9_]{0,31}$/;

export function isCustomEventRef(value: string): boolean {
  return PANEL_CUSTOM_EVENT_REF.test(value);
}

export function isComputedPropertyRef(value: string): boolean {
  return PANEL_COMPUTED_PROPERTY_REF.test(value);
}

/** `@pnce_abc` → `pnce_abc` (the row id). */
export function refId(ref: string): string {
  return ref.startsWith('@') ? ref.slice(1) : ref;
}

/** The event property that holds an event's group key: `$group_<type>`. */
export function groupKeyProperty(groupType: string): string {
  return `$group_${groupType}`;
}

/** An event name in a spec: a custom event, or one of the `$` system events. */
export const panelEventNameSchema = z
  .string()
  .max(100)
  .refine((v) => PANEL_CUSTOM_EVENT_NAME.test(v) || PANEL_SYSTEM_EVENT_NAME.test(v), {
    message: 'Not a valid event name',
  });

/** An event in a report spec: an event name, or a custom event (`@pnce_…`). */
export const panelEventRefSchema = z
  .string()
  .max(100)
  .refine((v) => PANEL_CUSTOM_EVENT_NAME.test(v) || PANEL_SYSTEM_EVENT_NAME.test(v) || PANEL_CUSTOM_EVENT_REF.test(v), {
    message: 'Not a valid event name',
  });

/** A property key: a custom key, or a `$`-prefixed system one (`$email`, `$name`, `$action`). */
export const panelPropertyKeySchema = z
  .string()
  .max(65)
  .refine((v) => PANEL_PROPERTY_KEY.test(v.startsWith('$') ? v.slice(1) : v), {
    message: 'Not a valid property key',
  });

/** An event property in a spec: a property key, or a computed property (`@pncp_…`). */
export const panelEventPropertyRefSchema = z
  .string()
  .max(65)
  .refine((v) => PANEL_PROPERTY_KEY.test(v.startsWith('$') ? v.slice(1) : v) || PANEL_COMPUTED_PROPERTY_REF.test(v), {
    message: 'Not a valid property key',
  });

export const panelGroupTypeSchema = z.string().regex(PANEL_GROUP_TYPE, 'Use lower-case letters, digits and _');

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
    /** A custom property sent with the event (`track('Signed up', { plan: 'pro' })`), or a computed property (`@pncp_…`). */
    z.object({ source: z.literal('event'), key: panelEventPropertyRefSchema, operator: filterOperator, value: filterValue.optional() }),
    /** A property of the person (`$email`, `plan`), from their latest profile. */
    z.object({ source: z.literal('person'), key: panelPropertyKeySchema, operator: filterOperator, value: filterValue.optional() }),
    /** Membership of a saved cohort. */
    z.object({ source: z.literal('cohort'), cohortId: z.string().min(1).max(30), negate: z.boolean().optional() }),
    /** A property of the event's group (`plan` of the company in `$group_company`), from the group's latest profile. */
    z.object({
      source: z.literal('group'),
      groupType: panelGroupTypeSchema,
      key: panelPropertyKeySchema,
      operator: filterOperator,
      value: filterValue.optional(),
    }),
    /** The event's group key itself (`$group_company = 'acme'`): the same as an `event` filter on `$group_<type>`. */
    z.object({ source: z.literal('group_key'), groupType: panelGroupTypeSchema, operator: filterOperator, value: filterValue.optional() }),
  ])
  .superRefine((f, ctx) => {
    if (f.source !== 'cohort') checkOperatorValue(f, ctx);
  });
export type PanelFilter = z.infer<typeof panelFilterSchema>;

const filtersSchema = z.array(panelFilterSchema).max(20).default([]);

/**
 * Numeric bucketing of a breakdown: `auto` splits the range of values seen
 * into `count` (default 5) equal parts; `custom` cuts at the given edges
 * (`[10, 50]` → `< 10`, `10 – 50`, `≥ 50`).
 */
export const panelBreakdownBucketSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('auto'), count: z.number().int().min(2).max(20).optional() }),
  z.object({
    kind: z.literal('custom'),
    edges: z
      .array(z.number().finite().min(-1e12).max(1e12))
      .min(1)
      .max(19)
      .refine((edges) => edges.every((v, i) => i === 0 || v > (edges[i - 1] as number)), { message: 'List the edges from low to high' }),
  }),
]);
export type PanelBreakdownBucket = z.infer<typeof panelBreakdownBucketSchema>;

const breakdownLimit = z.number().int().min(1).max(25).default(10);

/** What a breakdown splits by: one property, top N values (the rest are `Other`), or numeric buckets. */
export const panelBreakdownSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('column'), field: z.enum(PANEL_FILTER_COLUMNS), limit: breakdownLimit }),
  z.object({ source: z.literal('event'), key: panelEventPropertyRefSchema, limit: breakdownLimit, bucket: panelBreakdownBucketSchema.optional() }),
  z.object({ source: z.literal('person'), key: panelPropertyKeySchema, limit: breakdownLimit, bucket: panelBreakdownBucketSchema.optional() }),
  z.object({
    source: z.literal('group'),
    groupType: panelGroupTypeSchema,
    key: panelPropertyKeySchema,
    limit: breakdownLimit,
    bucket: panelBreakdownBucketSchema.optional(),
  }),
]);
export type PanelBreakdown = z.infer<typeof panelBreakdownSchema>;

/** At most this many breakdowns at once; their values are joined with {@link PANEL_BREAKDOWN_JOINER}. */
export const PANEL_MAX_BREAKDOWNS = 3;
export const PANEL_BREAKDOWN_JOINER = ' / ';
const breakdownsSchema = z.array(panelBreakdownSchema).min(1).max(PANEL_MAX_BREAKDOWNS).optional();

/** The breakdowns of a spec: `breakdowns`, else `[breakdown]`, else none. */
export function specBreakdowns(spec: { breakdown?: PanelBreakdown; breakdowns?: PanelBreakdown[] }): PanelBreakdown[] {
  if (spec.breakdowns && spec.breakdowns.length > 0) return spec.breakdowns;
  return spec.breakdown ? [spec.breakdown] : [];
}

/**
 * Who a measure counts: people (default), or groups of one type (companies:
 * the `$group_<type>` key of each event; events without one are left out).
 */
export const panelAggregateBySchema = z.union([z.literal('person'), z.object({ groupType: panelGroupTypeSchema })]);
export type PanelAggregateBy = z.infer<typeof panelAggregateBySchema>;

/** The group type an `aggregateBy` names; null for people. */
export function aggregateGroupType(aggregateBy: PanelAggregateBy | undefined): string | null {
  return aggregateBy && aggregateBy !== 'person' ? aggregateBy.groupType : null;
}

function checkBreakdownPair(spec: { breakdown?: unknown; breakdowns?: unknown[] }, ctx: z.RefinementCtx): void {
  if (spec.breakdown !== undefined && spec.breakdowns !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['breakdowns'], message: 'Use `breakdowns` or `breakdown`, not both' });
  }
}

/** Formulas: letters, digits, operators, parentheses and spaces; `@weldsuite/panel-domain/expression` parses them. */
const FORMULA_TEXT = /^[A-Za-z0-9 .+\-*/()−×÷]+$/;

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

const base = {
  projectId: z.string().min(1).max(30),
  dateRange: panelDateRangeSchema.default({ preset: '30d' }),
  timezone: timezoneSchema,
  filters: filtersSchema,
};

/**
 * Apply the project's path rules (`panel_path_rules`, `/users/123` →
 * `/users/:id`) wherever the report groups or shows pages by path. Omitted
 * means yes.
 */
const cleanPathsSchema = z.boolean().optional();

/** Panels of the web overview; each is one statement (one table scan). */
export const PANEL_WEB_PANELS = [
  'topPages',
  'entryExitPages',
  'sources',
  'channels',
  'utmSources',
  'utmMediums',
  'utmCampaigns',
  'countries',
  'regions',
  'cities',
  'devices',
  'browsers',
  'operatingSystems',
  'hostnames',
  'screenSizes',
] as const;
export type PanelWebPanel = (typeof PANEL_WEB_PANELS)[number];

/** What an overview without `panels` computes: the original lists plus channels. Host names, regions, cities and screen sizes are asked for. */
export const PANEL_WEB_DEFAULT_PANELS: readonly PanelWebPanel[] = [
  'topPages',
  'entryExitPages',
  'sources',
  'channels',
  'utmSources',
  'utmMediums',
  'utmCampaigns',
  'countries',
  'devices',
  'browsers',
  'operatingSystems',
];

/** A conversion goal of the web overview: an event (or custom event), or a page view whose path matches `pathPattern` (`*` is a wildcard). */
export const panelWebGoalSchema = z
  .object({
    label: z.string().min(1).max(100),
    event: panelEventRefSchema.optional(),
    pathPattern: z.string().min(1).max(500).regex(/^\//, 'Start with /').optional(),
    filters: filtersSchema,
  })
  .refine((g) => (g.event === undefined) !== (g.pathPattern === undefined), {
    path: ['event'],
    message: 'Choose an event or a page',
  });
export type PanelWebGoal = z.input<typeof panelWebGoalSchema>;

export const webSpecSchema = z.object({
  ...base,
  kind: z.literal('web'),
  /** Also run the previous period of the same length for comparison. */
  compare: z.boolean().default(false),
  /** Rows per top list (pages, sources, countries...). */
  limit: z.number().int().min(1).max(50).default(10),
  /** Which lists to compute; omit for {@link PANEL_WEB_DEFAULT_PANELS}. The totals and the series are always there. */
  panels: z.array(z.enum(PANEL_WEB_PANELS)).max(PANEL_WEB_PANELS.length).optional(),
  /** Conversions, unique converters and conversion rate per goal. */
  goals: z.array(panelWebGoalSchema).max(5).optional(),
  cleanPaths: cleanPathsSchema,
});

export const PANEL_TREND_MATHS = ['total', 'unique_users', 'unique_groups', 'sessions', 'avg_per_user', 'sum', 'avg', 'min', 'max'] as const;
export type PanelTrendMath = (typeof PANEL_TREND_MATHS)[number];

export const panelTrendSeriesSchema = z
  .object({
    /** The event to count: an event name or a custom event (`@pnce_…`). */
    event: panelEventRefSchema,
    label: z.string().max(100).optional(),
    math: z.enum(PANEL_TREND_MATHS).default('total'),
    /** The event property (or computed property) for `sum`, `avg`, `min` and `max`. */
    property: panelEventPropertyRefSchema.optional(),
    /** The group type `unique_groups` counts. */
    groupType: panelGroupTypeSchema.optional(),
    /** Filters for this series only (on top of the spec's). */
    filters: filtersSchema,
  })
  .refine((s) => !['sum', 'avg', 'min', 'max'].includes(s.math) || s.property !== undefined, {
    path: ['property'],
    message: 'Choose the property to calculate',
  })
  .refine((s) => s.math !== 'unique_groups' || s.groupType !== undefined, {
    path: ['groupType'],
    message: 'Choose the group type to count',
  });
export type PanelTrendSeriesSpec = z.infer<typeof panelTrendSeriesSchema>;

/**
 * A formula over the series: letters `A`–`E` are the series by index
 * (`A / B * 100`). Division by zero gives no value. Parsed by
 * `@weldsuite/panel-domain/expression`; the compiler refuses one that does not parse.
 */
export const panelTrendFormulaSchema = z.object({
  expression: z.string().min(1).max(500).regex(FORMULA_TEXT, 'Use the letters A to E, numbers, + - * / and parentheses'),
  label: z.string().max(100).optional(),
});
export type PanelTrendFormula = z.infer<typeof panelTrendFormulaSchema>;

/**
 * How a trends report is drawn. `area` is stacked, `pie` shows the totals,
 * `cumulative` shows running totals (distinct-so-far for unique counts).
 */
export const PANEL_TRENDS_DISPLAYS = ['line', 'bar', 'table', 'number', 'area', 'pie', 'cumulative'] as const;
export type PanelTrendsDisplay = (typeof PANEL_TRENDS_DISPLAYS)[number];

export const trendsSpecSchema = z
  .object({
    ...base,
    kind: z.literal('trends'),
    series: z.array(panelTrendSeriesSchema).min(1).max(5),
    interval: z.enum(PANEL_INTERVALS).default('day'),
    breakdown: panelBreakdownSchema.optional(),
    /** Up to three breakdowns; their values are joined with ` / `. `breakdown` stays and means `[breakdown]`. */
    breakdowns: breakdownsSchema,
    compare: z.boolean().default(false),
    /** Kept with a saved report so it reopens as it was drawn. Only `cumulative` changes what the compiler returns. */
    display: z.enum(PANEL_TRENDS_DISPLAYS).optional(),
    /** Lines computed from the series (`A / B * 100`). */
    formulas: z.array(panelTrendFormulaSchema).max(3).optional(),
    /** Show the formulas only: the result's `series` is empty. */
    formulaOnly: z.boolean().optional(),
    cleanPaths: cleanPathsSchema,
  })
  .superRefine((spec, ctx) => {
    checkBreakdownPair(spec, ctx);
    if (spec.formulaOnly && !(spec.formulas && spec.formulas.length > 0)) {
      ctx.addIssue({ code: 'custom', path: ['formulaOnly'], message: 'Add a formula first' });
    }
  });

export const panelFunnelStepSchema = z.object({
  /** An event name or a custom event (`@pnce_…`). */
  event: panelEventRefSchema,
  label: z.string().max(100).optional(),
  filters: filtersSchema,
  /** The step may be skipped (never the first or the last). Ignored by flows and `any` order. */
  optional: z.boolean().optional(),
});
export type PanelFunnelStep = z.infer<typeof panelFunnelStepSchema>;

export const PANEL_WINDOW_UNITS = ['minute', 'hour', 'day'] as const;

/** People who do `event` after step `fromStep` and before step `toStep` (0-based) are left out of the funnel. */
export const panelFunnelExclusionSchema = z
  .object({
    event: panelEventRefSchema,
    filters: filtersSchema,
    fromStep: z.number().int().min(0).max(8),
    toStep: z.number().int().min(1).max(9),
  })
  .refine((x) => x.fromStep < x.toStep, { path: ['toStep'], message: 'The end step must come after the start step' });
export type PanelFunnelExclusion = z.infer<typeof panelFunnelExclusionSchema>;

/** `steps`: conversion per step. `trends`: conversion rate per entry `interval`. `time_to_convert`: how long people take. */
export const PANEL_FUNNEL_DISPLAYS = ['steps', 'trends', 'time_to_convert'] as const;
export type PanelFunnelDisplay = (typeof PANEL_FUNNEL_DISPLAYS)[number];

/** `any`: the steps may happen in any order within the window. */
export const PANEL_FUNNEL_ORDERS = ['loose', 'strict', 'any'] as const;

const funnelFields = {
  ...base,
  steps: z.array(panelFunnelStepSchema).min(2).max(10),
  /** Time allowed from the first step to the last. */
  window: z
    .object({ value: z.number().int().min(1).max(366), unit: z.enum(PANEL_WINDOW_UNITS) })
    .default({ value: 7, unit: 'day' }),
  /** `loose`: other events may happen between steps. `strict`: each step must be the very next event. `any`: any order. */
  order: z.enum(PANEL_FUNNEL_ORDERS).default('loose'),
  /** The property's value on the first step; one result per top value. */
  breakdown: panelBreakdownSchema.optional(),
  breakdowns: breakdownsSchema,
  /** Up to five events that remove a person from the funnel when done between two steps. */
  exclusions: z.array(panelFunnelExclusionSchema).max(5).optional(),
  /** A property that must keep the value it had on the first step (the same product, the same plan). */
  holdConstant: panelBreakdownSchema.optional(),
  /** Count people (default) or groups. */
  aggregateBy: panelAggregateBySchema.optional(),
  display: z.enum(PANEL_FUNNEL_DISPLAYS).optional(),
  /** The bucket of the `trends` display (by the time people entered). */
  interval: z.enum(PANEL_INTERVALS).optional(),
  cleanPaths: cleanPathsSchema,
};

function refineFunnel(
  spec: { steps: { optional?: boolean }[]; exclusions?: { toStep: number }[]; order?: string; breakdown?: unknown; breakdowns?: unknown[] },
  ctx: z.RefinementCtx,
): void {
  checkBreakdownPair(spec, ctx);
  const last = spec.steps.length - 1;
  spec.steps.forEach((step, i) => {
    if (step.optional && (i === 0 || i === last)) {
      ctx.addIssue({ code: 'custom', path: ['steps', i, 'optional'], message: 'The first and the last step cannot be optional' });
    }
  });
  (spec.exclusions ?? []).forEach((x, i) => {
    if (x.toStep > last) ctx.addIssue({ code: 'custom', path: ['exclusions', i, 'toStep'], message: 'The funnel has no such step' });
  });
  if (spec.order === 'any' && (spec.exclusions?.length ?? 0) > 0) {
    ctx.addIssue({ code: 'custom', path: ['exclusions'], message: 'Exclusions need the steps in order' });
  }
}

export const funnelSpecSchema = z.object({ ...funnelFields, kind: z.literal('funnel') }).superRefine(refineFunnel);

/**
 * What sets converters apart from people who dropped: the events they did
 * (between entering and converting or the window's end) and the column values
 * of their first step (`country`, `device_type`, `browser`, `os`,
 * `utm_source`, `referrer_host`). Not saveable as a report.
 */
export const funnelCorrelationSpecSchema = z
  .object({
    ...funnelFields,
    kind: z.literal('funnel_correlation'),
    /** Rows per list (events, properties), the strongest first. */
    limit: z.number().int().min(1).max(50).default(10),
  })
  .superRefine(refineFunnel);

export const PANEL_RETENTION_INTERVALS = ['day', 'week', 'month'] as const;
/** `first_time`: the cohort is the period someone first did the event (ever, as far back as the plan keeps data). `recurring`: every period they did it starts a cohort. */
export const PANEL_RETENTION_MODES = ['first_time', 'recurring'] as const;

export const retentionSpecSchema = z.object({
  ...base,
  kind: z.literal('retention'),
  /** People are placed in the cohort of the period they first did this (in the range, unless `mode` says otherwise). */
  firstEvent: panelEventRefSchema,
  /** The event that counts as coming back. Omit for any event. */
  returnEvent: panelEventRefSchema.optional(),
  interval: z.enum(PANEL_RETENTION_INTERVALS).default('week'),
  /** Periods after the first one to show. */
  periods: z.number().int().min(1).max(30).default(8),
  /** One table per top value of this property on the first event. */
  breakdown: panelBreakdownSchema.optional(),
  /** Omitted: the first time in the range (as before). */
  mode: z.enum(PANEL_RETENTION_MODES).optional(),
  /** Count someone in period N when they came back in period N **or later**. */
  unbounded: z.boolean().optional(),
  aggregateBy: panelAggregateBySchema.optional(),
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
  cleanPaths: cleanPathsSchema,
});

/**
 * Stickiness (Mixpanel's Frequency): how often the people (or groups) who did
 * the event do it. `intervals`: how many days (or weeks) of the range they
 * were active; `count`: how many times they did it, in buckets.
 */
export const stickinessSpecSchema = z.object({
  ...base,
  kind: z.literal('stickiness'),
  event: panelEventRefSchema,
  interval: z.enum(['day', 'week']).default('day'),
  measure: z.enum(['intervals', 'count']).default('intervals'),
  aggregateBy: panelAggregateBySchema.optional(),
});

/**
 * Lifecycle: per bucket, who did the event for the first time (`new`), again
 * after the previous bucket (`returning`), again after a gap
 * (`resurrecting`), and who did it in the previous bucket but not this one
 * (`dormant`).
 */
export const lifecycleSpecSchema = z.object({
  ...base,
  kind: z.literal('lifecycle'),
  event: panelEventRefSchema,
  interval: z.enum(['day', 'week', 'month']).default('day'),
  aggregateBy: panelAggregateBySchema.optional(),
});

export const PANEL_VITALS_METRICS = ['lcp', 'inp', 'cls', 'fcp', 'ttfb'] as const;
export type PanelVitalsMetric = (typeof PANEL_VITALS_METRICS)[number];
export const PANEL_VITALS_PERCENTILES = ['p75', 'p90', 'p95', 'p99'] as const;
export type PanelVitalsPercentile = (typeof PANEL_VITALS_PERCENTILES)[number];

/**
 * Google's Core Web Vitals thresholds: up to `good` is good, above `poor` is
 * poor, in between needs improvement. Milliseconds, CLS unitless.
 */
export const PANEL_VITALS_THRESHOLDS: Record<PanelVitalsMetric, { good: number; poor: number }> = {
  lcp: { good: 2500, poor: 4000 },
  inp: { good: 200, poor: 500 },
  cls: { good: 0.1, poor: 0.25 },
  fcp: { good: 1800, poor: 3000 },
  ttfb: { good: 800, poor: 1800 },
};

/** Web vitals from `$webvitals` events: a percentile over time and by page, element, country and device. */
export const vitalsSpecSchema = z.object({
  ...base,
  kind: z.literal('vitals'),
  metric: z.enum(PANEL_VITALS_METRICS).default('lcp'),
  percentile: z.enum(PANEL_VITALS_PERCENTILES).default('p75'),
  interval: z.enum(PANEL_INTERVALS).default('day'),
  /** Rows per list (pages, elements, countries). */
  limit: z.number().int().min(1).max(50).default(10),
  cleanPaths: cleanPathsSchema,
});

export const PANEL_IMPACT_MATHS = ['total', 'unique_users', 'sum', 'avg'] as const;

/**
 * Impact: did launching a feature move a metric? People who did the launch
 * event on or after `launchDate` (adopters) against everyone else active,
 * `windowDays` before against `windowDays` after the launch, and the
 * difference in differences. The range is the two windows around `launchDate`;
 * `dateRange` is accepted like on every report kind (dashboard filters set it)
 * but does not move the windows.
 */
export const impactSpecSchema = z
  .object({
    ...base,
    kind: z.literal('impact'),
    launchEvent: panelEventRefSchema,
    /** The day the feature launched, in the spec's timezone. */
    launchDate: ymd,
    metric: z.object({
      event: panelEventRefSchema,
      /** `total`: events per person; `unique_users`: share of people who did it; `sum`/`avg`: of `property` per person / per event. */
      math: z.enum(PANEL_IMPACT_MATHS).default('total'),
      property: panelEventPropertyRefSchema.optional(),
      filters: filtersSchema,
    }),
    windowDays: z.number().int().min(1).max(90).default(28),
  })
  .refine((s) => !['sum', 'avg'].includes(s.metric.math) || s.metric.property !== undefined, {
    path: ['metric', 'property'],
    message: 'Choose the property to calculate',
  });

/**
 * Signal: which events, done in the first `windowDays` after someone shows
 * up in the range, go with reaching the goal: goal rate with and without,
 * lift and correlation. `candidates` or the `topN` most common events.
 */
export const signalSpecSchema = z.object({
  ...base,
  kind: z.literal('signal'),
  goal: z.object({ event: panelEventRefSchema, filters: filtersSchema }),
  candidates: z.array(panelEventRefSchema).min(1).max(20).optional(),
  topN: z.number().int().min(1).max(20).default(10),
  windowDays: z.number().int().min(1).max(90).default(7),
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
  didEvents: z.array(panelEventRefSchema).max(10).optional(),
  /** The session did none of these events. */
  notDidEvents: z.array(panelEventRefSchema).max(10).optional(),
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
  funnelCorrelationSpecSchema,
  stickinessSpecSchema,
  lifecycleSpecSchema,
  vitalsSpecSchema,
  impactSpecSchema,
  signalSpecSchema,
]);

export type PanelWebSpec = z.input<typeof webSpecSchema>;
export type PanelTrendsSpec = z.input<typeof trendsSpecSchema>;
export type PanelFunnelSpec = z.input<typeof funnelSpecSchema>;
export type PanelRetentionSpec = z.input<typeof retentionSpecSchema>;
export type PanelFlowsSpec = z.input<typeof flowsSpecSchema>;
export type PanelSessionsSpec = z.input<typeof sessionsSpecSchema>;
export type PanelHeatmapSpec = z.input<typeof heatmapSpecSchema>;
export type PanelFunnelCorrelationSpec = z.input<typeof funnelCorrelationSpecSchema>;
export type PanelStickinessSpec = z.input<typeof stickinessSpecSchema>;
export type PanelLifecycleSpec = z.input<typeof lifecycleSpecSchema>;
export type PanelVitalsSpec = z.input<typeof vitalsSpecSchema>;
export type PanelImpactSpec = z.input<typeof impactSpecSchema>;
export type PanelSignalSpec = z.input<typeof signalSpecSchema>;
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
export type ParsedFunnelCorrelationSpec = z.output<typeof funnelCorrelationSpecSchema>;
export type ParsedStickinessSpec = z.output<typeof stickinessSpecSchema>;
export type ParsedLifecycleSpec = z.output<typeof lifecycleSpecSchema>;
export type ParsedVitalsSpec = z.output<typeof vitalsSpecSchema>;
export type ParsedImpactSpec = z.output<typeof impactSpecSchema>;
export type ParsedSignalSpec = z.output<typeof signalSpecSchema>;

export type PanelQueryKind = PanelQuerySpec['kind'];
export const PANEL_QUERY_KINDS = [
  'web',
  'trends',
  'funnel',
  'retention',
  'flows',
  'sessions',
  'heatmap',
  'funnel_correlation',
  'stickiness',
  'lifecycle',
  'vitals',
  'impact',
  'signal',
] as const;

/**
 * The kinds a saved report can hold (`panel_reports.kind`, kept in step with
 * `PANEL_REPORT_KINDS` in the DB schema). `funnel_correlation` is a drill-down
 * of a funnel, `sessions` and `heatmap` have pages of their own.
 */
export const PANEL_REPORT_SPEC_KINDS = ['web', 'trends', 'funnel', 'retention', 'flows', 'stickiness', 'lifecycle', 'vitals', 'impact', 'signal'] as const;
export type PanelReportSpecKind = (typeof PANEL_REPORT_SPEC_KINDS)[number];
export const panelReportSpecSchema = z.union([
  webSpecSchema,
  trendsSpecSchema,
  funnelSpecSchema,
  retentionSpecSchema,
  flowsSpecSchema,
  stickinessSpecSchema,
  lifecycleSpecSchema,
  vitalsSpecSchema,
  impactSpecSchema,
  signalSpecSchema,
]);
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
// Path rules as the compiler reads them
// ---------------------------------------------------------------------------

/** A path rule as the compiler reads it (`panel_path_rules`, ordered by position). */
export interface PanelPathRule {
  /** A regular expression on the path (no look-around, no back-references: the engine's regex dialect). */
  pattern: string;
  replacement: string;
}

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
  /** Host names the pages were served from. */
  hostnames?: PanelBreakdownRow[];
  /** `NL / Noord-Holland`: country code and region. */
  regions?: PanelBreakdownRow[];
  /** `NL / Amsterdam`: country code and city. */
  cities?: PanelBreakdownRow[];
  /** Channel types (`Direct`, `Organic Search`, ...; {@link PANEL_CHANNELS}) from the referrer and `utm_medium`. */
  channels?: PanelBreakdownRow[];
  /** Viewport width classes ({@link PANEL_SCREEN_SIZES}). */
  screenSizes?: PanelBreakdownRow[];
  /** One row per goal of the spec, in its order. */
  goals?: PanelWebGoalResult[];
}

/** Channel types of the web overview, in the order they are checked. */
export const PANEL_CHANNELS = [
  'Paid Search',
  'Paid Social',
  'Display',
  'Affiliate',
  'Email',
  'Video',
  'Organic Search',
  'Organic Social',
  'Direct',
  'Referral',
  'Other',
] as const;
export type PanelChannel = (typeof PANEL_CHANNELS)[number];

/** Viewport width classes (CSS px): mobile < 768 ≤ tablet < 1024 ≤ laptop < 1440 ≤ desktop < 1920 ≤ wide. */
export const PANEL_SCREEN_SIZES = ['mobile', 'tablet', 'laptop', 'desktop', 'wide', '(unknown)'] as const;
export type PanelScreenSize = (typeof PANEL_SCREEN_SIZES)[number];

export interface PanelWebGoalResult {
  label: string;
  /** Times the goal was reached. */
  conversions: number;
  /** Visitors who reached it at least once. */
  uniqueConverters: number;
  /** 0-1: unique converters over visitors. */
  conversionRate: number;
}

export interface PanelTrendPoint {
  bucket: string;
  value: number;
}

export interface PanelTrendSeriesResult {
  /** Index of the series in the spec. */
  seriesIndex: number;
  label: string;
  /** The breakdown value this line is for (values of several breakdowns joined with ` / `); null without a breakdown. `Other` collects the rest. */
  breakdownValue: string | null;
  /** The value of each breakdown, in the spec's order; null without a breakdown and for `Other`. */
  breakdownParts?: string[] | null;
  /** The measure over the whole range (not the sum of the points for unique measures). */
  total: number;
  points: PanelTrendPoint[];
  previous: { total: number; points: PanelTrendPoint[] } | null;
}

/** A formula's point: null where it divides by zero or a series has no value. */
export interface PanelFormulaPoint {
  bucket: string;
  value: number | null;
}

export interface PanelTrendFormulaResult {
  /** Index of the formula in the spec. */
  formulaIndex: number;
  label: string;
  expression: string;
  breakdownValue: string | null;
  breakdownParts?: string[] | null;
  /** The formula over the series' totals. */
  total: number | null;
  points: PanelFormulaPoint[];
  previous: { total: number | null; points: PanelFormulaPoint[] } | null;
}

export interface PanelTrendsResult {
  range: PanelResolvedRange;
  interval: PanelInterval;
  /** Empty when the spec asks for the formulas only. */
  series: PanelTrendSeriesResult[];
  /** One line per formula (and breakdown value), when the spec has formulas. */
  formulas?: PanelTrendFormulaResult[];
  /** True when the points are running totals (`display: 'cumulative'`). */
  cumulative?: boolean;
}

export interface PanelFunnelStepResult {
  index: number;
  event: string;
  label: string;
  /** People who reached this step. */
  count: number;
  /** 0-1 of the previous step (1 for the first). After an optional step: of the last required step before it. */
  conversionFromPrevious: number;
  /** 0-1 of the first step. */
  conversionFromFirst: number;
  /** People lost since the previous step. */
  droppedOff: number;
  /** Average seconds from the previous step; null for the first or when nobody converted. */
  avgSecondsFromPrevious: number | null;
  /** The step may be skipped. */
  optional?: boolean;
}

/** Bucket of a time-to-convert histogram: `[fromSeconds, toSeconds)`; `toSeconds` null for the last. */
export interface PanelTimeHistogramBucket {
  fromSeconds: number;
  toSeconds: number | null;
  count: number;
}

export interface PanelTimeToConvertStats {
  /** People (or groups) the numbers are over. */
  count: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  avgSeconds: number | null;
  histogram: PanelTimeHistogramBucket[];
}

export interface PanelFunnelTimeToConvert {
  /** From the first step to the last. */
  overall: PanelTimeToConvertStats;
  /** From the previous step to this one, for steps 2 to N (`index` is the step's). */
  steps: (PanelTimeToConvertStats & { index: number })[];
}

export interface PanelFunnelTrendPoint {
  /** When people entered the funnel (their first step). */
  bucket: string;
  entered: number;
  converted: number;
  /** 0-1. */
  conversion: number;
}

export interface PanelFunnelResult {
  range: PanelResolvedRange;
  steps: PanelFunnelStepResult[];
  /** 0-1: last step over first. */
  overallConversion: number;
  /** One funnel per top breakdown value, when the spec has a breakdown. */
  breakdowns: { value: string; parts?: string[] | null; steps: PanelFunnelStepResult[]; overallConversion: number }[] | null;
  /** With `display: 'time_to_convert'`. */
  timeToConvert?: PanelFunnelTimeToConvert | null;
  /** With `display: 'trends'`: conversion of the people who entered in each bucket. */
  trend?: PanelFunnelTrendPoint[] | null;
  /** The interval of `trend`. */
  interval?: PanelInterval;
}

export interface PanelCorrelationRow {
  /** `event`: an event the person did; `property`: a column value of their first step. */
  type: 'event' | 'property';
  /** The column for a `property` row (`country`, `browser`, ...); null for events. */
  property: string | null;
  value: string;
  /** Converters with it / people who dropped with it. */
  successCount: number;
  failureCount: number;
  /** 0-1: conversion of the people with it, and of everyone else. */
  successRateWith: number;
  successRateWithout: number;
  /** Odds of converting with it over without (add-one smoothed). */
  oddsRatio: number;
  correlation: 'positive' | 'negative';
}

export interface PanelFunnelCorrelationResult {
  range: PanelResolvedRange;
  /** People (or groups) who converted and who dropped. */
  converted: number;
  dropped: number;
  /** Strongest first: up to `limit` positive and `limit` negative each. */
  events: PanelCorrelationRow[];
  properties: PanelCorrelationRow[];
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
  mode?: (typeof PANEL_RETENTION_MODES)[number] | null;
  /** `counts[n]` counts people who came back in period n or later. */
  unbounded?: boolean;
  /** One table per top value of the breakdown (on the first event). */
  breakdowns?: { value: string; cohorts: PanelRetentionCohort[]; averageRetention: number[] }[] | null;
}

export interface PanelStickinessBucket {
  /** `3` (intervals active), or `6–10` (times done). */
  label: string;
  from: number;
  /** Inclusive; null for the open last bucket. */
  to: number | null;
  /** People (or groups) in the bucket. */
  count: number;
  /** 0-1 of everyone who did the event. */
  share: number;
}

export interface PanelStickinessResult {
  range: PanelResolvedRange;
  interval: 'day' | 'week';
  measure: 'intervals' | 'count';
  /** People (or groups) who did the event at least once. */
  total: number;
  /** Intervals in the range: the most anyone can be active for `intervals`. */
  intervalsInRange: number;
  buckets: PanelStickinessBucket[];
}

export interface PanelLifecycleBucket {
  bucket: string;
  new: number;
  returning: number;
  resurrecting: number;
  /** Active in the previous bucket, not in this one (a positive count; charts draw it below zero). */
  dormant: number;
}

export interface PanelLifecycleResult {
  range: PanelResolvedRange;
  interval: 'day' | 'week' | 'month';
  buckets: PanelLifecycleBucket[];
  totals: { new: number; returning: number; resurrecting: number; dormant: number };
}

export type PanelVitalsRating = 'good' | 'needs_improvement' | 'poor';

export interface PanelVitalsRow {
  value: string;
  /** The percentile of the metric for this row; null without samples. */
  metric: number | null;
  samples: number;
  rating: PanelVitalsRating | null;
}

export interface PanelVitalsResult {
  range: PanelResolvedRange;
  interval: PanelInterval;
  metric: PanelVitalsMetric;
  percentile: PanelVitalsPercentile;
  /** `ms`, or `unitless` for CLS. */
  unit: 'ms' | 'unitless';
  thresholds: { good: number; poor: number };
  /** The percentile over the range. */
  value: number | null;
  rating: PanelVitalsRating | null;
  samples: number;
  /** 0-1 of the samples, by Google's thresholds. */
  shares: { good: number; needsImprovement: number; poor: number };
  /** 0-100, Lighthouse's log-normal scoring of `value`. */
  score: number | null;
  series: { bucket: string; value: number | null; samples: number }[];
  /** By page path (cleaned by the path rules). */
  paths: PanelVitalsRow[];
  /** By the element behind the metric (LCP, INP and CLS only; empty for the others). */
  elements: PanelVitalsRow[];
  countries: PanelVitalsRow[];
  /** `desktop`, `tablet`, `mobile`. */
  devices: PanelVitalsRow[];
}

export interface PanelImpactGroup {
  /** People in the group, active in either window. */
  users: number;
  /** The metric per person (or the share for `unique_users`) before and after the launch. */
  before: number | null;
  after: number | null;
  /** after − before. */
  change: number | null;
}

export interface PanelImpactResult {
  range: PanelResolvedRange;
  launchDate: string;
  windowDays: number;
  /** Per day after the launch: new adopters, adopters so far and their share of active people. */
  adoption: { bucket: string; newAdopters: number; adopters: number; rate: number }[];
  adopters: PanelImpactGroup;
  nonAdopters: PanelImpactGroup;
  /** (adopters after − before) − (non-adopters after − before). */
  differenceInDifferences: number | null;
  /** The difference in differences as a share of the adopters' value before. */
  relativeImpact: number | null;
}

export interface PanelSignalCandidate {
  /** The event or custom event ref, as in the spec. */
  event: string;
  /** People who did it in their first `windowDays`, and their goal rate (0-1). */
  didUsers: number;
  didGoalRate: number;
  didNotUsers: number;
  didNotGoalRate: number;
  /** Goal rate with over without; null when nobody without reached the goal. */
  lift: number | null;
  /** Phi coefficient, -1 to 1; null when it cannot be computed. */
  correlation: number | null;
}

export interface PanelSignalResult {
  range: PanelResolvedRange;
  goal: string;
  windowDays: number;
  /** People active in the range, and how many of them reached the goal. */
  users: number;
  goalUsers: number;
  goalRate: number;
  /** Strongest correlation first. */
  candidates: PanelSignalCandidate[];
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
  | { kind: 'heatmap'; result: PanelHeatmapResult }
  | { kind: 'funnel_correlation'; result: PanelFunnelCorrelationResult }
  | { kind: 'stickiness'; result: PanelStickinessResult }
  | { kind: 'lifecycle'; result: PanelLifecycleResult }
  | { kind: 'vitals'; result: PanelVitalsResult }
  | { kind: 'impact'; result: PanelImpactResult }
  | { kind: 'signal'; result: PanelSignalResult };

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
