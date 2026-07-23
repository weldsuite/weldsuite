/**
 * Drive cross-cutting routes — /api/drive/*.
 *
 * Views that span multiple modules:
 *   - GET  /all       cross-source unified file feed
 *   - GET  /stats     per-source counts
 *   - GET  /trash     combined trashed files + folders
 *   - POST /trash/restore/file/:id, POST /trash/restore/folder/:id
 *   - DELETE /trash/file/:id, /trash/folder/:id, /trash/empty
 *
 * Permissions: `files:read` (views), `files:update | files:delete` (trash actions),
 * `folders:update | folders:delete` (folder trash actions).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { listAllFilesQuery } from '@weldsuite/core-api-client/schemas/drive';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import {
  aggregateAllFiles,
  aggregateStats,
  emptyTrash as emptyTrashAggregator,
  listAllTrashedFileKeysForR2,
  queryArray,
  type UnifiedFile,
} from '../../services/drive-aggregation';
import * as filesService from '../../services/files';
import * as foldersService from '../../services/folders';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// GET /all
// ============================================================================

app.get('/all', requirePermission('files:read'), zValidator('query', listAllFilesQuery), async (c) => {
  const q = c.req.valid('query');
  try {
    const allFiles = await aggregateAllFiles(c.get('tenantDb'), { source: q.source, r2PublicUrl: c.env.R2_PUBLIC_URL });

    const filters: Record<string, unknown> = {};
    if (q.type) filters.fileType = q.type;

    const { items, pagination } = queryArray<UnifiedFile>(allFiles, {
      page: q.page ?? 1,
      pageSize: q.pageSize ?? 30,
      search: q.search,
      searchFields: ['name'],
      sortBy: (q.sortBy ?? 'createdAt') as keyof UnifiedFile,
      sortOrder: q.sortOrder ?? 'desc',
      filters,
    });

    const byType: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const f of allFiles) {
      byType[f.fileType] = (byType[f.fileType] || 0) + 1;
      bySource[f.source] = (bySource[f.source] || 0) + 1;
    }

    return c.json({
      success: true,
      data: items,
      pagination,
      summary: { totalFiles: allFiles.length, byType, bySource },
    });
  } catch (err) {
    console.error('[app-api/drive] /all failed:', err);
    return error.internal(c, 'Failed to fetch files');
  }
});

// ============================================================================
// GET /stats
// ============================================================================

app.get('/stats', requirePermission('files:read'), async (c) => {
  try {
    const stats = await aggregateStats(c.get('tenantDb'));
    return success(c, stats);
  } catch (err) {
    console.error('[app-api/drive] /stats failed:', err);
    return error.internal(c, 'Failed to get stats');
  }
});

// ============================================================================
// GET /trash — combined trashed files + folders
// ============================================================================

app.get('/trash', requirePermission('files:read'), async (c) => {
  try {
    const db = c.get('tenantDb');
    const [trashedFiles, trashedFolders] = await Promise.all([
      filesService.listTrashedFiles(db),
      foldersService.listTrashedFolders(db),
    ]);
    return success(c, { files: trashedFiles, folders: trashedFolders });
  } catch (err) {
    console.error('[app-api/drive] /trash failed:', err);
    return error.internal(c, 'Failed to list trash');
  }
});

// ============================================================================
// POST /trash/restore/file/:id
// ============================================================================

app.post('/trash/restore/file/:id', requirePermission('files:update'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await filesService.restoreFile(c.get('tenantDb'), id);
    if (!row) return error.notFound(c, 'File', id);
    publishEntityEvent({
      c,
      entityType: 'file',
      entityId: id,
      action: 'restored',
      data: { id, name: row.fileName, folderId: row.folderId },
    });
    return success(c, { restored: true });
  } catch (err) {
    console.error('[app-api/drive] restore file failed:', err);
    return error.internal(c, 'Failed to restore file');
  }
});

// ============================================================================
// POST /trash/restore/folder/:id
// ============================================================================

app.post('/trash/restore/folder/:id', requirePermission('folders:update'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await foldersService.restoreFolder(c.get('tenantDb'), id);
    if (!row) return error.notFound(c, 'Folder', id);
    publishEntityEvent({
      c,
      entityType: 'folder',
      entityId: id,
      action: 'restored',
      data: { id, name: row.name, parentId: row.parentId },
    });
    return success(c, { restored: true });
  } catch (err) {
    console.error('[app-api/drive] restore folder failed:', err);
    return error.internal(c, 'Failed to restore folder');
  }
});

// ============================================================================
// DELETE /trash/file/:id — purge from R2 + DB
// ============================================================================

app.delete('/trash/file/:id', requirePermission('files:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await filesService.purgeFile(c.get('tenantDb'), id);
    if (!row) return error.notFound(c, 'File', id);

    const r2Key = row.fileKey || row.storagePath;
    if (r2Key && c.env.STORAGE) {
      await c.env.STORAGE.delete(r2Key).catch(() => {});
    }

    publishEntityEvent({
      c,
      entityType: 'file',
      entityId: id,
      action: 'purged',
      data: { id, name: row.fileName },
    });
    return success(c, { deleted: true });
  } catch (err) {
    console.error('[app-api/drive] purge file failed:', err);
    return error.internal(c, 'Failed to permanently delete file');
  }
});

// ============================================================================
// DELETE /trash/folder/:id — purge folder + contained files from R2 + DB
// ============================================================================

app.delete('/trash/folder/:id', requirePermission('folders:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const loaded = await foldersService.loadFolderFilesForPurge(db, id);
    if (!loaded) return error.notFound(c, 'Folder', id);

    if (c.env.STORAGE) {
      await Promise.all(
        loaded.folderFiles.map((f) => {
          const key = f.fileKey || f.storagePath;
          return key ? c.env.STORAGE!.delete(key).catch(() => {}) : Promise.resolve();
        }),
      );
    }
    await foldersService.purgeFolder(db, id);

    publishEntityEvent({
      c,
      entityType: 'folder',
      entityId: id,
      action: 'purged',
      data: { id, name: loaded.folder.name, parentId: loaded.folder.parentId },
    });
    return success(c, { deleted: true });
  } catch (err) {
    console.error('[app-api/drive] purge folder failed:', err);
    return error.internal(c, 'Failed to permanently delete folder');
  }
});

// ============================================================================
// DELETE /trash/empty
// ============================================================================

app.delete('/trash/empty', requirePermission('files:delete'), async (c) => {
  try {
    const db = c.get('tenantDb');
    if (c.env.STORAGE) {
      const keys = await listAllTrashedFileKeysForR2(db);
      await Promise.all(keys.map((k) => c.env.STORAGE!.delete(k).catch(() => {})));
    }
    await emptyTrashAggregator(db);
    return success(c, { emptied: true });
  } catch (err) {
    console.error('[app-api/drive] empty trash failed:', err);
    return error.internal(c, 'Failed to empty trash');
  }
});

export const driveRoutes = app;
