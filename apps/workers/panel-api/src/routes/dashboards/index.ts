/**
 * Dashboards: /api/panel/dashboards/*. A dashboard is a grid of tiles, each
 * showing a saved report or its own Markdown text, with optional
 * dashboard-wide filters (a date range and filters applied to every report
 * tile). Same visibility rule as reports.
 *
 *   GET    /                      → visible dashboards (?projectId, ?scope)
 *   POST   /                      → new dashboard (name, description, visibility, filters)
 *   GET    /templates             → the built-in templates (?locale=en|nl, else Accept-Language)
 *   POST   /from-template         → a dashboard and its reports from a template
 *   GET    /:id                   → dashboard, tiles (with the spec each report tile runs) and the visible reports on them
 *   PATCH  /:id                   → name, description, visibility, filters
 *   DELETE /:id                   → soft delete (tiles go with it)
 *   POST   /:id/tiles             → add a report tile or a text tile
 *   PATCH  /:id/tiles/:tileId     → move or resize a tile, or change a text tile's text
 *   DELETE /:id/tiles/:tileId     → remove a tile
 *   PUT    /:id/layout            → move and resize every tile at once
 *
 * Tile and filter changes need `panel_reports:update` and are an `updated`
 * event on the dashboard (never carrying the filters or the text).
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  addPanelDashboardTileSchema,
  createPanelDashboardSchema,
  setPanelDashboardLayoutSchema,
  updatePanelDashboardSchema,
  updatePanelDashboardTileSchema,
} from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { createPanelDashboardFromTemplateSchema, PANEL_TEMPLATE_LOCALES } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelDashboard, PanelDashboardTile, PanelReport } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import {
  addTile,
  canChange,
  canSee,
  createDashboard,
  dashboardDetail,
  dashboardEventData,
  deleteDashboard,
  getDashboard,
  getReport,
  getTile,
  listDashboards,
  projectExists,
  removeTile,
  reportEventData,
  setLayout,
  toDashboardDto,
  toTileDto,
  updateDashboard,
  updateTile,
  type Actor,
} from '../../services/saved-objects';
import { DASHBOARD_TEMPLATES, createFromTemplate, findTemplate, templateLocale, toTemplateDto } from '../../services/dashboard-templates';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const listQuery = z.object({
  projectId: z.string().min(1).max(30).optional(),
  scope: z.enum(['all', 'mine', 'shared']).optional(),
});

const templatesQuery = z.object({ locale: z.enum(PANEL_TEMPLATE_LOCALES).optional() });

async function actorOf(c: Ctx): Promise<Actor> {
  return { userId: c.get('userId'), canManage: await hasContextPermission(c, 'panel_projects:manage') };
}

function publish(c: Ctx, dashboard: PanelDashboard, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvent({ c, entityType: 'panel_dashboard', entityId: dashboard.id, action, data: dashboardEventData(dashboard) });
}

function publishReport(c: Ctx, report: PanelReport) {
  publishEntityEvent({ c, entityType: 'panel_report', entityId: report.id, action: 'created', data: reportEventData(report) });
}

/** A dashboard the caller may change, or the answer to send instead. */
async function editable(c: Ctx): Promise<PanelDashboard | Response> {
  const id = c.req.param('id') ?? '';
  const actor = await actorOf(c);
  const dashboard = await getDashboard(c.get('tenantDb'), id);
  if (!dashboard || !canSee(dashboard, actor)) return error.notFound(c, 'Dashboard', id);
  if (!canChange(dashboard, actor)) return error.forbidden(c, 'Only the owner can change this dashboard');
  return dashboard;
}

app.get('/', requirePermission('panel_reports:read'), zValidator('query', listQuery), async (c) => {
  const dashboards = await listDashboards(c.get('tenantDb'), await actorOf(c), c.req.valid('query'));
  return list(c, dashboards.map(toDashboardDto), cursorPagination(dashboards.length, false, null));
});

