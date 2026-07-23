/**
 * Files routes — /api/files/*.
 *
 * Drive-native file store. Permissions: `files:read | create | update | delete`.
 * Entity events: `file:created | updated | deleted | moved | starred`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  listFilesQuery,
  createFileSchema,
  updateFileSchema,
  moveFileSchema,
} from '@weldsuite/core-api-client/schemas/files';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import * as filesService from '../../services/files';
import { normalizeGenericFiles, queryArray, type UnifiedFile } from '../../services/drive-aggregation';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// GET / — list files in the drive store (with in-memory pagination over the
// unified shape, mirroring legacy `/drive/files` behaviour)
// ============================================================================

app.get('/', requirePermission('files:read'), zValidator('query', listFilesQuery), async (c) => {
  const q = c.req.valid('query');
  const folderIdRaw = c.req.query('folderId');
  const folderId = q.folderId || null;
  const rootOnly = folderIdRaw === '';
  try {
    const rows = await filesService.listFiles(c.get('tenantDb'), {
      folderId,
      rootOnly,
      type: q.type,
    });
    const normalized = normalizeGenericFiles(rows, c.env.R2_PUBLIC_URL);
    const { items, pagination } = queryArray<UnifiedFile>(normalized, {
      page: q.page ?? 1,
      pageSize: q.pageSize ?? 30,
      search: q.search,
      searchFields: ['name'],
      sortBy: (q.sortBy ?? 'createdAt') as keyof UnifiedFile,
      sortOrder: q.sortOrder ?? 'desc',
    });
    return c.json({ success: true, data: items, pagination });
  } catch (err) {
    console.error('[app-api/files] list failed:', err);
    return error.internal(c, 'Failed to list files');
  }
});

// ============================================================================
// GET /:id
// ============================================================================

app.get('/:id', requirePermission('files:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await filesService.getFile(c.get('tenantDb'), id);
    if (!row) return error.notFound(c, 'File', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/files] get failed:', err);
    return error.internal(c, 'Failed to fetch file');
  }
});

// ============================================================================
// POST /
// ============================================================================

app.post('/', requirePermission('files:create'), zValidator('json', createFileSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  try {
    const row = await filesService.createFile(c.get('tenantDb'), {
      ...c.req.valid('json'),
      uploadedById: userId,
    });
    publishEntityEvent({
      c,
      entityType: 'file',
      entityId: row.id,
      action: 'created',
      data: {
        id: row.id,
        name: row.fileName,
        folderId: row.folderId,
        fileType: row.fileType,
        fileSize: row.fileSize,
        mimeType: row.mimeType,
      },
    });
    return success(c, row, 201);
  } catch (err) {
    console.error('[app-api/files] create failed:', err);
    return error.internal(c, 'Failed to create file');
  }
});

// ============================================================================
// PATCH /:id
// ============================================================================

app.patch('/:id', requirePermission('files:update'), zValidator('json', updateFileSchema), async (c) => {
  const id = c.req.param('id');
  try {
    const result = await filesService.updateFile(c.get('tenantDb'), id, c.req.valid('json'));
    if (!result.ok) {
      if (result.reason === 'not_found') return error.notFound(c, 'File', id);
      if (result.reason === 'name_conflict') {
        return c.json(
          { success: false, error: 'A file with this name already exists in this folder' },
          409,
        );
      }
    } else {
      publishEntityEvent({
        c,
        entityType: 'file',
        entityId: result.row.id,
        action: 'updated',
        data: {
          id: result.row.id,
          name: result.row.fileName,
          folderId: result.row.folderId,
          fileType: result.row.fileType,
          fileSize: result.row.fileSize,
        },
      });
      return success(c, result.row);
    }
  } catch (err) {
    console.error('[app-api/files] update failed:', err);
    return error.internal(c, 'Failed to update file');
  }
});

// ============================================================================
// DELETE /:id — soft delete + schedule 30-day purge workflow
// ============================================================================

app.delete('/:id', requirePermission('files:delete'), async (c) => {
  const id = c.req.param('id');
  const workspaceId = c.get('workspaceId') || c.get('orgId');
  if (!workspaceId) return error.orgRequired(c);
  try {
    const result = await filesService.softDeleteFile(c.get('tenantDb'), id);
    if (!result.ok) return error.notFound(c, 'File', id);

    // Schedule the 30-day purge workflow (TrashCleanupWorkflow, hosted in
    // this worker under the trash-cleanup-v2* names since W4).
    if (c.env.TRASH_CLEANUP) {
      await c.env.TRASH_CLEANUP.create({
        id: `trash-${id}-${result.deletedAt.getTime()}`,
        params: {
          workspaceId,
          fileId: id,
          fileKey: result.row.fileKey || result.row.storagePath,
          deletedAt: result.deletedAt.toISOString(),
          purgeAt: result.purgeAt.toISOString(),
        },
      }).catch((err) => {
        console.error('[app-api/files] Failed to schedule trash cleanup workflow:', err);
      });
    }

    publishEntityEvent({
      c,
      entityType: 'file',
      entityId: id,
      action: 'deleted',
      data: {
        id,
        name: result.row.fileName,
        folderId: result.row.folderId,
        fileType: result.row.fileType,
        fileSize: result.row.fileSize,
      },
    });
    return success(c, { deleted: true });
  } catch (err) {
    console.error('[app-api/files] delete failed:', err);
    return error.internal(c, 'Failed to delete file');
  }
});

// ============================================================================
// POST /:id/star — toggle
// ============================================================================

app.post('/:id/star', requirePermission('files:update'), async (c) => {
  const id = c.req.param('id');
  try {
    const result = await filesService.toggleStar(c.get('tenantDb'), id);
    if (!result) return error.notFound(c, 'File', id);
    publishEntityEvent({
      c,
      entityType: 'file',
      entityId: id,
      action: 'starred',
      data: {
        id,
        name: result.row.fileName,
        folderId: result.row.folderId,
      },
    });
    return success(c, { isStarred: result.isStarred });
  } catch (err) {
    console.error('[app-api/files] star failed:', err);
    return error.internal(c, 'Failed to toggle star');
  }
});

// ============================================================================
// POST /:id/pin — toggle (workspace-wide)
// ============================================================================

app.post('/:id/pin', requirePermission('files:update'), async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  try {
    const result = await filesService.togglePin(c.get('tenantDb'), id, userId);
    if (!result) return error.notFound(c, 'File', id);
    publishEntityEvent({
      c,
      entityType: 'file',
      entityId: id,
      action: 'pinned',
      data: {
        id,
        name: result.row.fileName,
        folderId: result.row.folderId,
        isPinned: result.isPinned,
      },
    });
    return success(c, { isPinned: result.isPinned });
  } catch (err) {
    console.error('[app-api/files] pin failed:', err);
    return error.internal(c, 'Failed to toggle pin');
  }
});

// ============================================================================
// GET /:id/content — stream the R2 object body
// ============================================================================

app.get('/:id/content', requirePermission('files:read'), async (c) => {
  const id = c.req.param('id');
  const wantsDownload = c.req.query('download') === '1';
  try {
    const row = await filesService.getFile(c.get('tenantDb'), id);
    if (!row) return error.notFound(c, 'File', id);
    if (!c.env.STORAGE) return error.internal(c, 'Storage is not configured');
    const key = row.fileKey || row.storagePath;
    if (!key) return error.notFound(c, 'File content', id);
    const obj = await c.env.STORAGE.get(key);
    if (!obj) return error.notFound(c, 'File content', id);
    const headers: Record<string, string> = {
      'Content-Type': row.mimeType || obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Cache-Control': 'private, no-cache',
    };
    if (wantsDownload) {
      const safeName = (row.fileName || `file-${id}`).replace(/"/g, '');
      const encoded = encodeURIComponent(safeName);
      headers['Content-Disposition'] = `attachment; filename="${safeName}"; filename*=UTF-8''${encoded}`;
    }
    return new Response(obj.body, { headers });
  } catch (err) {
    console.error('[app-api/files] content GET failed:', err);
    return error.internal(c, 'Failed to read file content');
  }
});

// ============================================================================
// PUT /:id/content — overwrite the R2 object at the existing fileKey
// (used by the WeldFlow spreadsheet editor's debounced auto-save)
// ============================================================================

app.put('/:id/content', requirePermission('files:update'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await filesService.getFile(c.get('tenantDb'), id);
    if (!row) return error.notFound(c, 'File', id);
    if (!c.env.STORAGE) return error.internal(c, 'Storage is not configured');
    const key = row.fileKey || row.storagePath;
    if (!key) return error.internal(c, 'File has no storage key');
    const body = await c.req.arrayBuffer();
    await c.env.STORAGE.put(key, body, {
      httpMetadata: { contentType: row.mimeType || 'application/octet-stream' },
    });
    const updated = await filesService.touchFileSize(c.get('tenantDb'), id, body.byteLength);
    publishEntityEvent({
      c,
      entityType: 'file',
      entityId: id,
      action: 'updated',
      data: {
        id,
        name: row.fileName,
        folderId: row.folderId,
        fileType: row.fileType,
        fileSize: body.byteLength,
      },
    });
    return success(c, updated ?? row);
  } catch (err) {
    console.error('[app-api/files] content PUT failed:', err);
    return error.internal(c, 'Failed to write file content');
  }
});

// ============================================================================
// POST /:id/move
// ============================================================================

app.post('/:id/move', requirePermission('files:update'), zValidator('json', moveFileSchema), async (c) => {
  const id = c.req.param('id');
  const { folderId } = c.req.valid('json');
  try {
    const result = await filesService.moveFile(c.get('tenantDb'), id, folderId);
    if (!result.ok) {
      if (result.reason === 'not_found_file') return error.notFound(c, 'File', id);
      if (result.reason === 'not_found_folder') return error.notFound(c, 'Folder', folderId ?? '');
      if (result.reason === 'name_conflict') {
        return c.json(
          { success: false, error: 'A file with this name already exists in this folder' },
          409,
        );
      }
    } else {
      publishEntityEvent({
        c,
        entityType: 'file',
        entityId: id,
        action: 'moved',
        data: { id, name: result.row.fileName, folderId },
      });
      return success(c, { moved: true, folderId });
    }
  } catch (err) {
    console.error('[app-api/files] move failed:', err);
    return error.internal(c, 'Failed to move file');
  }
});

export const filesRoutes = app;
