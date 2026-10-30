import { z } from 'zod';

/**
 * Response shapes of /api/helpdesk-analytics (desk-api): helpdesk reports,
 * their charts, and chart data.
 */

/** A `helpdesk_analytics_reports` row. */
export const helpdeskAnalyticsReportSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    title: z.string(),
    description: z.string().nullable(),
    createdById: z.string().nullable(),
    chartCount: z.number(),
  })
  .passthrough();

export const helpdeskAnalyticsChartLayoutSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    minW: z.number().optional(),
    minH: z.number().optional(),
  })
  .passthrough();

/** A `helpdesk_analytics_charts` row. */
export const helpdeskAnalyticsChartSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    reportId: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    chartType: z.string(),
    entity: z.string(),
    metric: z.string(),
    color: z.string(),
    smoothCurve: z.boolean(),
    fillArea: z.boolean(),
    showDataLabels: z.boolean(),
    showLegend: z.boolean(),
    timeRange: z.string().nullable(),
    groupBy: z.string().nullable(),
    aggregation: z.string().nullable(),
    sortOrder: z.string().nullable(),
    limit: z.number().nullable(),
    compareWith: z.string().nullable(),
    layout: helpdeskAnalyticsChartLayoutSchema,
    sortIndex: z.number(),
  })
  .passthrough();

/** PATCH /reports/:reportId/layouts: how many layouts the body carried. */
export const helpdeskAnalyticsLayoutsUpdatedSchema = z.object({ updated: z.number() });

/** One point of a chart's series. */
export const helpdeskAnalyticsDataPointSchema = z.object({
  label: z.string(),
  value: z.number(),
  date: z.string().optional(),
});

/** POST /charts/batch-data: each chart's series by chart id. */
export const helpdeskAnalyticsBatchDataSchema = z.record(z.array(helpdeskAnalyticsDataPointSchema));
