/**
 * /api/panel/insights/explain: root cause of a change of one trends series
 * (which countries, devices, sources, pages or asked properties carry it),
 * with an optional AI narrative. Needs `panel_reports:read`; 404 for another
 * project; 400 for a spec the compiler refuses. A narrative that cannot be
 * written leaves the numbers and says why (`narrativeUnavailable`).
 *
 * /api/panel/insights/summarise: AI themes across up to 20 recordings, from a
 * recordings filter or the people who dropped at a funnel step. Each session is
 * summarised first (cached), then grouped. Needs `panel_recordings:read` and,
 * like the sessions list it stands on, `panel_reports:read`. 402 when the
 * wallet cannot pay; 403 when the project switched AI off; 404 when the filter
 * matches no session. Reads recordings, writes nothing the bus carries.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { resolveAiMetering } from '@weldsuite/core-domain/ai-billing';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { error, success } from '@weldsuite/worker-kit/response';
import { summarisePanelSetSchema } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { explainPanelChangeSchema } from '@weldsuite/app-api-client/schemas/weldpanel-analysis';
import type { Env, Variables } from '../../types';
import { aiFailure, queryFailure } from '../../http';
import { summariseSet } from '../../services/ai-summaries';
import { explainChange } from '../../services/explain';
import { getProject } from '../../services/projects';
import { queryRunDeps } from '../../services/query-run';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/explain', requirePermission('panel_reports:read'), zValidator('json', explainPanelChangeSchema), async (c) => {
  const input = c.req.valid('json');
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);

  const tenantDb = c.get('tenantDb');
  const project = await getProject(tenantDb, input.projectId);
  if (!project) return error.notFound(c, 'Project', input.projectId);

  try {
    const metering = input.narrate ? await resolveAiMetering(c.env, workspaceId, userId) : null;
    const deps = { ...queryRunDeps(c.env, tenantDb, workspaceId), userId, metering };
    return success(c, await explainChange(deps, project, input));
  } catch (err) {
    return queryFailure(c, err);
  }
});

app.post('/summarise', requirePermission('panel_recordings:read'), zValidator('json', summarisePanelSetSchema), async (c) => {
  const input = c.req.valid('json');
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  if (!(await hasContextPermission(c, 'panel_reports:read'))) return error.forbidden(c, 'Missing permission: panel_reports:read');

  const tenantDb = c.get('tenantDb');
  const project = await getProject(tenantDb, input.projectId);
  if (!project) return error.notFound(c, 'Project', input.projectId);

  try {
    const deps = { ...queryRunDeps(c.env, tenantDb, workspaceId), userId, metering: await resolveAiMetering(c.env, workspaceId, userId) };
    return success(c, await summariseSet(deps, project, input));
  } catch (err) {
    return aiFailure(c, err);
  }
});

export default app;
