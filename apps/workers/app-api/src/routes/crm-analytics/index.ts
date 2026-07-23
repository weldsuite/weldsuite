/**
 * CRM analytics routes — /api/crm-analytics/* surface for analytics reports
 * and charts (app = 'crm'). Ported from apps/api-worker/src/routes/crm/analytics.ts.
 *
 * APP_NAME filter ('crm') ensures this route only surfaces CRM reports and
 * never leaks e.g. WeldFlow reports sharing the same DB tables.
 *
 * Permissions: contacts:read (all report + chart operations).
 * Backed by `analyticsReports` + `analyticsCharts` tables.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const APP_NAME = 'crm';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// Schemas (inline — analytics schemas are shared via core-api-client for
// project-analytics; CRM uses the same shape so we define inline to avoid
// coupling to a different package version)
// ============================================================================

const createReportSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
});

const updateReportSchema = createReportSchema.partial();

const createChartSchema = z.object({
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
  layout: z
    .object({
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
      minW: z.number().optional(),
      minH: z.number().optional(),
    })
    .optional(),
});

const updateChartSchema = createChartSchema.partial();

const updateChartLayoutsSchema = z.object({
  layouts: z.array(
    z.object({
      chartId: z.string(),
      layout: z.object({
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
        minW: z.number().optional(),
        minH: z.number().optional(),
      }),
    }),
  ),
});

// ============================================================================
// Report Routes
// ============================================================================

app.get('/', requirePermission('contacts:read'), async (c) => {
  const db = c.get('tenantDb');
  const { analyticsReports } = schema;
  try {
    const reports = await db
      .select()
      .from(analyticsReports)
      .where(and(eq(analyticsReports.app, APP_NAME), isNull(analyticsReports.deletedAt)))
      .orderBy(desc(analyticsReports.updatedAt));
    return success(c, reports);
  } catch (err) {
    console.error('[app-api/crm-analytics] list reports failed:', err);
    return error.internal(c, 'Failed to fetch reports');
  }
});

app.get('/:reportId', requirePermission('contacts:read'), async (c) => {
  const db = c.get('tenantDb');
  const { analyticsReports } = schema;
  const reportId = c.req.param('reportId');
  try {
    const [report] = await db
      .select()
      .from(analyticsReports)
      .where(
        and(
          eq(analyticsReports.id, reportId),
          eq(analyticsReports.app, APP_NAME),
          isNull(analyticsReports.deletedAt),
        ),
      )
      .limit(1);
    if (!report) return error.notFound(c, 'Report', reportId);
    return success(c, report);
  } catch (err) {
    console.error('[app-api/crm-analytics] get report failed:', err);
    return error.internal(c, 'Failed to fetch report');
  }
});

app.post('/', requirePermission('contacts:read'), zValidator('json', createReportSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const { analyticsReports } = schema;
  const data = c.req.valid('json');
  const id = generateId('rpt');
  const now = new Date();
  try {
    await db.insert(analyticsReports).values({
      id,
      app: APP_NAME,
      title: data.title,
      description: data.description ?? '',
      createdById: userId,
      chartCount: 0,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof analyticsReports.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'analytics_report',
      entityId: id,
      action: 'created',
      data: { id, app: APP_NAME, title: data.title },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/crm-analytics] create report failed:', err);
    return error.internal(c, 'Failed to create report');
  }
});

app.patch('/:reportId', requirePermission('contacts:read'), zValidator('json', updateReportSchema), async (c) => {
  const db = c.get('tenantDb');
  const { analyticsReports } = schema;
  const reportId = c.req.param('reportId');
  const data = c.req.valid('json');
  try {
    const [existing] = await db
      .select()
      .from(analyticsReports)
      .where(
        and(
          eq(analyticsReports.id, reportId),
          eq(analyticsReports.app, APP_NAME),
          isNull(analyticsReports.deletedAt),
        ),
      )
      .limit(1);
    if (!existing) return error.notFound(c, 'Report', reportId);
    await db
      .update(analyticsReports)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(analyticsReports.id, reportId), eq(analyticsReports.app, APP_NAME)));
    publishEntityEvent({
      c,
      entityType: 'analytics_report',
      entityId: reportId,
      action: 'updated',
      data: { id: reportId },
    });
    return success(c, { id: reportId });
  } catch (err) {
    console.error('[app-api/crm-analytics] update report failed:', err);
    return error.internal(c, 'Failed to update report');
  }
});

app.delete('/:reportId', requirePermission('contacts:read'), async (c) => {
  const db = c.get('tenantDb');
  const { analyticsReports, analyticsCharts } = schema;
  const reportId = c.req.param('reportId');
  const now = new Date();
  try {
    const [existing] = await db
      .select()
      .from(analyticsReports)
      .where(
        and(
          eq(analyticsReports.id, reportId),
          eq(analyticsReports.app, APP_NAME),
          isNull(analyticsReports.deletedAt),
        ),
      )
      .limit(1);
    if (!existing) return error.notFound(c, 'Report', reportId);
    await db
      .update(analyticsCharts)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(analyticsCharts.reportId, reportId), isNull(analyticsCharts.deletedAt)));
    await db
      .update(analyticsReports)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(analyticsReports.id, reportId), eq(analyticsReports.app, APP_NAME)));
    publishEntityEvent({
      c,
      entityType: 'analytics_report',
      entityId: reportId,
      action: 'deleted',
      data: { id: reportId },
    });
    return success(c, { id: reportId });
  } catch (err) {
    console.error('[app-api/crm-analytics] delete report failed:', err);
    return error.internal(c, 'Failed to delete report');
  }
});

app.post('/:reportId/duplicate', requirePermission('contacts:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const { analyticsReports, analyticsCharts } = schema;
  const reportId = c.req.param('reportId');
  try {
    const [original] = await db
      .select()
      .from(analyticsReports)
      .where(
        and(
          eq(analyticsReports.id, reportId),
          eq(analyticsReports.app, APP_NAME),
          isNull(analyticsReports.deletedAt),
        ),
      )
      .limit(1);
    if (!original) return error.notFound(c, 'Report', reportId);
    const newId = generateId('rpt');
    const now = new Date();
    await db.insert(analyticsReports).values({
      id: newId,
      app: APP_NAME,
      title: `${original.title} (Copy)`,
      description: original.description,
      createdById: userId,
      chartCount: original.chartCount,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof analyticsReports.$inferInsert);
    const originalCharts = await db
      .select()
      .from(analyticsCharts)
      .where(and(eq(analyticsCharts.reportId, reportId), isNull(analyticsCharts.deletedAt)));
    if (originalCharts.length > 0) {
      await db.insert(analyticsCharts).values(
        originalCharts.map((chart) => ({
          id: generateId('cht'),
          reportId: newId,
          app: APP_NAME,
          title: chart.title,
          description: chart.description,
          chartType: chart.chartType,
          entity: chart.entity,
          metric: chart.metric,
          color: chart.color,
          smoothCurve: chart.smoothCurve,
          fillArea: chart.fillArea,
          showDataLabels: chart.showDataLabels,
          showLegend: chart.showLegend,
          timeRange: chart.timeRange,
          groupBy: chart.groupBy,
          aggregation: chart.aggregation,
          sortOrder: chart.sortOrder,
          limit: chart.limit,
          compareWith: chart.compareWith,
          layout: chart.layout,
          sortIndex: chart.sortIndex,
          createdAt: now,
          updatedAt: now,
        })) as unknown as typeof analyticsCharts.$inferInsert[],
      );
    }
    return success(c, { id: newId }, 201);
  } catch (err) {
    console.error('[app-api/crm-analytics] duplicate report failed:', err);
    return error.internal(c, 'Failed to duplicate report');
  }
});

// ============================================================================
// Chart Routes
// ============================================================================

app.get('/:reportId/charts', requirePermission('contacts:read'), async (c) => {
  const db = c.get('tenantDb');
  const { analyticsCharts } = schema;
  const reportId = c.req.param('reportId');
  try {
    const charts = await db
      .select()
      .from(analyticsCharts)
      .where(and(eq(analyticsCharts.reportId, reportId), isNull(analyticsCharts.deletedAt)))
      .orderBy(asc(analyticsCharts.sortIndex));
    return success(c, charts);
  } catch (err) {
    console.error('[app-api/crm-analytics] list charts failed:', err);
    return error.internal(c, 'Failed to fetch charts');
  }
});

app.post('/:reportId/charts', requirePermission('contacts:read'), zValidator('json', createChartSchema), async (c) => {
  const db = c.get('tenantDb');
  const { analyticsReports, analyticsCharts } = schema;
  const reportId = c.req.param('reportId');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const existingCharts = await db
      .select()
      .from(analyticsCharts)
      .where(and(eq(analyticsCharts.reportId, reportId), isNull(analyticsCharts.deletedAt)));
    const id = generateId('cht');
    const now = new Date();
    await db.insert(analyticsCharts).values({
      id,
      reportId,
      app: APP_NAME,
      title: data.title as string,
      description: (data.description as string | undefined) ?? null,
      chartType: data.chartType as string,
      entity: data.entity as string,
      metric: data.metric as string,
      color: (data.color as string | undefined) ?? '#3b82f6',
      smoothCurve: (data.smoothCurve as boolean | undefined) ?? true,
      fillArea: (data.fillArea as boolean | undefined) ?? true,
      showDataLabels: (data.showDataLabels as boolean | undefined) ?? false,
      showLegend: (data.showLegend as boolean | undefined) ?? true,
      timeRange: (data.timeRange as string | undefined) ?? 'last_30_days',
      groupBy: (data.groupBy as string | undefined) ?? 'day',
      aggregation: (data.aggregation as string | undefined) ?? 'sum',
      sortOrder: (data.sortOrder as string | undefined) ?? 'asc',
      limit: (data.limit as number | undefined) ?? null,
      compareWith: (data.compareWith as string | undefined) ?? null,
      layout: (data.layout as Record<string, unknown> | undefined) ?? { x: 0, y: 0, w: 6, h: 4 },
      sortIndex: existingCharts.length,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof analyticsCharts.$inferInsert);
    await db
      .update(analyticsReports)
      .set({ chartCount: existingCharts.length + 1, updatedAt: now })
      .where(eq(analyticsReports.id, reportId));
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/crm-analytics] create chart failed:', err);
    return error.internal(c, 'Failed to create chart');
  }
});

app.put('/:reportId/charts/:chartId', requirePermission('contacts:read'), zValidator('json', updateChartSchema), async (c) => {
  const db = c.get('tenantDb');
  const { analyticsCharts } = schema;
  const reportId = c.req.param('reportId');
  const chartId = c.req.param('chartId');
  const data = c.req.valid('json');
  try {
    await db
      .update(analyticsCharts)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(analyticsCharts.id, chartId),
          eq(analyticsCharts.reportId, reportId),
          isNull(analyticsCharts.deletedAt),
        ),
      );
    return success(c, { id: chartId });
  } catch (err) {
    console.error('[app-api/crm-analytics] update chart failed:', err);
    return error.internal(c, 'Failed to update chart');
  }
});

app.patch('/:reportId/charts/layouts', requirePermission('contacts:read'), zValidator('json', updateChartLayoutsSchema), async (c) => {
  const db = c.get('tenantDb');
  const { analyticsCharts } = schema;
  const reportId = c.req.param('reportId');
  const { layouts } = c.req.valid('json');
  const now = new Date();
  try {
    for (const update of layouts) {
      await db
        .update(analyticsCharts)
        .set({ layout: update.layout, updatedAt: now })
        .where(
          and(
            eq(analyticsCharts.id, update.chartId),
            eq(analyticsCharts.reportId, reportId),
            isNull(analyticsCharts.deletedAt),
          ),
        );
    }
    return success(c, { updated: layouts.length });
  } catch (err) {
    console.error('[app-api/crm-analytics] update chart layouts failed:', err);
    return error.internal(c, 'Failed to update chart layouts');
  }
});

app.delete('/:reportId/charts/:chartId', requirePermission('contacts:read'), async (c) => {
  const db = c.get('tenantDb');
  const { analyticsReports, analyticsCharts } = schema;
  const reportId = c.req.param('reportId');
  const chartId = c.req.param('chartId');
  const now = new Date();
  try {
    await db
      .update(analyticsCharts)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(analyticsCharts.id, chartId),
          eq(analyticsCharts.reportId, reportId),
          isNull(analyticsCharts.deletedAt),
        ),
      );
    const remaining = await db
      .select()
      .from(analyticsCharts)
      .where(and(eq(analyticsCharts.reportId, reportId), isNull(analyticsCharts.deletedAt)));
    await db
      .update(analyticsReports)
      .set({ chartCount: remaining.length, updatedAt: now })
      .where(eq(analyticsReports.id, reportId));
    return success(c, { id: chartId });
  } catch (err) {
    console.error('[app-api/crm-analytics] delete chart failed:', err);
    return error.internal(c, 'Failed to delete chart');
  }
});

app.post('/:reportId/charts/:chartId/duplicate', requirePermission('contacts:read'), async (c) => {
  const db = c.get('tenantDb');
  const { analyticsReports, analyticsCharts } = schema;
  const reportId = c.req.param('reportId');
  const chartId = c.req.param('chartId');
  try {
    const [original] = await db
      .select()
      .from(analyticsCharts)
      .where(
        and(
          eq(analyticsCharts.id, chartId),
          eq(analyticsCharts.reportId, reportId),
          isNull(analyticsCharts.deletedAt),
        ),
      )
      .limit(1);
    if (!original) return error.notFound(c, 'Chart', chartId);
    const existingCharts = await db
      .select()
      .from(analyticsCharts)
      .where(and(eq(analyticsCharts.reportId, reportId), isNull(analyticsCharts.deletedAt)));
    const newId = generateId('cht');
    const now = new Date();
    const newLayout = (original.layout as unknown as Record<string, number> | null) ?? { x: 0, y: 0, w: 6, h: 4 };
    await db.insert(analyticsCharts).values({
      id: newId,
      reportId,
      app: APP_NAME,
      title: `${original.title} (Copy)`,
      description: original.description,
      chartType: original.chartType,
      entity: original.entity,
      metric: original.metric,
      color: original.color,
      smoothCurve: original.smoothCurve,
      fillArea: original.fillArea,
      showDataLabels: original.showDataLabels,
      showLegend: original.showLegend,
      timeRange: original.timeRange,
      groupBy: original.groupBy,
      aggregation: original.aggregation,
      sortOrder: original.sortOrder,
      limit: original.limit,
      compareWith: original.compareWith,
      layout: { ...newLayout, y: (newLayout.y ?? 0) + (newLayout.h ?? 4) },
      sortIndex: existingCharts.length,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof analyticsCharts.$inferInsert);
    await db
      .update(analyticsReports)
      .set({ chartCount: existingCharts.length + 1, updatedAt: now })
      .where(eq(analyticsReports.id, reportId));
    return success(c, { id: newId }, 201);
  } catch (err) {
    console.error('[app-api/crm-analytics] duplicate chart failed:', err);
    return error.internal(c, 'Failed to duplicate chart');
  }
});

// ============================================================================
// Chart Data — POST /api/crm-analytics/chart-data
// ============================================================================

app.post('/chart-data', requirePermission('contacts:read'), async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const chartConfigs = (body?.charts ?? []) as Array<{
    chartId: string;
    entity: string;
    metric: string;
    timeRange: string;
    groupBy: string;
    aggregation: string;
    sortOrder?: string;
    limit?: number;
  }>;
  try {
    const { queryAnalytics } = await import('../../services/analytics-query');
    const workspaceId = c.get('workspaceId') as string;
    const entries = await Promise.all(
      chartConfigs.map(async (config) => {
        const data = await queryAnalytics(c.env, workspaceId, config);
        return [config.chartId, data] as const;
      }),
    );
    const data: Record<string, Array<{ label: string; value: number; date?: string }>> =
      Object.fromEntries(entries);
    return success(c, data);
  } catch (err) {
    console.error('[app-api/crm-analytics] chart-data failed:', err);
    return error.internal(c, 'Failed to get charts data');
  }
});

export const crmAnalyticsRoutes = app;
