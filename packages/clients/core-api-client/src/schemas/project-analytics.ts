/**
 * Project analytics Zod schemas — shared between app-api (server) and
 * the platform client. Extracted from the legacy api-worker route.
 */

import { z } from 'zod';

// ============================================================================
// Report schemas
// ============================================================================

export const createReportSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
});

export const updateReportSchema = createReportSchema.partial();

export type CreateReportInput = z.infer<typeof createReportSchema>;
export type UpdateReportInput = z.infer<typeof updateReportSchema>;

export interface AnalyticsReport {
  id: string;
  app: string;
  title: string;
  description: string | null;
  chartCount: number;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

// ============================================================================
// Chart schemas
// ============================================================================

export const chartLayoutSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  minW: z.number().optional(),
  minH: z.number().optional(),
});

export const createChartSchema = z.object({
  reportId: z.string().min(1),
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  chartType: z.string().min(1),
  entity: z.string().min(1),
  metric: z.string().min(1),
  color: z.string().optional().default('#3b82f6'),
  smoothCurve: z.boolean().optional().default(true),
  fillArea: z.boolean().optional().default(true),
  showDataLabels: z.boolean().optional().default(false),
  showLegend: z.boolean().optional().default(true),
  timeRange: z.string().optional().default('last_30_days'),
  groupBy: z.string().optional().default('day'),
  aggregation: z.string().optional().default('sum'),
  sortOrder: z.string().optional().default('asc'),
  limit: z.number().optional(),
  compareWith: z.string().optional(),
  layout: chartLayoutSchema.optional(),
});

export const updateChartSchema = createChartSchema.omit({ reportId: true }).partial();

export const updateChartLayoutsSchema = z.object({
  layouts: z.array(
    z.object({
      chartId: z.string(),
      layout: chartLayoutSchema,
    }),
  ),
});

/**
 * Entities a WeldFlow chart may query (singular + plural spellings). Anything
 * else (helpdesk tickets, CRM leads, ...) belongs to another module's analytics
 * and is rejected, so a project report cannot read another module's data.
 */
export const weldflowChartEntitySchema = z.enum([
  'project',
  'projects',
  'task',
  'tasks',
  'time_entry',
  'time_entries',
  'milestone',
  'milestones',
]);

/** One chart's query inside `POST /reports/:reportId/charts-data`. */
export const chartDataQuerySchema = z.object({
  chartId: z.string().min(1).max(64),
  entity: weldflowChartEntitySchema,
  metric: z.string().regex(/^[a-z_]+$/).max(64),
  timeRange: z.string().max(32).default('last_30_days'),
  groupBy: z.string().max(32).default('day'),
  aggregation: z.string().max(16).default('sum'),
  sortOrder: z.string().max(8).default('asc'),
  /** Integer row cap; it ends up in the SQL, so it is bounded here. */
  limit: z.number().int().min(1).max(1000).nullish(),
  /** Narrow the chart to one project; the caller must be able to access it. */
  projectId: z.string().min(1).max(64).nullish(),
});

export const chartsDataRequestSchema = z.object({
  charts: z.array(chartDataQuerySchema).max(50),
});

export type ChartDataQuery = z.infer<typeof chartDataQuerySchema>;
export type ChartsDataRequest = z.infer<typeof chartsDataRequestSchema>;

export type CreateChartInput = z.infer<typeof createChartSchema>;
export type UpdateChartInput = z.infer<typeof updateChartSchema>;
export type UpdateChartLayoutsInput = z.infer<typeof updateChartLayoutsSchema>;

export interface AnalyticsChart {
  id: string;
  reportId: string;
  app: string;
  title: string;
  description: string | null;
  chartType: string;
  entity: string;
  metric: string;
  color: string | null;
  smoothCurve: boolean | null;
  fillArea: boolean | null;
  showDataLabels: boolean | null;
  showLegend: boolean | null;
  timeRange: string | null;
  groupBy: string | null;
  aggregation: string | null;
  sortOrder: string | null;
  limit: number | null;
  compareWith: string | null;
  layout: Record<string, unknown> | null;
  sortIndex: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

// ============================================================================
// KPI summary schemas
// ============================================================================

export const projectKpiPeriodSchema = z.enum(['7d', '30d', '90d']);
export type ProjectKpiPeriod = z.infer<typeof projectKpiPeriodSchema>;

export const projectKpiSummaryQuerySchema = z.object({
  period: projectKpiPeriodSchema.optional().default('30d'),
  projectId: z.string().min(1).optional(),
});

export type ProjectKpiSummaryQuery = z.infer<typeof projectKpiSummaryQuerySchema>;

export const projectKpiThroughputDaySchema = z.object({
  date: z.string(),
  completed: z.number(),
});

export const projectKpiSummarySchema = z.object({
  activeProjects: z.number(),
  tasksDueToday: z.number(),
  overdueTasks: z.number(),
  totalTasks: z.number(),
  completedTasks: z.number(),
  completionRate: z.number(),
  hoursLoggedMinutes: z.number(),
  billableHoursMinutes: z.number(),
  projectsByStatus: z.record(z.string(), z.number()),
  projectsByHealth: z.record(z.string(), z.number()),
  tasksByPriority: z.record(z.string(), z.number()),
  throughputByDay: z.array(projectKpiThroughputDaySchema),
  period: projectKpiPeriodSchema,
  from: z.string(),
  to: z.string(),
});

export type ProjectKpiSummary = z.infer<typeof projectKpiSummarySchema>;
