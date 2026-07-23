/**
 * Project analytics routes — /api/project-analytics/*.
 *
 * CRUD for analytics reports + charts (WeldFlow module). Ported from
 * apps/api-worker/src/routes/projects/analytics.ts.
 *
 * APP_NAME filter ('projects') ensures this route only surfaces WeldFlow
 * reports and never leaks e.g. CRM reports that share the same DB tables.
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import {
  createReportSchema,
  updateReportSchema,
  createChartSchema,
  updateChartLayoutsSchema,
} from '@weldsuite/core-api-client/schemas/project-analytics';

const APP_NAME = 'projects';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// Report Routes
// ============================================================================

/**
 * GET /reports — list analytics reports for the WeldFlow app.
 */
app.get('/reports', requirePermission('projects:read'), async (c) => {
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
    console.error('[app-api/project-analytics] list reports failed:', err);
    return error.internal(c, 'Failed to fetch reports');
  }
});

/**
 * GET /reports/:reportId — get single report with its charts.
 */
app.get('/reports/:reportId', requirePermission('projects:read'), async (c) => {
  const reportId = c.req.param('reportId');
  const db = c.get('tenantDb');
  const { analyticsReports, analyticsCharts } = schema;

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

    const charts = await db
      .select()
      .from(analyticsCharts)
      .where(and(eq(analyticsCharts.reportId, reportId), isNull(analyticsCharts.deletedAt)))
      .orderBy(asc(analyticsCharts.sortIndex));

    return success(c, { report, charts });
  } catch (err) {
    console.error('[app-api/project-analytics] get report failed:', err);
    return error.internal(c, 'Failed to fetch report');
  }
});

/**
 * POST /reports — create a new analytics report.
 */
app.post(
  '/reports',
  requirePermission('projects:create'),
  zValidator('json', createReportSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const data = c.req.valid('json');
    const { analyticsReports } = schema;

    try {
      const id = generateId('rpt');
      const now = new Date();

      await db.insert(analyticsReports).values({
        id,
        app: APP_NAME,
        title: data.title,
        description: data.description || '',
        createdById: userId,
        chartCount: 0,
        createdAt: now,
        updatedAt: now,
      });

      publishEntityEvent({
        c,
        entityType: 'analytics_report',
        entityId: id,
        action: 'created',
        data: { id, title: data.title } as unknown as Record<string, unknown>,
      });

      return success(c, { id }, 201);
    } catch (err) {
      console.error('[app-api/project-analytics] create report failed:', err);
      return error.internal(c, 'Failed to create report');
    }
  },
);

/**
 * PUT /reports/:reportId — update report title / description.
 * Kept as PUT (not PATCH) to mirror the legacy api-worker surface so the
 * analyticsApi.updateReport call site compiles unchanged.
 */
app.put(
  '/reports/:reportId',
  requirePermission('projects:update'),
  zValidator('json', updateReportSchema),
  async (c) => {
    const reportId = c.req.param('reportId');
    const db = c.get('tenantDb');
    const data = c.req.valid('json');
    const { analyticsReports } = schema;

    try {
      await db
        .update(analyticsReports)
        .set({ ...data, updatedAt: new Date() })
        .where(
          and(
            eq(analyticsReports.id, reportId),
            eq(analyticsReports.app, APP_NAME),
            isNull(analyticsReports.deletedAt),
          ),
        );

      publishEntityEvent({
        c,
        entityType: 'analytics_report',
        entityId: reportId,
        action: 'updated',
        data: { id: reportId, ...data } as unknown as Record<string, unknown>,
      });

      return success(c, { id: reportId });
    } catch (err) {
      console.error('[app-api/project-analytics] update report failed:', err);
      return error.internal(c, 'Failed to update report');
    }
  },
);

/**
 * DELETE /reports/:reportId — soft-delete report.
 */
