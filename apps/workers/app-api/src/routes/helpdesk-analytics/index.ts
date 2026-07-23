/**
 * Helpdesk analytics routes — /api/helpdesk-analytics/* surface.
 * Backed by `helpdeskAnalyticsReports` + `helpdeskAnalyticsCharts` tables
 * (distinct from crm-analytics which uses the generic `analyticsReports` table).
 *
 * Permissions: settings:read | settings:create | settings:update | settings:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import type { ChartLayout } from '@weldsuite/db/schema/helpdesk-analytics-charts';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// Schemas (inline — analytics is read-only for external consumers)
// ============================================================================

const createReportSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
});

const updateReportSchema = createReportSchema.partial();

const createChartSchema = z.object({
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

const updateChartSchema = createChartSchema.partial().omit({ reportId: true });

const chartDataSchema = z.object({
  entity: z.string().min(1),
  metric: z.string().min(1),
  timeRange: z.string().min(1),
  groupBy: z.string().min(1),
  aggregation: z.string().min(1),
  sortOrder: z.string().optional(),
  limit: z.number().optional(),
});

// ============================================================================
// Report Routes
// ============================================================================

app.get('/', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskAnalyticsReports } = schema;
  try {
    const reports = await db
      .select()
      .from(helpdeskAnalyticsReports)
      .where(isNull(helpdeskAnalyticsReports.deletedAt))
      .orderBy(desc(helpdeskAnalyticsReports.updatedAt));
    return success(c, reports);
  } catch (err) {
    console.error('[app-api/helpdesk-analytics] list reports failed:', err);
    return error.internal(c, 'Failed to fetch analytics reports');
  }
});

app.get('/reports/:reportId', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskAnalyticsReports } = schema;
  const reportId = c.req.param('reportId');
  try {
    const [report] = await db
      .select()
      .from(helpdeskAnalyticsReports)
      .where(and(eq(helpdeskAnalyticsReports.id, reportId), isNull(helpdeskAnalyticsReports.deletedAt)))
      .limit(1);
    if (!report) return error.notFound(c, 'Report', reportId);
    return success(c, report);
  } catch (err) {
    console.error('[app-api/helpdesk-analytics] get report failed:', err);
    return error.internal(c, 'Failed to fetch analytics report');
  }
});

app.post('/', requirePermission('settings:create'), zValidator('json', createReportSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const { helpdeskAnalyticsReports } = schema;
  const data = c.req.valid('json');
  const id = generateId('rpt');
  const now = new Date();
  try {
    await db.insert(helpdeskAnalyticsReports).values({
      id,
      title: data.title,
      description: data.description ?? null,
      chartCount: 0,
      createdById: userId,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof helpdeskAnalyticsReports.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'helpdesk_analytics_report',
      entityId: id,
      action: 'created',
      data: { id, title: data.title },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/helpdesk-analytics] create report failed:', err);
    return error.internal(c, 'Failed to create analytics report');
  }
});

app.patch('/:id', requirePermission('settings:update'), zValidator('json', updateReportSchema), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskAnalyticsReports } = schema;
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const [existing] = await db
      .select()
      .from(helpdeskAnalyticsReports)
      .where(and(eq(helpdeskAnalyticsReports.id, id), isNull(helpdeskAnalyticsReports.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Report', id);
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (data.title !== undefined) update.title = data.title;
    if (data.description !== undefined) update.description = data.description;
    await db
      .update(helpdeskAnalyticsReports)
      .set(update)
      .where(and(eq(helpdeskAnalyticsReports.id, id), isNull(helpdeskAnalyticsReports.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'helpdesk_analytics_report',
      entityId: id,
      action: 'updated',
      data: { id },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/helpdesk-analytics] update report failed:', err);
    return error.internal(c, 'Failed to update analytics report');
  }
});

app.delete('/:id', requirePermission('settings:delete'), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskAnalyticsReports, helpdeskAnalyticsCharts } = schema;
  const id = c.req.param('id');
  const now = new Date();
  try {
    const [existing] = await db
      .select()
      .from(helpdeskAnalyticsReports)
      .where(and(eq(helpdeskAnalyticsReports.id, id), isNull(helpdeskAnalyticsReports.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Report', id);
    await db
      .update(helpdeskAnalyticsCharts)
      .set({ deletedAt: now })
      .where(eq(helpdeskAnalyticsCharts.reportId, id));
    await db
      .update(helpdeskAnalyticsReports)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(helpdeskAnalyticsReports.id, id));
    publishEntityEvent({
      c,
      entityType: 'helpdesk_analytics_report',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/helpdesk-analytics] delete report failed:', err);
    return error.internal(c, 'Failed to delete analytics report');
  }
});

app.post('/reports/:reportId/duplicate', requirePermission('settings:create'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const { helpdeskAnalyticsReports, helpdeskAnalyticsCharts } = schema;
  const reportId = c.req.param('reportId');
  try {
    const [original] = await db
      .select()
      .from(helpdeskAnalyticsReports)
      .where(and(eq(helpdeskAnalyticsReports.id, reportId), isNull(helpdeskAnalyticsReports.deletedAt)))
      .limit(1);
    if (!original) return error.notFound(c, 'Report', reportId);
    const newId = generateId('rpt');
    const now = new Date();
    await db.insert(helpdeskAnalyticsReports).values({
      id: newId,
      title: `${original.title} (Copy)`,
      description: original.description,
      chartCount: 0,
      createdById: userId,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof helpdeskAnalyticsReports.$inferInsert);
    const charts = await db
      .select()
      .from(helpdeskAnalyticsCharts)
      .where(and(eq(helpdeskAnalyticsCharts.reportId, reportId), isNull(helpdeskAnalyticsCharts.deletedAt)));
    if (charts.length > 0) {
      await db.insert(helpdeskAnalyticsCharts).values(
        charts.map((ch) => ({
          id: generateId('cht'),
          reportId: newId,
          title: ch.title,
          description: ch.description,
          chartType: ch.chartType,
          entity: ch.entity,
          metric: ch.metric,
          color: ch.color,
          smoothCurve: ch.smoothCurve,
          fillArea: ch.fillArea,
          showDataLabels: ch.showDataLabels,
          showLegend: ch.showLegend,
          timeRange: ch.timeRange,
          groupBy: ch.groupBy,
          aggregation: ch.aggregation,
          sortOrder: ch.sortOrder,
          limit: ch.limit,
          compareWith: ch.compareWith,
          layout: ch.layout,
          sortIndex: ch.sortIndex,
          createdAt: now,
          updatedAt: now,
        })) as unknown as typeof helpdeskAnalyticsCharts.$inferInsert[],
      );
      await db
        .update(helpdeskAnalyticsReports)
        .set({ chartCount: charts.length, updatedAt: now })
        .where(eq(helpdeskAnalyticsReports.id, newId));
    }
    return success(c, { id: newId }, 201);
  } catch (err) {
    console.error('[app-api/helpdesk-analytics] duplicate report failed:', err);
    return error.internal(c, 'Failed to duplicate analytics report');
  }
});

// ============================================================================
// Chart Routes
// ============================================================================

app.get('/reports/:reportId/charts', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskAnalyticsCharts } = schema;
  const reportId = c.req.param('reportId');
  try {
    const charts = await db
      .select()
      .from(helpdeskAnalyticsCharts)
      .where(and(eq(helpdeskAnalyticsCharts.reportId, reportId), isNull(helpdeskAnalyticsCharts.deletedAt)))
      .orderBy(asc(helpdeskAnalyticsCharts.sortIndex));
    return success(c, charts);
  } catch (err) {
    console.error('[app-api/helpdesk-analytics] list charts failed:', err);
    return error.internal(c, 'Failed to fetch charts');
  }
});

app.post('/charts', requirePermission('settings:create'), zValidator('json', createChartSchema), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskAnalyticsReports, helpdeskAnalyticsCharts } = schema;
  const data = c.req.valid('json') as Record<string, unknown>;
  try {
    const maxSortResult = await db
      .select({ maxSort: sql<number>`COALESCE(MAX(sort_index), -1)::int` })
      .from(helpdeskAnalyticsCharts)
      .where(and(eq(helpdeskAnalyticsCharts.reportId, data.reportId as string), isNull(helpdeskAnalyticsCharts.deletedAt)));
    const nextSortIndex = (maxSortResult[0]?.maxSort ?? -1) + 1;
    const id = generateId('cht');
    const now = new Date();
    await db.insert(helpdeskAnalyticsCharts).values({
      id,
      reportId: data.reportId as string,
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
      layout: (data.layout as Record<string, unknown> | undefined) ?? { x: 0, y: nextSortIndex * 4, w: 6, h: 4 },
      sortIndex: nextSortIndex,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof helpdeskAnalyticsCharts.$inferInsert);
    await db
      .update(helpdeskAnalyticsReports)
      .set({ chartCount: sql`chart_count + 1`, updatedAt: now })
      .where(eq(helpdeskAnalyticsReports.id, data.reportId as string));
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/helpdesk-analytics] create chart failed:', err);
    return error.internal(c, 'Failed to create chart');
  }
});

app.get('/charts/:chartId', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskAnalyticsCharts } = schema;
  const chartId = c.req.param('chartId');
  try {
    const [chart] = await db
      .select()
      .from(helpdeskAnalyticsCharts)
      .where(and(eq(helpdeskAnalyticsCharts.id, chartId), isNull(helpdeskAnalyticsCharts.deletedAt)))
      .limit(1);
    if (!chart) return error.notFound(c, 'Chart', chartId);
    return success(c, chart);
  } catch (err) {
    console.error('[app-api/helpdesk-analytics] get chart failed:', err);
    return error.internal(c, 'Failed to fetch chart');
  }
});

app.put('/charts/:chartId', requirePermission('settings:update'), zValidator('json', updateChartSchema), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskAnalyticsCharts } = schema;
  const chartId = c.req.param('chartId');
  const data = c.req.valid('json');
  try {
    await db
      .update(helpdeskAnalyticsCharts)
      .set({ ...(data as Record<string, unknown>), updatedAt: new Date() })
      .where(and(eq(helpdeskAnalyticsCharts.id, chartId), isNull(helpdeskAnalyticsCharts.deletedAt)));
    return success(c, { id: chartId });
  } catch (err) {
    console.error('[app-api/helpdesk-analytics] update chart failed:', err);
    return error.internal(c, 'Failed to update chart');
  }
});

app.patch('/reports/:reportId/layouts', requirePermission('settings:update'), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskAnalyticsCharts } = schema;
  const reportId = c.req.param('reportId');
  const body = await c.req.json().catch(() => ({ layouts: [] })) as { layouts: Array<{ chartId: string; layout: Record<string, unknown> }> };
  const now = new Date();
  try {
    for (const item of body.layouts) {
      await db
        .update(helpdeskAnalyticsCharts)
        .set({ layout: item.layout as unknown as ChartLayout, updatedAt: now })
        .where(and(eq(helpdeskAnalyticsCharts.id, item.chartId), eq(helpdeskAnalyticsCharts.reportId, reportId)));
    }
    return success(c, { updated: body.layouts.length });
  } catch (err) {
    console.error('[app-api/helpdesk-analytics] update layouts failed:', err);
    return error.internal(c, 'Failed to update chart layouts');
  }
});

app.delete('/charts/:chartId', requirePermission('settings:delete'), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskAnalyticsReports, helpdeskAnalyticsCharts } = schema;
  const chartId = c.req.param('chartId');
  const now = new Date();
  try {
    const [chart] = await db
      .select()
      .from(helpdeskAnalyticsCharts)
      .where(and(eq(helpdeskAnalyticsCharts.id, chartId), isNull(helpdeskAnalyticsCharts.deletedAt)))
      .limit(1);
    if (!chart) return error.notFound(c, 'Chart', chartId);
    await db
      .update(helpdeskAnalyticsCharts)
      .set({ deletedAt: now })
      .where(eq(helpdeskAnalyticsCharts.id, chartId));
    await db
      .update(helpdeskAnalyticsReports)
      .set({ chartCount: sql`GREATEST(chart_count - 1, 0)`, updatedAt: now })
      .where(eq(helpdeskAnalyticsReports.id, chart.reportId));
    return success(c, { id: chartId });
  } catch (err) {
    console.error('[app-api/helpdesk-analytics] delete chart failed:', err);
    return error.internal(c, 'Failed to delete chart');
  }
});

app.post('/charts/data', requirePermission('settings:read'), zValidator('json', chartDataSchema), async (c) => {
  const config = c.req.valid('json');
  try {
    const { queryAnalytics } = await import('../../services/analytics-query');
    const workspaceId = c.get('workspaceId') as string;
    const data = await queryAnalytics(c.env, workspaceId, config);
    return success(c, data);
  } catch (err) {
    console.error('[app-api/helpdesk-analytics] chart data failed:', err);
    return error.internal(c, 'Failed to fetch chart data');
  }
});

app.post('/charts/batch-data', requirePermission('settings:read'), async (c) => {
  const body = await c.req.json().catch(() => ({ charts: [] })) as { charts: Array<{
    chartId: string;
    entity: string;
    metric: string;
    timeRange: string;
    groupBy: string;
    aggregation: string;
    sortOrder?: string;
    limit?: number;
  }> };
  try {
    const { queryAnalytics } = await import('../../services/analytics-query');
    const workspaceId = c.get('workspaceId') as string;
    const entries = await Promise.all(
      body.charts.map(async (chart) => {
        const data = await queryAnalytics(c.env, workspaceId, chart);
        return [chart.chartId, data] as const;
      }),
    );
    const data: Record<string, Array<{ label: string; value: number; date?: string }>> = Object.fromEntries(entries);
    return success(c, data);
  } catch (err) {
    console.error('[app-api/helpdesk-analytics] batch chart data failed:', err);
    return error.internal(c, 'Failed to fetch batch chart data');
  }
});

export const helpdeskAnalyticsRoutes = app;
