/**
 * Folders routes — /api/folders/*.
 *
 * Permissions: `folders:read | create | update | delete`.
 * Entity events: `folder:created | updated | deleted | moved`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  listFoldersQuery,
  createFolderSchema,
  updateFolderSchema,
} from '@weldsuite/core-api-client/schemas/folders';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import * as foldersService from '../../services/folders';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('folders:read'), zValidator('query', listFoldersQuery), async (c) => {
  const { parentId, all } = c.req.valid('query');
  try {
    const rows = await foldersService.listFolders(c.get('tenantDb'), {
      parentId: parentId ?? null,
      all,
    });
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/folders] list failed:', err);
    return error.internal(c, 'Failed to list folders');
  }
});

app.get('/:id', requirePermission('folders:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await foldersService.getFolder(c.get('tenantDb'), id);
    if (!row) return error.notFound(c, 'Folder', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/folders] get failed:', err);
    return error.internal(c, 'Failed to fetch folder');
  }
});

app.post('/', requirePermission('folders:create'), zValidator('json', createFolderSchema), async (c) => {
  const userId = c.get('userId') ?? null;
  try {
    const row = await foldersService.createFolder(c.get('tenantDb'), {
      ...c.req.valid('json'),
      createdById: userId,
    });
    publishEntityEvent({
      c,
      entityType: 'folder',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, name: row.name, parentId: row.parentId },
    });
    return success(c, row, 201);
  } catch (err) {
    console.error('[app-api/folders] create failed:', err);
    return error.internal(c, 'Failed to create folder');
  }
});

app.patch('/:id', requirePermission('folders:update'), zValidator('json', updateFolderSchema), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await foldersService.updateFolder(c.get('tenantDb'), id, c.req.valid('json'));
    if (!row) return error.notFound(c, 'Folder', id);
    publishEntityEvent({
      c,
      entityType: 'folder',
      entityId: row.id,
      action: 'updated',
      data: { id: row.id, name: row.name, parentId: row.parentId },
    });
    return success(c, row);
  } catch (err) {
    console.error('[app-api/folders] update failed:', err);
    return error.internal(c, 'Failed to update folder');
  }
});

app.delete('/:id', requirePermission('folders:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const deleted = await foldersService.softDeleteFolder(c.get('tenantDb'), id);
    if (!deleted) return error.notFound(c, 'Folder', id);
    publishEntityEvent({
      c,
      entityType: 'folder',
      entityId: id,
      action: 'deleted',
      data: { id, name: deleted.name, parentId: deleted.parentId },
    });
    return success(c, { deleted: true });
  } catch (err) {
    console.error('[app-api/folders] delete failed:', err);
    return error.internal(c, 'Failed to delete folder');
  }
});

export const foldersRoutes = app;
