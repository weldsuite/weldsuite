/**
 * WeldDesk v2 saved-view routes — /api/desk/views/*.
 *
 * Views are an inbox feature layered on top of conversations — no dedicated
 * permission object exists (see .claude/welddesk-intercom-plan.md); this
 * reuses `conversations:*` the same way desk-conversations does.
 *
 * Ownership: create sets ownerId = current user. Update/delete are owner-only
 * (403 FORBIDDEN otherwise) — mirrors the ownerId-scoping pattern used by
 * other app-api routes for user-owned rows (see services/desk/views.ts).
 * List returns the caller's own views plus shared views owned by others.
 *
 * Entity events: `desk_view` (created/updated/deleted).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createDeskViewSchema,
  updateDeskViewSchema,
  listDeskViewsQuerySchema,
} from '@weldsuite/core-api-client/schemas/desk-views';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import {
  createDeskView,
  deleteDeskView,
  DeskViewForbiddenError,
  DeskViewNotFoundError,
  getDeskView,
  listDeskViews,
  updateDeskView,
} from '../../services/desk/views';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('conversations:read'), zValidator('query', listDeskViewsQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const { folder } = c.req.valid('query');
  try {
    const views = await listDeskViews(db, userId, { folder });
    return success(c, views);
  } catch (err) {
    console.error('[app-api/desk-views] list failed:', err);
    return error.internal(c, 'Failed to list views');
  }
});

app.post('/', requirePermission('conversations:create'), zValidator('json', createDeskViewSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json');
  try {
    const view = await createDeskView(db, userId, data);
    publishEntityEvent({
      c,
      entityType: 'desk_view',
      action: 'created',
      entityId: view.id,
      data: view as unknown as Record<string, unknown>,
    });
    return success(c, view, 201);
  } catch (err) {
    console.error('[app-api/desk-views] create failed:', err);
    return error.internal(c, 'Failed to create view');
  }
});

app.get('/:id', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const view = await getDeskView(db, id);
    if (!view) return error.notFound(c, 'View', id);
    return success(c, view);
  } catch (err) {
    console.error('[app-api/desk-views] get failed:', err);
    return error.internal(c, 'Failed to fetch view');
  }
});

app.patch('/:id', requirePermission('conversations:update'), zValidator('json', updateDeskViewSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const view = await updateDeskView(db, id, userId, data);
    publishEntityEvent({
      c,
      entityType: 'desk_view',
      action: 'updated',
      entityId: view.id,
      data: view as unknown as Record<string, unknown>,
    });
    return success(c, view);
  } catch (err) {
    if (err instanceof DeskViewNotFoundError) return error.notFound(c, 'View', id);
    if (err instanceof DeskViewForbiddenError) return error.forbidden(c, 'Only the view owner can update it');
    console.error('[app-api/desk-views] update failed:', err);
    return error.internal(c, 'Failed to update view');
  }
});

app.delete('/:id', requirePermission('conversations:delete'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const view = await getDeskView(db, id);
    if (!view) return error.notFound(c, 'View', id);
    await deleteDeskView(db, id, userId);
    publishEntityEvent({
      c,
      entityType: 'desk_view',
      action: 'deleted',
      entityId: view.id,
      data: view as unknown as Record<string, unknown>,
    });
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof DeskViewNotFoundError) return error.notFound(c, 'View', id);
    if (err instanceof DeskViewForbiddenError) return error.forbidden(c, 'Only the view owner can delete it');
    console.error('[app-api/desk-views] delete failed:', err);
    return error.internal(c, 'Failed to delete view');
  }
});

export const deskViewsRoutes = app;
