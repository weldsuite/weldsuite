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

// ── Scheduled report emails (TASK-1228) ─────────────────────────────────────

/** The periods the overview report (and so a schedule) can cover; the same ids as the report builder's time ranges. */
export const HELPDESK_REPORT_RANGES = [
  'today',
  'yesterday',
  'last_7_days',
  'last_14_days',
  'last_30_days',
  'last_90_days',
  'last_180_days',
  'last_365_days',
  'this_month',
  'this_quarter',
  'this_year',
  'last_year',
  'all_time',
] as const;
export const helpdeskReportRangeSchema = z.enum(HELPDESK_REPORT_RANGES);

export const HELPDESK_REPORT_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export const helpdeskReportFrequencySchema = z.enum(HELPDESK_REPORT_FREQUENCIES);

export const HELPDESK_REPORT_LOCALES = ['en', 'nl'] as const;
export const helpdeskReportLocaleSchema = z.enum(HELPDESK_REPORT_LOCALES);

export const HELPDESK_REPORT_MAX_RECIPIENTS = 20;

/** A `helpdesk_report_schedules` row as the API returns it (timestamps in ISO 8601), plus the saved report's title. */
export const helpdeskReportScheduleSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  name: z.string(),
  /** Saved report to send; null sends the overview. */
  reportId: z.string().nullable(),
  /** Title of the saved report; null for the overview (and for a report that no longer exists). */
  reportTitle: z.string().nullable(),
  range: helpdeskReportRangeSchema,
  frequency: helpdeskReportFrequencySchema,
  /** Weekly: 0 = Sunday … 6 = Saturday. */
  dayOfWeek: z.number().int().nullable(),
  /** Monthly: 1 … 28. */
  dayOfMonth: z.number().int().nullable(),
  /** 0 … 23, read in `timezone`. */
  hour: z.number().int(),
  timezone: z.string(),
  recipients: z.array(z.string()),
  attachCsv: z.boolean(),
  locale: helpdeskReportLocaleSchema,
  enabled: z.boolean(),
  createdById: z.string().nullable(),
  /** Next scheduled send; null while the schedule is disabled. */
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastStatus: z.enum(['sent', 'failed']).nullable(),
  lastError: z.string().nullable(),
});

const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const recipientsSchema = z
  .array(z.string().trim().toLowerCase().email().max(254))
  .min(1)
  .max(HELPDESK_REPORT_MAX_RECIPIENTS)
  .transform((emails) => [...new Set(emails)]);

/** Body of POST /schedules and the fields PATCH /schedules/:id takes. */
const helpdeskReportScheduleFields = z.object({
  name: z.string().trim().min(1).max(255),
  reportId: z.string().min(1).max(30).nullable().optional(),
  range: helpdeskReportRangeSchema.optional(),
  frequency: helpdeskReportFrequencySchema,
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
  hour: z.number().int().min(0).max(23),
  timezone: z.string().min(1).max(64).refine(isTimeZone, 'Not a valid IANA time zone'),
  recipients: recipientsSchema,
  attachCsv: z.boolean().optional(),
  locale: helpdeskReportLocaleSchema.optional(),
  enabled: z.boolean().optional(),
});

/** Weekly needs `dayOfWeek`, monthly needs `dayOfMonth`. */
function timingIsComplete(value: { frequency?: string; dayOfWeek?: number | null; dayOfMonth?: number | null }): boolean {
  if (value.frequency === 'weekly') return value.dayOfWeek !== undefined && value.dayOfWeek !== null;
  if (value.frequency === 'monthly') return value.dayOfMonth !== undefined && value.dayOfMonth !== null;
  return true;
}

export const createHelpdeskReportScheduleSchema = helpdeskReportScheduleFields.refine(timingIsComplete, {
  message: 'dayOfWeek is required for a weekly schedule and dayOfMonth for a monthly one',
});

/** PATCH takes any subset; the stored row is merged in before the timing is checked. */
export const updateHelpdeskReportScheduleSchema = helpdeskReportScheduleFields.partial();

/** POST /schedules/:id/send: how the send-now went. */
export const helpdeskReportScheduleSendResultSchema = z.object({
  status: z.enum(['sent', 'failed']),
  error: z.string().optional(),
});

export type HelpdeskReportScheduleDto = z.infer<typeof helpdeskReportScheduleSchema>;
export type CreateHelpdeskReportScheduleInput = z.input<typeof createHelpdeskReportScheduleSchema>;
export type UpdateHelpdeskReportScheduleInput = z.input<typeof updateHelpdeskReportScheduleSchema>;