app.delete('/reports/:reportId', requirePermission('projects:delete'), async (c) => {
  const reportId = c.req.param('reportId');
  const db = c.get('tenantDb');
  const { analyticsReports } = schema;

  try {
    await db
      .update(analyticsReports)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(analyticsReports.id, reportId),
          eq(analyticsReports.app, APP_NAME),
          isNull(analyticsReports.deletedAt),
        ),
      );

    publishEntityEvent({
      c,
      entityType: 'analytics_report',
      entityId: reportId,
      action: 'deleted',
      data: { id: reportId } as unknown as Record<string, unknown>,
    });

    return c.json({ success: true });
  } catch (err) {
    console.error('[app-api/project-analytics] delete report failed:', err);
    return error.internal(c, 'Failed to delete report');
  }
});

/**
 * POST /reports/:reportId/duplicate — duplicate report with all charts.
 */
app.post('/reports/:reportId/duplicate', requirePermission('projects:create'), async (c) => {
  const reportId = c.req.param('reportId');
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const { analyticsReports, analyticsCharts } = schema;

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
    });

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
        })),
      );
    }

    publishEntityEvent({
      c,
      entityType: 'analytics_report',
      entityId: newId,
      action: 'created',
      data: { id: newId, duplicatedFrom: reportId } as unknown as Record<string, unknown>,
    });

    return success(c, { id: newId }, 201);
  } catch (err) {
    console.error('[app-api/project-analytics] duplicate report failed:', err);
    return error.internal(c, 'Failed to duplicate report');
  }
});

// ============================================================================
// Chart Routes
// ============================================================================

/**
 * GET /reports/:reportId/charts — list charts for a report.
 */
app.get('/reports/:reportId/charts', requirePermission('projects:read'), async (c) => {
  const reportId = c.req.param('reportId');
  const db = c.get('tenantDb');
  const { analyticsCharts } = schema;

  try {
    const charts = await db
      .select()
      .from(analyticsCharts)
      .where(and(eq(analyticsCharts.reportId, reportId), isNull(analyticsCharts.deletedAt)))
      .orderBy(asc(analyticsCharts.sortIndex));

    return success(c, charts);
  } catch (err) {
    console.error('[app-api/project-analytics] list charts failed:', err);
    return error.internal(c, 'Failed to fetch charts');
  }
});

/**
 * POST /reports/:reportId/charts — create chart inside a report.
 * Route registered BEFORE /reports/:reportId/charts/layouts so Hono
 * doesn't shadow the literal path segment.
 */
app.post(
  '/reports/:reportId/charts',
  requirePermission('projects:create'),
  zValidator('json', createChartSchema.omit({ reportId: true })),
  async (c) => {
    const reportId = c.req.param('reportId');
    const db = c.get('tenantDb');
    const data = c.req.valid('json');
    const { analyticsReports, analyticsCharts } = schema;

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
        title: data.title,
        description: data.description || null,
        chartType: data.chartType,
        entity: data.entity,
        metric: data.metric,
        color: data.color || '#3b82f6',
        smoothCurve: data.smoothCurve ?? true,
        fillArea: data.fillArea ?? true,
        showDataLabels: data.showDataLabels ?? false,
        showLegend: data.showLegend ?? true,
        timeRange: data.timeRange || 'last_30_days',
        groupBy: data.groupBy || 'day',
        aggregation: data.aggregation || 'sum',
        sortOrder: data.sortOrder || 'asc',
        limit: data.limit || null,
        compareWith: data.compareWith || null,
        layout: data.layout || { x: 0, y: 0, w: 6, h: 4 },
        sortIndex: existingCharts.length,
        createdAt: now,
        updatedAt: now,
      });

      await db
        .update(analyticsReports)
        .set({ chartCount: existingCharts.length + 1, updatedAt: now })
        .where(eq(analyticsReports.id, reportId));

      publishEntityEvent({
        c,
        entityType: 'analytics_chart',
        entityId: id,
        action: 'created',
        data: { id, reportId } as unknown as Record<string, unknown>,
      });

      return success(c, { id }, 201);
    } catch (err) {
      console.error('[app-api/project-analytics] create chart failed:', err);
      return error.internal(c, 'Failed to create chart');
    }
  },
);

/**
 * PATCH /reports/:reportId/charts/layouts — bulk-update chart layout positions.
 * Registered BEFORE /:chartId so the literal "layouts" is matched first.
 */
