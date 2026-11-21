/**
 * Metric trees: /api/panel/metric-trees/*. An output metric and the input
 * metrics that drive it (1-25 nodes, one root, no cycles), each a saved
 * trends report or an inline single-series trends spec. Same visibility rule
 * as reports. Values: `POST /api/panel/metric-tree-values/:id` (query engine).
 *
 *   GET    /       → visible trees (?projectId, ?scope=all|mine|shared)
 *   POST   /       → new tree
 *   GET    /:id    → one tree
 *   PATCH  /:id    → name, description, visibility, nodes
 *   DELETE /:id    → soft delete
 *
 * Someone else's private tree is a 404. Changing or deleting is for the
 * owner, or for `panel_projects:manage` on a shared one.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { createPanelMetricTreeSchema, updatePanelMetricTreeSchema } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelMetricTree } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { canChange, canSee, projectExists, type Actor } from '../../services/saved-objects';
import {
  createMetricTree,
  deleteMetricTree,
  getMetricTree,
  listMetricTrees,
  metricTreeEventData,
  nodesProblem,
  toMetricTreeDto,
  updateMetricTree,
} from '../../services/metric-trees';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const listQuery = z.object({
  projectId: z.string().min(1).max(30).optional(),
  scope: z.enum(['all', 'mine', 'shared']).optional(),
});

async function actorOf(c: Ctx): Promise<Actor> {
  return { userId: c.get('userId'), canManage: await hasContextPermission(c, 'panel_projects:manage') };
}

function publish(c: Ctx, tree: PanelMetricTree, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvent({ c, entityType: 'panel_metric_tree', entityId: tree.id, action, data: metricTreeEventData(tree) });
}

/** A tree the caller may change, or the answer to send instead. */
async function editable(c: Ctx): Promise<PanelMetricTree | Response> {
  const id = c.req.param('id') ?? '';
  const actor = await actorOf(c);
  const tree = await getMetricTree(c.get('tenantDb'), id);
  if (!tree || !canSee(tree, actor)) return error.notFound(c, 'Metric tree', id);
  if (!canChange(tree, actor)) return error.forbidden(c, 'Only the owner can change this metric tree');
  return tree;
}

app.get('/', requirePermission('panel_reports:read'), zValidator('query', listQuery), async (c) => {
  const trees = await listMetricTrees(c.get('tenantDb'), await actorOf(c), c.req.valid('query'));
  return list(c, trees.map(toMetricTreeDto), cursorPagination(trees.length, false, null));
});

app.post('/', requirePermission('panel_reports:create'), zValidator('json', createPanelMetricTreeSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  if (!(await projectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);
  const problem = await nodesProblem(db, input.projectId, input.nodes, await actorOf(c));
  if (problem) return error.badRequest(c, problem);

  const tree = await createMetricTree(db, input, userId);
  publish(c, tree, 'created');
  return success(c, toMetricTreeDto(tree), 201);
});

app.get('/:id', requirePermission('panel_reports:read'), async (c) => {
  const id = c.req.param('id');
  const tree = await getMetricTree(c.get('tenantDb'), id);
  if (!tree || !canSee(tree, await actorOf(c))) return error.notFound(c, 'Metric tree', id);
  return success(c, toMetricTreeDto(tree));
});

app.patch('/:id', requirePermission('panel_reports:update'), zValidator('json', updatePanelMetricTreeSchema), async (c) => {
  const found = await editable(c);
  if (found instanceof Response) return found;
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  if (input.nodes) {
    const problem = await nodesProblem(db, found.projectId, input.nodes, await actorOf(c));
    if (problem) return error.badRequest(c, problem);
  }

  const tree = await updateMetricTree(db, found.id, input);
  if (!tree) return error.notFound(c, 'Metric tree', found.id);
  publish(c, tree, 'updated');
  return success(c, toMetricTreeDto(tree));
});

app.delete('/:id', requirePermission('panel_reports:delete'), async (c) => {
  const found = await editable(c);
  if (found instanceof Response) return found;
  const tree = await deleteMetricTree(c.get('tenantDb'), found.id);
  if (!tree) return error.notFound(c, 'Metric tree', found.id);
  publish(c, tree, 'deleted');
  return noContent(c);
});

export default app;
