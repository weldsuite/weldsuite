/**
 * Saved reports: /api/panel/reports/*. A report is a name, an owner, a
 * visibility (`private`: the owner's alone, `workspace`: shared) and a query
 * spec; running it is `POST /api/panel/query` with `spec`.
 *
 *   GET    /           → visible reports (?projectId, ?kind, ?scope=all|mine|shared)
 *   POST   /           → new report
 *   GET    /:id        → one report
 *   PATCH  /:id        → name, description, visibility, spec
 *   DELETE /:id        → soft delete; the report leaves every dashboard
 *
 * Someone else's private report is a 404. Changing or deleting is for the
 * owner, or for `panel_projects:manage` on a shared one.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  createPanelReportSchema,
  updatePanelReportSchema,
} from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { PANEL_REPORT_SPEC_KINDS } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelReport } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import {
  canChange,
  canSee,
  createReport,
  deleteReport,
  getReport,
  listReports,
  projectExists,
  reportEventData,
  toReportDto,
  updateReport,
  type Actor,
} from '../../services/saved-objects';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const listQuery = z.object({
  projectId: z.string().min(1).max(30).optional(),
  kind: z.enum(PANEL_REPORT_SPEC_KINDS).optional(),
  scope: z.enum(['all', 'mine', 'shared']).optional(),
});

async function actorOf(c: Ctx): Promise<Actor> {
  return { userId: c.get('userId'), canManage: await hasContextPermission(c, 'panel_projects:manage') };
}

function publish(c: Ctx, report: PanelReport, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvent({ c, entityType: 'panel_report', entityId: report.id, action, data: reportEventData(report) });
}

app.get('/', requirePermission('panel_reports:read'), zValidator('query', listQuery), async (c) => {
  const actor = await actorOf(c);
  const reports = await listReports(c.get('tenantDb'), actor, c.req.valid('query'));
  return list(c, reports.map(toReportDto), cursorPagination(reports.length, false, null));
});

app.post('/', requirePermission('panel_reports:create'), zValidator('json', createPanelReportSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  if (input.spec.projectId !== input.projectId) return error.badRequest(c, 'The spec is for a different project');
  if (!(await projectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);

  const report = await createReport(db, input, userId);
  publish(c, report, 'created');
  return success(c, toReportDto(report), 201);
});

app.get('/:id', requirePermission('panel_reports:read'), async (c) => {
  const id = c.req.param('id');
  const report = await getReport(c.get('tenantDb'), id);
  if (!report || !canSee(report, await actorOf(c))) return error.notFound(c, 'Report', id);
  return success(c, toReportDto(report));
});

app.patch('/:id', requirePermission('panel_reports:update'), zValidator('json', updatePanelReportSchema), async (c) => {
  const id = c.req.param('id');
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  const actor = await actorOf(c);
  const existing = await getReport(db, id);
  if (!existing || !canSee(existing, actor)) return error.notFound(c, 'Report', id);
  if (!canChange(existing, actor)) return error.forbidden(c, 'Only the owner can change this report');
  if (input.spec && input.spec.projectId !== existing.projectId) return error.badRequest(c, 'The spec is for a different project');

  const report = await updateReport(db, id, input);
  if (!report) return error.notFound(c, 'Report', id);
  publish(c, report, 'updated');
  return success(c, toReportDto(report));
});

app.delete('/:id', requirePermission('panel_reports:delete'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const actor = await actorOf(c);
  const existing = await getReport(db, id);
  if (!existing || !canSee(existing, actor)) return error.notFound(c, 'Report', id);
  if (!canChange(existing, actor)) return error.forbidden(c, 'Only the owner can delete this report');

  const report = await deleteReport(db, id);
  if (!report) return error.notFound(c, 'Report', id);
  publish(c, report, 'deleted');
  return noContent(c);
});

export default app;
