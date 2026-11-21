/**
 * Custom events: /api/panel/custom-events/*. Several events (each with its own
 * filters) under one name; a query spec uses one as `@<id>` wherever it takes
 * an event name.
 *
 *   GET    /       → ?projectId: the project's custom events, by name
 *   POST   /       → new custom event (409 when the name is taken)
 *   GET    /:id    → one custom event
 *   PATCH  /:id    → name, description, definition
 *   DELETE /:id    → soft delete
 *
 * `panel_reports:read` to read, `:create` / `:update` / `:delete` to write.
 * Definitions are the project's: any member with the permission may change them.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { createPanelCustomEventSchema, updatePanelCustomEventSchema } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelCustomEvent } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { projectExists } from '../../services/saved-objects';
import {
  createCustomEvent,
  customEventEventData,
  DefinitionError,
  deleteCustomEvent,
  getCustomEvent,
  listCustomEvents,
  toCustomEventDto,
  updateCustomEvent,
} from '../../services/definitions';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const listQuery = z.object({ projectId: z.string().min(1).max(30) });

function publish(c: Ctx, row: PanelCustomEvent, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvent({ c, entityType: 'panel_custom_event', entityId: row.id, action, data: customEventEventData(row) });
}

function definitionFailure(c: Ctx, err: unknown): Response {
  if (err instanceof DefinitionError) {
    return err.status === 409 ? error.conflict(c, err.message) : error.badRequest(c, err.message, err.details);
  }
  throw err;
}

app.get('/', requirePermission('panel_reports:read'), zValidator('query', listQuery), async (c) => {
  const rows = await listCustomEvents(c.get('tenantDb'), c.req.valid('query').projectId);
  return list(c, rows.map(toCustomEventDto), cursorPagination(rows.length, false, null));
});

app.post('/', requirePermission('panel_reports:create'), zValidator('json', createPanelCustomEventSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  if (!(await projectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);

  let row: PanelCustomEvent;
  try {
    row = await createCustomEvent(db, input, userId);
  } catch (err) {
    return definitionFailure(c, err);
  }
  publish(c, row, 'created');
  return success(c, toCustomEventDto(row), 201);
});

app.get('/:id', requirePermission('panel_reports:read'), async (c) => {
  const id = c.req.param('id');
  const row = await getCustomEvent(c.get('tenantDb'), id);
  if (!row) return error.notFound(c, 'Custom event', id);
  return success(c, toCustomEventDto(row));
});

app.patch('/:id', requirePermission('panel_reports:update'), zValidator('json', updatePanelCustomEventSchema), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const existing = await getCustomEvent(db, id);
  if (!existing) return error.notFound(c, 'Custom event', id);

  let row: PanelCustomEvent | null;
  try {
    row = await updateCustomEvent(db, existing, c.req.valid('json'));
  } catch (err) {
    return definitionFailure(c, err);
  }
  if (!row) return error.notFound(c, 'Custom event', id);
  publish(c, row, 'updated');
  return success(c, toCustomEventDto(row));
});

app.delete('/:id', requirePermission('panel_reports:delete'), async (c) => {
  const id = c.req.param('id');
  const row = await deleteCustomEvent(c.get('tenantDb'), id);
  if (!row) return error.notFound(c, 'Custom event', id);
  publish(c, row, 'deleted');
  return noContent(c);
});

export default app;
