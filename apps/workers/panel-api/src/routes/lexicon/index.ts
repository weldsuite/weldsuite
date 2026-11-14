/**
 * /api/panel/lexicon: the event and property names seen in the data (last 30
 * days, cached about an hour) with the team's definitions.
 *
 *   GET   /?projectId=  → names seen merged with definitions (`panel_reports:read`)
 *   PATCH /             → describe, hide or verify a name; creates the definition (`panel_reports:update`)
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { error, success } from '@weldsuite/worker-kit/response';
import { updatePanelLexiconSchema } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { panelQuerySpecSchema } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { PanelQueryError } from '@weldsuite/panel-domain/query';
import type { Env, Variables } from '../../types';
import { getProject } from '../../services/projects';
import { QueryUnavailableError, basinExecutor, buildQueryContext } from '../../services/query-engine';
import {
  definitionEventData,
  definitionToEntry,
  lexiconCacheKey,
  listDefinitions,
  loadNamesSeen,
  mergeLexicon,
  upsertDefinition,
} from '../../services/lexicon';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const listQuery = z.object({ projectId: z.string().min(1).max(30) });

app.get('/', requirePermission('panel_reports:read'), zValidator('query', listQuery), async (c) => {
  const { projectId } = c.req.valid('query');
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);
  const tenantDb = c.get('tenantDb');
  const project = await getProject(tenantDb, projectId);
  if (!project) return error.notFound(c, 'Project', projectId);

  const definitions = await listDefinitions(tenantDb, projectId);
  try {
    // The scan runs with the same scope as a query: erased ids and the identity flag come from the context.
    const spec = panelQuerySpecSchema.parse({ kind: 'web', projectId });
    const ctx = await buildQueryContext({ env: c.env, tenantDb, masterDb: getMasterDb(c.env), workspaceId, projectId, spec });
    const scan = await loadNamesSeen(c.env.WORKSPACE_CACHE, ctx, () => basinExecutor(c.env));
    return success(c, mergeLexicon(scan, definitions));
  } catch (err) {
    if (err instanceof PanelQueryError) return error.badRequest(c, err.message);
    // Without the analytics store the lexicon still shows what the team defined.
    if (err instanceof QueryUnavailableError) {
      return success(c, mergeLexicon({ events: [], properties: [], scannedAt: new Date().toISOString() }, definitions));
    }
    console.error('[panel-api] lexicon scan failed', err);
    return error.badGateway(c, 'The analytics store did not answer');
  }
});

app.patch('/', requirePermission('panel_reports:update'), zValidator('json', updatePanelLexiconSchema), async (c) => {
  const input = c.req.valid('json');
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);
  const tenantDb = c.get('tenantDb');
  if (!(await getProject(tenantDb, input.projectId))) return error.notFound(c, 'Project', input.projectId);

  const { definition, created } = await upsertDefinition(tenantDb, userId, input);
  publishEntityEvent({
    c,
    entityType: 'panel_event_definition',
    entityId: definition.id,
    action: created ? 'created' : 'updated',
    data: definitionEventData(definition),
  });

  let scan: Parameters<typeof definitionToEntry>[1] = null;
  try {
    const hit = await c.env.WORKSPACE_CACHE.get(lexiconCacheKey(workspaceId, input.projectId), 'json');
    if (hit && typeof hit === 'object') scan = hit as NonNullable<Parameters<typeof definitionToEntry>[1]>;
  } catch {
    // The entry is still right; it just cannot say whether the name was seen.
  }
  return success(c, definitionToEntry(definition, scan));
});

export default app;
