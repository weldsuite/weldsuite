/**
 * Computed properties: /api/panel/computed-properties/*. A value derived from
 * event properties at query time (a formula, or the first of several inputs
 * that is set); a query spec uses one as `@<id>` wherever it takes an event
 * property key.
 *
 *   GET    /       → ?projectId: the project's computed properties, by name
 *   POST   /       → new computed property (400 for a formula that does not parse, 409 when the name is taken)
 *   GET    /:id    → one computed property
 *   PATCH  /:id    → name, description, definition
 *   DELETE /:id    → soft delete
 *
 * `panel_reports:read` to read, `:create` / `:update` / `:delete` to write.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  createPanelComputedPropertySchema,
  updatePanelComputedPropertySchema,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelComputedProperty } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { projectExists } from '../../services/saved-objects';
import {
  computedPropertyEventData,
  createComputedProperty,
  DefinitionError,
  deleteComputedProperty,
  getComputedProperty,
  listComputedProperties,
  toComputedPropertyDto,
  updateComputedProperty,
} from '../../services/definitions';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const listQuery = z.object({ projectId: z.string().min(1).max(30) });

function publish(c: Ctx, row: PanelComputedProperty, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvent({ c, entityType: 'panel_computed_property', entityId: row.id, action, data: computedPropertyEventData(row) });
}

function definitionFailure(c: Ctx, err: unknown): Response {
  if (err instanceof DefinitionError) {
    return err.status === 409 ? error.conflict(c, err.message) : error.badRequest(c, err.message, err.details);
  }
  throw err;
}

app.get('/', requirePermission('panel_reports:read'), zValidator('query', listQuery), async (c) => {
  const rows = await listComputedProperties(c.get('tenantDb'), c.req.valid('query').projectId);
  return list(c, rows.map(toComputedPropertyDto), cursorPagination(rows.length, false, null));
});

app.post('/', requirePermission('panel_reports:create'), zValidator('json', createPanelComputedPropertySchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  if (!(await projectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);

  let row: PanelComputedProperty;
  try {
    row = await createComputedProperty(db, input, userId);
  } catch (err) {
    return definitionFailure(c, err);
  }
  publish(c, row, 'created');
  return success(c, toComputedPropertyDto(row), 201);
});

app.get('/:id', requirePermission('panel_reports:read'), async (c) => {
  const id = c.req.param('id');
  const row = await getComputedProperty(c.get('tenantDb'), id);
  if (!row) return error.notFound(c, 'Computed property', id);
  return success(c, toComputedPropertyDto(row));
});

app.patch('/:id', requirePermission('panel_reports:update'), zValidator('json', updatePanelComputedPropertySchema), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const existing = await getComputedProperty(db, id);
  if (!existing) return error.notFound(c, 'Computed property', id);

  let row: PanelComputedProperty | null;
  try {
    row = await updateComputedProperty(db, existing, c.req.valid('json'));
  } catch (err) {
    return definitionFailure(c, err);
  }
  if (!row) return error.notFound(c, 'Computed property', id);
  publish(c, row, 'updated');
  return success(c, toComputedPropertyDto(row));
});

app.delete('/:id', requirePermission('panel_reports:delete'), async (c) => {
  const id = c.req.param('id');
  const row = await deleteComputedProperty(c.get('tenantDb'), id);
  if (!row) return error.notFound(c, 'Computed property', id);
  publish(c, row, 'deleted');
  return noContent(c);
});

export default app;
