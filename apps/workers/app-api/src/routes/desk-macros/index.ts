/**
 * WeldDesk v2 macro routes — /api/desk/macros/*.
 *
 * Macros are a small collection (saved replies + bundled actions) — plain
 * array response, no cursor pagination. Archive-on-delete, never hard-delete
 * (mirrors desk-teams). `apply-macro` (executing a macro against a specific
 * conversation) lives on the desk-conversations route — see
 * routes/desk-conversations/index.ts POST /:id/apply-macro — since it needs
 * the conversation id in the path and already imports the parts service.
 *
 * Permissions: the dedicated `macros` object.
 * Entity events: `desk_macro` (created/updated/deleted).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createDeskMacroSchema,
  updateDeskMacroSchema,
  listDeskMacrosQuerySchema,
} from '@weldsuite/core-api-client/schemas/desk-macros';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import {
  archiveDeskMacro,
  createDeskMacro,
  DeskMacroNotFoundError,
  getDeskMacro,
  listDeskMacros,
  updateDeskMacro,
} from '../../services/desk/macros';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('macros:read'), zValidator('query', listDeskMacrosQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const { archived, teamId } = c.req.valid('query');
  try {
    const macros = await listDeskMacros(db, { archived, teamId });
    return success(c, macros);
  } catch (err) {
    console.error('[app-api/desk-macros] list failed:', err);
    return error.internal(c, 'Failed to list macros');
  }
});

app.post('/', requirePermission('macros:create'), zValidator('json', createDeskMacroSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json');
  try {
    const macro = await createDeskMacro(db, userId, data);
    publishEntityEvent({
      c,
      entityType: 'desk_macro',
      action: 'created',
      entityId: macro.id,
      data: macro as unknown as Record<string, unknown>,
    });
    return success(c, macro, 201);
  } catch (err) {
    console.error('[app-api/desk-macros] create failed:', err);
    return error.internal(c, 'Failed to create macro');
  }
});

app.get('/:id', requirePermission('macros:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const macro = await getDeskMacro(db, id);
    if (!macro) return error.notFound(c, 'Macro', id);
    return success(c, macro);
  } catch (err) {
    console.error('[app-api/desk-macros] get failed:', err);
    return error.internal(c, 'Failed to fetch macro');
  }
});

app.patch('/:id', requirePermission('macros:update'), zValidator('json', updateDeskMacroSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const macro = await updateDeskMacro(db, id, data);
    publishEntityEvent({
      c,
      entityType: 'desk_macro',
      action: 'updated',
      entityId: macro.id,
      data: macro as unknown as Record<string, unknown>,
    });
    return success(c, macro);
  } catch (err) {
    if (err instanceof DeskMacroNotFoundError) return error.notFound(c, 'Macro', id);
    console.error('[app-api/desk-macros] update failed:', err);
    return error.internal(c, 'Failed to update macro');
  }
});

app.delete('/:id', requirePermission('macros:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const macro = await archiveDeskMacro(db, id);
    publishEntityEvent({
      c,
      entityType: 'desk_macro',
      action: 'deleted',
      entityId: macro.id,
      data: macro as unknown as Record<string, unknown>,
    });
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof DeskMacroNotFoundError) return error.notFound(c, 'Macro', id);
    console.error('[app-api/desk-macros] archive failed:', err);
    return error.internal(c, 'Failed to archive macro');
  }
});

export const deskMacrosRoutes = app;