app.post('/', requirePermission('panel_reports:create'), zValidator('json', createPanelDashboardSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  if (!(await projectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);

  const dashboard = await createDashboard(db, input, userId);
  publish(c, dashboard, 'created');
  return success(c, toDashboardDto(dashboard), 201);
});

app.get('/templates', requirePermission('panel_reports:read'), zValidator('query', templatesQuery), (c) => {
  const locale = templateLocale(c.req.valid('query').locale, c.req.header('Accept-Language'));
  const templates = DASHBOARD_TEMPLATES.map((t) => toTemplateDto(t, locale));
  return list(c, templates, cursorPagination(templates.length, false, null));
});

app.post('/from-template', requirePermission('panel_reports:create'), zValidator('json', createPanelDashboardFromTemplateSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  if (!(await projectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);
  const template = findTemplate(input.template);
  if (!template) return error.notFound(c, 'Template', input.template);

  const locale = templateLocale(input.locale, c.req.header('Accept-Language'));
  const created = await createFromTemplate(db, template, input, userId, locale);
  for (const report of created.reports) publishReport(c, report);
  publish(c, created.dashboard, 'created');
  return success(c, await dashboardDetail(db, created.dashboard, await actorOf(c)), 201);
});

app.get('/:id', requirePermission('panel_reports:read'), async (c) => {
  const id = c.req.param('id');
  const actor = await actorOf(c);
  const db = c.get('tenantDb');
  const dashboard = await getDashboard(db, id);
  if (!dashboard || !canSee(dashboard, actor)) return error.notFound(c, 'Dashboard', id);
  return success(c, await dashboardDetail(db, dashboard, actor));
});

app.patch('/:id', requirePermission('panel_reports:update'), zValidator('json', updatePanelDashboardSchema), async (c) => {
  const found = await editable(c);
  if (found instanceof Response) return found;
  const dashboard = await updateDashboard(c.get('tenantDb'), found.id, c.req.valid('json'));
  if (!dashboard) return error.notFound(c, 'Dashboard', found.id);
  publish(c, dashboard, 'updated');
  return success(c, toDashboardDto(dashboard));
});

app.delete('/:id', requirePermission('panel_reports:delete'), async (c) => {
  const found = await editable(c);
  if (found instanceof Response) return found;
  const dashboard = await deleteDashboard(c.get('tenantDb'), found.id);
  if (!dashboard) return error.notFound(c, 'Dashboard', found.id);
  publish(c, dashboard, 'deleted');
  return noContent(c);
});

app.post('/:id/tiles', requirePermission('panel_reports:update'), zValidator('json', addPanelDashboardTileSchema), async (c) => {
  const found = await editable(c);
  if (found instanceof Response) return found;
  const input = c.req.valid('json');
  const db = c.get('tenantDb');

  let tile: PanelDashboardTile;
  if (input.kind === 'text') {
    tile = await addTile(db, found.id, { kind: 'text', text: input.text, layout: input.layout });
  } else {
    const report = await getReport(db, input.reportId);
    // A report the caller cannot see, or one of another project, does not exist for them.
    if (!report || report.projectId !== found.projectId || !canSee(report, await actorOf(c))) {
      return error.notFound(c, 'Report', input.reportId);
    }
    tile = await addTile(db, found.id, { kind: 'report', reportId: report.id, layout: input.layout });
  }
  const dashboard = await updateDashboard(db, found.id, {});
  if (dashboard) publish(c, dashboard, 'updated');
  return success(c, toTileDto(tile), 201);
});

app.patch('/:id/tiles/:tileId', requirePermission('panel_reports:update'), zValidator('json', updatePanelDashboardTileSchema), async (c) => {
  const found = await editable(c);
  if (found instanceof Response) return found;
  const tileId = c.req.param('tileId');
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  const existing = await getTile(db, found.id, tileId);
  if (!existing) return error.notFound(c, 'Tile', tileId);
  if (input.text !== undefined && existing.kind !== 'text') return error.badRequest(c, 'Only a text tile has text');

  const tile = await updateTile(db, found.id, tileId, input);
  if (!tile) return error.notFound(c, 'Tile', tileId);
  const dashboard = await updateDashboard(db, found.id, {});
  if (dashboard) publish(c, dashboard, 'updated');
  return success(c, toTileDto(tile));
});

app.delete('/:id/tiles/:tileId', requirePermission('panel_reports:update'), async (c) => {
  const found = await editable(c);
  if (found instanceof Response) return found;
  const tileId = c.req.param('tileId');
  const db = c.get('tenantDb');
  if (!(await removeTile(db, found.id, tileId))) return error.notFound(c, 'Tile', tileId);
  const dashboard = await updateDashboard(db, found.id, {});
  if (dashboard) publish(c, dashboard, 'updated');
  return noContent(c);
});

app.put('/:id/layout', requirePermission('panel_reports:update'), zValidator('json', setPanelDashboardLayoutSchema), async (c) => {
  const found = await editable(c);
  if (found instanceof Response) return found;
  const db = c.get('tenantDb');
  if (!(await setLayout(db, found.id, c.req.valid('json').tiles))) return error.badRequest(c, 'A tile is not on this dashboard');
  const dashboard = await updateDashboard(db, found.id, {});
  if (!dashboard) return error.notFound(c, 'Dashboard', found.id);
  publish(c, dashboard, 'updated');
  return success(c, await dashboardDetail(db, dashboard, await actorOf(c)));
});

export default app;
