/**
 * Saved reports: /api/panel/reports/*. A report is a name, an owner, a
 * visibility (`private`: the owner's alone, `workspace`: shared) and a query
 * spec; running it is `POST /api/panel/query` with `spec`.
 *
 *   GET    /           → visible reports (?projectId, ?kind, ?scope=all|mine|shared)
 *   POST   /           → new report
 *   GET    /:id        → one report
 *   PATCH  /:id        → name, description, visibility, spec (keeps the state before as a version)
 *   DELETE /:id        → soft delete; the report leaves every dashboard
 *   GET    /:id/versions                     → earlier versions, newest first (without specs)
 *   GET    /:id/versions/:version            → one version with its spec
 *   POST   /:id/versions/:version/restore    → put it back (the current state becomes a version)
 *
 * Someone else's private report is a 404. Changing or deleting is for the
 * owner, or for `panel_projects:manage` on a shared one; restoring is a change.
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
  type Actor,
} from '../../services/saved-objects';
import {
  getVersion,
  listVersions,
  restoreVersion,
  toVersionDetailDto,
  toVersionDto,
  UnrestorableVersionError,
  updateReportWithHistory,
} from '../../services/report-versions';

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

  const report = await updateReportWithHistory(db, existing, input, actor.userId);
  if (!report) return error.notFound(c, 'Report', id);
  publish(c, report, 'updated');
  return success(c, toReportDto(report));
});

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

const versionParam = z.coerce.number().int().min(1).max(1_000_000);

/** The report when the caller may see it, or the answer to send instead. */
async function visibleReport(c: Ctx): Promise<PanelReport | Response> {
  const id = c.req.param('id') ?? '';
  const report = await getReport(c.get('tenantDb'), id);
  if (!report || !canSee(report, await actorOf(c))) return error.notFound(c, 'Report', id);
  return report;
}

app.get('/:id/versions', requirePermission('panel_reports:read'), async (c) => {
  const report = await visibleReport(c);
  if (report instanceof Response) return report;
  const versions = await listVersions(c.get('tenantDb'), report.id);
  return list(c, versions.map(toVersionDto), cursorPagination(versions.length, false, null));
});

app.get('/:id/versions/:version', requirePermission('panel_reports:read'), async (c) => {
  const report = await visibleReport(c);
  if (report instanceof Response) return report;
  const number = versionParam.safeParse(c.req.param('version'));
  const version = number.success ? await getVersion(c.get('tenantDb'), report.id, number.data) : null;
  if (!version) return error.notFound(c, 'Version', c.req.param('version'));
  return success(c, toVersionDetailDto(version));
});

app.post('/:id/versions/:version/restore', requirePermission('panel_reports:update'), async (c) => {
  const report = await visibleReport(c);
  if (report instanceof Response) return report;
  const actor = await actorOf(c);
  if (!canChange(report, actor)) return error.forbidden(c, 'Only the owner can change this report');
  const db = c.get('tenantDb');
  const number = versionParam.safeParse(c.req.param('version'));
  const version = number.success ? await getVersion(db, report.id, number.data) : null;
  if (!version) return error.notFound(c, 'Version', c.req.param('version'));

  let restored: PanelReport | null;
  try {
    restored = await restoreVersion(db, report, version, actor.userId);
  } catch (err) {
    if (err instanceof UnrestorableVersionError) return error.conflict(c, err.message);
    throw err;
  }
  if (!restored) return error.notFound(c, 'Report', report.id);
  publish(c, restored, 'updated');
  return success(c, toReportDto(restored));
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
