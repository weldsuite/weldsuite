/**
 * Metric tree values (the trees themselves are /api/panel/metric-trees):
 *
 *   POST /api/panel/metric-tree-values       { projectId, nodes, dateRange?, timezone? }  (the editor's preview)
 *   POST /api/panel/metric-tree-values/:id   { dateRange?, timezone? }                    (a saved tree)
 *
 * Each node's value for the period and the one before, the change, and for
 * `influence` nodes the correlation of its daily values with the parent's.
 * `panel_reports:read`; a saved tree, and every report a node names, must
 * be visible to the caller (owner or shared with the workspace). Reads only.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { schema } from '@weldsuite/worker-kit/db';
import { error, success } from '@weldsuite/worker-kit/response';
import { panelMetricTreeNodesSchema } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { panelMetricTreeValuesSchema, panelSavedMetricTreeValuesSchema } from '@weldsuite/app-api-client/schemas/weldpanel-analysis';
import type { Env, Variables } from '../../types';
import { queryFailure } from '../../http';
import { getProject } from '../../services/projects';
import { canSee, type Actor } from '../../services/saved-objects';
import { metricTreeValues } from '../../services/metric-tree-values';
import { queryRunDeps } from '../../services/query-run';

const { panelMetricTrees } = schema;

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

async function actorOf(c: Ctx): Promise<Actor> {
  return { userId: c.get('userId'), canManage: await hasContextPermission(c, 'panel_projects:manage') };
}

app.post('/', requirePermission('panel_reports:read'), zValidator('json', panelMetricTreeValuesSchema), async (c) => {
  const input = c.req.valid('json');
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);
  const tenantDb = c.get('tenantDb');
  const project = await getProject(tenantDb, input.projectId);
  if (!project) return error.notFound(c, 'Project', input.projectId);

  try {
    const values = await metricTreeValues(queryRunDeps(c.env, tenantDb, workspaceId), await actorOf(c), project.id, input.nodes, input);
    return success(c, values);
  } catch (err) {
    return queryFailure(c, err);
  }
});

app.post('/:id', requirePermission('panel_reports:read'), zValidator('json', panelSavedMetricTreeValuesSchema), async (c) => {
  const id = c.req.param('id');
  const input = c.req.valid('json');
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);
  const tenantDb = c.get('tenantDb');
  const actor = await actorOf(c);

  const [tree] = await tenantDb
    .select()
    .from(panelMetricTrees)
    .where(and(eq(panelMetricTrees.id, id), isNull(panelMetricTrees.deletedAt)))
    .limit(1);
  if (!tree || !canSee(tree, actor)) return error.notFound(c, 'Metric tree', id);
  const project = await getProject(tenantDb, tree.projectId);
  if (!project) return error.notFound(c, 'Project', tree.projectId);
  const nodes = panelMetricTreeNodesSchema.safeParse(tree.nodes);
  if (!nodes.success) return error.badRequest(c, 'This metric tree is no longer valid; open it and save it again');

  try {
    return success(c, await metricTreeValues(queryRunDeps(c.env, tenantDb, workspaceId), actor, project.id, nodes.data, input));
  } catch (err) {
    return queryFailure(c, err);
  }
});

export default app;
