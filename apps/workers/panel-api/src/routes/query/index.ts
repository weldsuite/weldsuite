/**
 * POST /api/panel/query: runs a typed query spec (ADR PANEL-003).
 *
 * `panel_reports:read` for every kind; the recordings list (`sessions`) also
 * needs `panel_recordings:read`. The workspace and project come from the
 * request's auth and the tenant DB, never from the spec. Results are cached
 * in KV for two minutes per workspace, project and spec hash; the answer says
 * when the data was read (`dataAsOf`) and whether it came from the cache.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray } from 'drizzle-orm';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { schema } from '@weldsuite/worker-kit/db';
import { error, success } from '@weldsuite/worker-kit/response';
import { panelQuerySpecSchema, type PanelQueryResponse } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { requiredPanelPermissions } from '@weldsuite/panel-domain/query';
import type { Env, Variables } from '../../types';
import { getProject } from '../../services/projects';
import { queryFailure } from '../../http';
import { runCachedQuery, queryRunDeps, type CachedQuery } from '../../services/query-run';

const { panelSessionFavorites } = schema;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/', requirePermission('panel_reports:read'), zValidator('json', panelQuerySpecSchema), async (c) => {
  const spec = c.req.valid('json');
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);

  for (const permission of requiredPanelPermissions(spec.kind)) {
    if (!(await hasContextPermission(c, permission))) return error.forbidden(c, `Missing permission: ${permission}`);
  }

  const tenantDb = c.get('tenantDb');
  const project = await getProject(tenantDb, spec.projectId);
  if (!project) return error.notFound(c, 'Project', spec.projectId);

  let entry: CachedQuery;
  try {
    entry = await runCachedQuery(queryRunDeps(c.env, tenantDb, workspaceId), spec);
  } catch (err) {
    return queryFailure(c, err);
  }

  // Favourites are per project, not part of the cached data.
  if (entry.result.kind === 'sessions' && entry.result.result.sessions.length > 0) {
    const sessions = entry.result.result.sessions;
    const rows = await tenantDb
      .select({ sessionId: panelSessionFavorites.sessionId })
      .from(panelSessionFavorites)
      .where(and(eq(panelSessionFavorites.projectId, project.id), inArray(panelSessionFavorites.sessionId, sessions.map((s) => s.sessionId))));
    const favourites = new Set(rows.map((r) => r.sessionId));
    entry = {
      ...entry,
      result: {
        kind: 'sessions',
        result: { ...entry.result.result, sessions: sessions.map((s) => ({ ...s, favorite: favourites.has(s.sessionId) })) },
      },
    };
  }

  const response: PanelQueryResponse = { ...entry.result, dataAsOf: entry.dataAsOf, cached: entry.cached };
  return success(c, response);
});

export default app;
