/**
 * WeldPanel analysis endpoints that run queries on top of a spec (panel-api):
 *
 *   POST /api/panel/insights/explain          → PanelExplainResult   (root cause of a move)
 *   POST /api/panel/metric-tree-values        → PanelMetricTreeValues (inline nodes)
 *   POST /api/panel/metric-tree-values/:id    → PanelMetricTreeValues (a saved tree)
 *
 * All need `panel_reports:read`. The specs are the query specs of
 * `weldpanel-query.ts`; metric tree nodes are `weldpanel-collab.ts`'s.
 */

import { z } from 'zod';
import {
  panelBreakdownSchema,
  panelDateRangeSchema,
  trendsSpecSchema,
  type PanelResolvedRange,
  type PanelTrendPoint,
} from './weldpanel-query';
import { panelMetricTreeNodesSchema, type PanelMetricTreeRelation } from './weldpanel-collab';

const projectId = z.string().min(1).max(30);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const bucket = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:00)?$/, 'Use a bucket label (YYYY-MM-DD or YYYY-MM-DDTHH:00)');

// ---------------------------------------------------------------------------
// Root cause (explain)
// ---------------------------------------------------------------------------

/** The standard dimensions every explanation looks at. `path` is cleaned by the path rules. */
export const PANEL_EXPLAIN_DIMENSIONS = ['country', 'device_type', 'browser', 'os', 'referrer_host', 'utm_source', 'path'] as const;
export type PanelExplainDimension = (typeof PANEL_EXPLAIN_DIMENSIONS)[number];

/** Maths whose parts add up (or nearly, for distinct counts) to the whole, so a change can be split by value. */
export const PANEL_EXPLAINABLE_MATHS = ['total', 'unique_users', 'unique_groups', 'sessions', 'sum'] as const;

/**
 * What moved and when. The spec is a trends spec with one series (its
 * breakdowns and formulas are ignored). `bucket`: that bucket of the spec's
 * interval against the one before; `period`: those days against as many
 * days before; neither: the spec's range against the period before it.
 */
export const explainPanelChangeSchema = z
  .object({
    projectId,
    spec: trendsSpecSchema,
    bucket: bucket.optional(),
    period: z.object({ from: ymd, to: ymd }).refine((p) => p.from <= p.to, { message: '`from` must not be after `to`' }).optional(),
    /** Up to three event or person properties to look at besides the standard dimensions. */
    properties: z
      .array(panelBreakdownSchema)
      .max(3)
      .refine((list) => list.every((b) => b.source === 'event' || b.source === 'person'), { message: 'Use event or person properties' })
      .default([]),
    /** Values per dimension, the biggest contributors first. */
    limit: z.number().int().min(1).max(10).default(5),
    /** Also write a short explanation with AI (charged; cached for a day). */
    narrate: z.boolean().default(false),
    regenerate: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    if (input.spec.projectId !== input.projectId) ctx.addIssue({ code: 'custom', path: ['spec', 'projectId'], message: 'The spec names another project' });
    if (input.spec.series.length !== 1) ctx.addIssue({ code: 'custom', path: ['spec', 'series'], message: 'Explain one series at a time' });
    const math = input.spec.series[0]?.math;
    if (math && !(PANEL_EXPLAINABLE_MATHS as readonly string[]).includes(math)) {
      ctx.addIssue({ code: 'custom', path: ['spec', 'series', 0, 'math'], message: 'Root cause works on counts and sums' });
    }
    if (input.bucket && input.period) ctx.addIssue({ code: 'custom', path: ['period'], message: 'Choose a bucket or a period, not both' });
  });
export type ExplainPanelChangeInput = z.input<typeof explainPanelChangeSchema>;
export type ParsedExplainPanelChangeInput = z.output<typeof explainPanelChangeSchema>;

export interface PanelExplainWindow {
  /** ISO 8601, UTC; `to` is exclusive. */
  from: string;
  to: string;
}

export interface PanelExplainValue {
  value: string;
  current: number;
  baseline: number;
  change: number;
  /** Null when the baseline is 0. */
  changePercent: number | null;
  /** Share of the whole change this value accounts for (can be above 1 or negative when others moved the other way). */
  contributionShare: number;
}

export interface PanelExplainDimensionResult {
  /** `country`, ..., or `event:<key>` / `person:<key>` for the asked properties. */
  dimension: string;
  /** The values that explain the move best, in the direction of the move first. */
  values: PanelExplainValue[];
  /** 0-1: how much of the move the top values account for, to rank the dimensions. */
  explained: number;
}

export interface PanelExplainNarrative {
  text: string;
  modelId: string;
  creditsCharged: number;
  cached: boolean;
}

export interface PanelExplainResult {
  current: PanelExplainWindow;
  baseline: PanelExplainWindow;
  metric: { label: string; current: number; baseline: number; change: number; changePercent: number | null };
  /** Best explaining dimension first. */
  dimensions: PanelExplainDimensionResult[];
  narrative: PanelExplainNarrative | null;
  /** Why there is no narrative although one was asked for. */
  narrativeUnavailable?: 'ai_disabled' | 'insufficient_credits' | 'ai_unavailable';
  dataAsOf: string;
}

// ---------------------------------------------------------------------------
// Metric tree values
// ---------------------------------------------------------------------------

/** The period the values are for (the previous period of the same length is the comparison). Default: last 30 days. */
const valuesPeriod = {
  dateRange: panelDateRangeSchema.optional(),
  timezone: z.string().min(1).max(64).optional(),
};

/** `POST /metric-tree-values`: values for nodes that are not saved (the editor's preview). */
export const panelMetricTreeValuesSchema = z.object({
  projectId,
  nodes: panelMetricTreeNodesSchema,
  ...valuesPeriod,
});
export type PanelMetricTreeValuesInput = z.input<typeof panelMetricTreeValuesSchema>;

/** `POST /metric-tree-values/:id`: values for a saved tree. */
export const panelSavedMetricTreeValuesSchema = z.object(valuesPeriod);
export type PanelSavedMetricTreeValuesInput = z.input<typeof panelSavedMetricTreeValuesSchema>;

export interface PanelMetricTreeNodeValue {
  id: string;
  label: string;
  parentId: string | null;
  relation: PanelMetricTreeRelation | null;
  /** The node's series over the period and over the period before. Null when it could not run (`error`). */
  value: number | null;
  previous: number | null;
  /** (value − previous) / previous; null when previous is 0. */
  changePercent: number | null;
  /** For `influence` nodes: Pearson correlation of the daily values with the parent's (-1 to 1). */
  correlationWithParent: number | null;
  /** Daily values over the period. */
  points: PanelTrendPoint[];
  /** `report_not_found`, `not_a_trends_report`, `query_failed` or the compiler's message. */
  error: string | null;
}

export interface PanelMetricTreeValues {
  range: PanelResolvedRange | null;
  nodes: PanelMetricTreeNodeValue[];
  dataAsOf: string;
}