app.patch(
  '/reports/:reportId/charts/layouts',
  requirePermission('projects:update'),
  zValidator('json', updateChartLayoutsSchema),
  async (c) => {
    const reportId = c.req.param('reportId');
    const db = c.get('tenantDb');
    const { layouts } = c.req.valid('json');
    const { analyticsCharts } = schema;

    try {
      const now = new Date();

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
      console.error('[app-api/project-analytics] update chart layouts failed:', err);
      return error.internal(c, 'Failed to update chart layouts');
    }
  },
);

/**
 * DELETE /reports/:reportId/charts/:chartId — soft-delete a chart.
 */
app.delete(
  '/reports/:reportId/charts/:chartId',
  requirePermission('projects:delete'),
  async (c) => {
    const reportId = c.req.param('reportId');
    const chartId = c.req.param('chartId');
    const db = c.get('tenantDb');
    const { analyticsReports, analyticsCharts } = schema;

    try {
      const now = new Date();

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

      const remainingCharts = await db
        .select()
        .from(analyticsCharts)
        .where(and(eq(analyticsCharts.reportId, reportId), isNull(analyticsCharts.deletedAt)));

      await db
        .update(analyticsReports)
        .set({ chartCount: remainingCharts.length, updatedAt: now })
        .where(eq(analyticsReports.id, reportId));

      publishEntityEvent({
        c,
        entityType: 'analytics_chart',
        entityId: chartId,
        action: 'deleted',
        data: { id: chartId, reportId } as unknown as Record<string, unknown>,
      });

      return c.json({ success: true });
    } catch (err) {
      console.error('[app-api/project-analytics] delete chart failed:', err);
      return error.internal(c, 'Failed to delete chart');
    }
  },
);

/**
 * POST /reports/:reportId/charts/:chartId/duplicate — duplicate a chart within the report.
 */
app.post(
  '/reports/:reportId/charts/:chartId/duplicate',
  requirePermission('projects:create'),
  async (c) => {
    const reportId = c.req.param('reportId');
    const chartId = c.req.param('chartId');
    const db = c.get('tenantDb');
    const { analyticsReports, analyticsCharts } = schema;

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
      const originalLayout = (original.layout as { x: number; y: number; w: number; h: number } | null) ?? {
        x: 0,
        y: 0,
        w: 6,
        h: 4,
      };
      const newLayout = { ...originalLayout, y: originalLayout.y + (originalLayout.h || 4) };

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
        layout: newLayout,
        sortIndex: existingCharts.length,
        createdAt: now,
        updatedAt: now,
      });

      await db
        .update(analyticsReports)
        .set({ chartCount: existingCharts.length + 1, updatedAt: now })
        .where(eq(analyticsReports.id, reportId));

      publishEntityEvent({
        c,
        entityType: 'analytics_chart',
        entityId: newId,
        action: 'created',
        data: { id: newId, reportId, duplicatedFrom: chartId } as unknown as Record<string, unknown>,
      });

      return success(c, { id: newId }, 201);
    } catch (err) {
      console.error('[app-api/project-analytics] duplicate chart failed:', err);
      return error.internal(c, 'Failed to duplicate chart');
    }
  },
);

/**
 * POST /reports/:reportId/charts-data — compute chart data for multiple chart configs.
 * Queries Cloudflare R2 Data Catalog (Iceberg) via the SQL REST API.
 */
app.post('/reports/:reportId/charts-data', requirePermission('projects:read'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const chartConfigs: Array<{
    chartId: string;
    entity: string;
    metric: string;
    timeRange: string;
    groupBy: string;
    aggregation: string;
    sortOrder: string;
    limit?: number;
  }> = (body as any)?.charts ?? [];

  try {
    const { queryAnalytics } = await import('../../services/analytics-query');
    const workspaceId = c.get('workspaceId');

    const entries = await Promise.all(
      chartConfigs.map(async (config) => {
        const data = await queryAnalytics(c.env, workspaceId, config);
        return [config.chartId, data] as const;
      }),
    );

    const data: Record<string, Array<{ label: string; value: number; date?: string }>> =
      Object.fromEntries(entries);

    return c.json({ success: true, data });
  } catch (err) {
    console.error('[app-api/project-analytics] charts-data failed:', err);
    return error.internal(c, 'Failed to get charts data');
  }
});

export const projectAnalyticsRoutes = app;
