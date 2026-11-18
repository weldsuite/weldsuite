/**
 * WeldPanel's read API for other workers: /internal/panel/v1/:workspaceId/*,
 * mounted on the PanelApiInternal entrypoint only (../../internal.ts), so it
 * is reachable over a service binding and never from the public host.
 * external-api's `/v1/panel/*` (scope `panel:read`) and the MCP server's copy
 * of it call it, like they call board-api's BoardsInternal.
 *
 * It serves the same handlers the platform uses, read-only: an allow-list of
 * GET routes plus `POST /query` (a query only reads), so nothing here can
 * write. Every call acts for someone:
 *
 *   - `x-weld-user`: a person (a personal API key's owner, an MCP user). Their
 *     own permissions and visibility apply: their private reports, and people
 *     only with `panel_people:read`.
 *   - `x-weld-workspace-key`: a workspace API key (its id), its scope checked
 *     by the caller. It reads like a member with `panel_projects:read`,
 *     `panel_reports:read` and `panel_people:read`: shared reports and
 *     dashboards only (no one's private ones).
 *
 *   GET  /projects                       GET  /people?projectId&search&cursor&limit
 *   POST /query                          GET  /people/:distinctId?projectId
 *   GET  /reports · /reports/:id         GET  /cohorts?projectId
 *   GET  /reports/:id/results?preset     GET  /lexicon?projectId
 *   GET  /dashboards · /dashboards/:id       GET  /groups?projectId&type · /groups/:type/:key?projectId
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { ensurePermissionMiddleware } from '@weldsuite/worker-kit';
import { getWorkspaceContextForOrg, schema } from '@weldsuite/worker-kit/db';
import { error, success } from '@weldsuite/worker-kit/response';
import { createDrizzlePermissionQueries, requirePermission, resolveEffectivePermissions } from '@weldsuite/permissions/server';
import { PANEL_DATE_PRESETS, panelQuerySpecSchema } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { Env, Variables } from '../../types';
import { queryFailure } from '../../http';
import { canSee, getReport } from '../../services/saved-objects';
import { queryRunDeps, runCachedQuery } from '../../services/query-run';
import projectsRoutes from '../projects';
import queryRoutes from '../query';
import reportsRoutes from '../reports';
import dashboardsRoutes from '../dashboards';
import cohortsRoutes from '../cohorts';
import lexiconRoutes from '../lexicon';
import peopleRoutes from '../people';
import groupsRoutes from '../groups';

ensurePermissionMiddleware();

/** What a workspace API key reads with (its `panel:read` scope was checked by the caller). */
export const WORKSPACE_KEY_PERMISSIONS = {
  permissions: ['panel_projects:read', 'panel_reports:read', 'panel_people:read'],
  role: 'member',
  roleId: null,
  isOwner: false,
};

const ID = '[^/]+';
/** The only routes served here, by method; everything else is a 404 before any handler runs. */
const ALLOWED: ReadonlyArray<readonly [string, RegExp]> = [
  ['GET', /^\/projects$/],
  ['POST', /^\/query$/],
  ['GET', /^\/reports$/],
  ['GET', new RegExp(`^/reports/${ID}$`)],
  ['GET', new RegExp(`^/reports/${ID}/results$`)],
  ['GET', /^\/dashboards$/],
  ['GET', new RegExp(`^/dashboards/${ID}$`)],
  ['GET', /^\/cohorts$/],
  ['GET', /^\/lexicon$/],
  ['GET', /^\/people$/],
  ['GET', /^\/people\/(?!by-email$)[^/]+$/],
  ['GET', /^\/groups$/],
  ['GET', new RegExp(`^/groups/${ID}/${ID}$`)],
];

export function isAllowedRead(method: string, path: string): boolean {
  return ALLOWED.some(([m, pattern]) => m === method.toUpperCase() && pattern.test(path));
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('/:workspaceId/*', async (c, next) => {
  const workspaceRef = c.req.param('workspaceId');
  const prefix = `/${encodeURIComponent(workspaceRef)}`;
  const rest = c.req.path.slice(c.req.path.indexOf(prefix) + prefix.length);
  if (!isAllowedRead(c.req.method, rest)) return error.notFound(c, 'Route', rest);

  const person = c.req.header('x-weld-user');
  const workspaceKey = c.req.header('x-weld-workspace-key');
  if (!person && !workspaceKey) return error.unauthorized(c);

  let ws: Awaited<ReturnType<typeof getWorkspaceContextForOrg>>;
  try {
    ws = await getWorkspaceContextForOrg(c.env, workspaceRef);
  } catch {
    return error.notFound(c, 'Workspace', workspaceRef);
  }
  if (ws.suspended) return error.forbidden(c, 'This workspace is suspended');
  c.set('workspaceId', ws.id);
  c.set('clerkOrgId', ws.clerkOrgId ?? ws.id);
  c.set('orgId', ws.clerkOrgId ?? ws.id);
  c.set('tenantDb', ws.db);
  // A key's actor is the key id, as the caller records it: it owns no report, so it sees shared ones only.
  c.set('userId', person || workspaceKey!);
  c.set(
    'userPermissions',
    person ? await resolveEffectivePermissions(createDrizzlePermissionQueries(ws.db, schema, { eq, and, isNull }), person) : WORKSPACE_KEY_PERMISSIONS,
  );
  await next();
});

const resultsQuery = z.object({ preset: z.enum(PANEL_DATE_PRESETS).optional() });

/** A saved report run as saved (or over another preset), with its own scope. */
app.get('/:workspaceId/reports/:id/results', requirePermission('panel_reports:read'), zValidator('query', resultsQuery), async (c) => {
  const id = c.req.param('id') ?? '';
  const db = c.get('tenantDb');
  const report = await getReport(db, id);
  if (!report || !canSee(report, { userId: c.get('userId'), canManage: false })) return error.notFound(c, 'Report', id);
  const { preset } = c.req.valid('query');
  const parsed = panelQuerySpecSchema.safeParse(preset ? { ...report.spec, dateRange: { preset } } : report.spec);
  if (!parsed.success || parsed.data.projectId !== report.projectId) return error.badRequest(c, 'The report’s query is no longer valid');
  try {
    const run = await runCachedQuery(queryRunDeps(c.env, db, c.get('workspaceId')), parsed.data);
    return success(c, { ...run.result, dataAsOf: run.dataAsOf, cached: run.cached });
  } catch (err) {
    return queryFailure(c, err);
  }
});

app.route('/:workspaceId/projects', projectsRoutes);
app.route('/:workspaceId/query', queryRoutes);
app.route('/:workspaceId/reports', reportsRoutes);
app.route('/:workspaceId/dashboards', dashboardsRoutes);
app.route('/:workspaceId/cohorts', cohortsRoutes);
app.route('/:workspaceId/lexicon', lexiconRoutes);
app.route('/:workspaceId/people', peopleRoutes);
app.route('/:workspaceId/groups', groupsRoutes);

export default app;
