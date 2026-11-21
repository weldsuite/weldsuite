/**
 * Secret keys: /api/panel/projects/:id/keys (mounted under the projects prefix
 * in index.ts). A key (`wps_` + 32 hex) lets a customer's server send events and
 * profile operations to the collector (`/v1/track`, `/v1/import`). Everything
 * here is `panel_projects:manage`, kept apart from renaming and domains.
 *
 *   GET    /          → the project's keys, revoked ones included (never the key itself)
 *   POST   /          → new key; the response carries the whole key, once
 *   DELETE /:keyId    → revoke: the collector stops accepting it
 *
 * Only a hash is stored. Creating and revoking publish `panel_key` entity
 * events with the key's id, name and visible prefix.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { createPanelKeySchema, type PanelCreatedKeyDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { Env, Variables } from '../../types';
import { registryFor } from '../../http';
import { createKey, keyEventData, listKeys, revokeKey, toKeyDto, type PanelKey } from '../../services/keys';
import { getProject } from '../../services/projects';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function publish(c: Ctx, key: PanelKey, action: 'created' | 'deleted') {
  publishEntityEvent({ c, entityType: 'panel_key', entityId: key.id, action, data: keyEventData(key) });
}

app.get('/', requirePermission('panel_projects:manage'), async (c) => {
  const projectId = c.req.param('id') ?? '';
  const registry = registryFor(c);
  if (!registry) return error.orgRequired(c);
  if (!(await getProject(c.get('tenantDb'), projectId))) return error.notFound(c, 'Project', projectId);

  const keys = await listKeys(registry, projectId);
  return list(c, keys.map(toKeyDto), cursorPagination(keys.length, false, null));
});

app.post('/', requirePermission('panel_projects:manage'), zValidator('json', createPanelKeySchema), async (c) => {
  const projectId = c.req.param('id') ?? '';
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const registry = registryFor(c);
  if (!registry) return error.orgRequired(c);
  const project = await getProject(c.get('tenantDb'), projectId);
  if (!project) return error.notFound(c, 'Project', projectId);

  const created = await createKey(registry, project, c.req.valid('json').name, userId);
  if (created === 'limit') return error.conflict(c, 'This project has the most secret keys it can hold. Revoke one first.');
  publish(c, created.row, 'created');
  const body: PanelCreatedKeyDto = { ...toKeyDto(created.row), key: created.key };
  return success(c, body, 201);
});

app.delete('/:keyId', requirePermission('panel_projects:manage'), async (c) => {
  const projectId = c.req.param('id') ?? '';
  const keyId = c.req.param('keyId');
  const registry = registryFor(c);
  if (!registry) return error.orgRequired(c);
  if (!(await getProject(c.get('tenantDb'), projectId))) return error.notFound(c, 'Project', projectId);

  const key = await revokeKey(registry, projectId, keyId);
  if (!key) return error.notFound(c, 'Key', keyId);
  publish(c, key, 'deleted');
  return noContent(c);
});

export default app;
