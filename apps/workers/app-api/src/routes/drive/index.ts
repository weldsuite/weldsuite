/**
 * Drive cross-cutting routes — /api/drive/*.
 *
 * Views that span multiple modules:
 *   - GET  /all       cross-source unified file feed
 *   - GET  /stats     per-source counts
 *   - GET  /shared    files and folders teammates shared with the caller
 *   - GET  /trash     combined trashed files + folders
 *   - POST /trash/restore/file/:id, POST /trash/restore/folder/:id
 *   - DELETE /trash/file/:id, /trash/folder/:id, /trash/empty
 *
 * Permissions: `files:read` (views), `files:update | files:delete` (trash actions),
 * `folders:update | folders:delete` (folder trash actions). Drive files and
 * folders only show to, and only change for, callers the WeldDrive sharing
 * rules allow (`@weldsuite/core-domain/drive-access`).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { listAllFilesQuery } from '@weldsuite/core-api-client/schemas/drive';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import { deleteStoredObject } from '@weldsuite/worker-kit/storage';
import {
  aggregateAllFiles,
  aggregateStats,
  listPurgedFileKeys,
  normalizeGenericFiles,
  purgeTrashed,
  queryArray,
  type UnifiedFile,
} from '../../services/drive-aggregation';
import * as filesService from '@weldsuite/core-domain/files';
import {
  canEdit,
  fileRole,
  folderRole,
  listSharedWithUser,
  withFileAccess,
  withFolderAccess,
} from '@weldsuite/core-domain/drive-access';
import * as foldersService from '../../services/folders';
import { DRIVE_FOLDER_HOLDS_LOCKED_FILES, DRIVE_VIEW_ONLY, driveAccess } from '../../lib/drive-access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// GET /all
// ============================================================================

app.get('/all', requirePermission('files:read'), zValidator('query', listAllFilesQuery), async (c) => {
  const q = c.req.valid('query');
  try {
    const allFiles = await aggregateAllFiles(c.get('tenantDb'), {
      userId: c.get('userId'),
      source: q.source,
      r2PublicUrl: c.env.R2_PUBLIC_URL,
      apiOrigin: new URL(c.req.url).origin,
      driveAccess: await driveAccess(c),
    });

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
    const stats = await aggregateStats(c.get('tenantDb'), c.get('userId'), await driveAccess(c));
    return success(c, stats);
  } catch (err) {
    console.error('[app-api/drive] /stats failed:', err);
    return error.internal(c, 'Failed to get stats');
  }
});

// ============================================================================
// GET /shared — what teammates shared with the caller (Shared with me)
// ============================================================================

app.get('/shared', requirePermission('files:read'), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  try {
    const db = c.get('tenantDb');
    const [shared, access] = await Promise.all([listSharedWithUser(db, userId), driveAccess(c)]);
    const fileShares = new Map(shared.files.map((s) => [s.file.id, s]));
    const folderShares = new Map(shared.folders.map((s) => [s.folder.id, s]));
    const shareFields = (s: { role: string; sharedBy: string; sharedAt: Date }) => ({
      sharedRole: s.role,
      sharedBy: s.sharedBy,
      sharedAt: s.sharedAt.toISOString(),
    });
    const files = normalizeGenericFiles(
      withFileAccess(access, shared.files.map((s) => s.file)),
      c.env.R2_PUBLIC_URL,
      new URL(c.req.url).origin,
    ).map((f) => ({ ...f, ...shareFields(fileShares.get(f.id)!) }));
    const folders = withFolderAccess(access, shared.folders.map((s) => s.folder)).map((f) => ({
      ...f,
      ...shareFields(folderShares.get(f.id)!),
    }));
    return success(c, { files, folders });
  } catch (err) {
    console.error('[app-api/drive] /shared failed:', err);
    return error.internal(c, 'Failed to list shared items');
  }
});

// ============================================================================
// GET /trash — combined trashed files + folders the caller may see
// ============================================================================

app.get('/trash', requirePermission('files:read'), async (c) => {
  try {
    const db = c.get('tenantDb');
    const [trashedFiles, trashedFolders, access] = await Promise.all([
      filesService.listTrashedFiles(db),
      foldersService.listTrashedFolders(db),
      driveAccess(c),
    ]);
    return success(c, {
      files: withFileAccess(access, trashedFiles),
      folders: withFolderAccess(access, trashedFolders),
    });
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
    const db = c.get('tenantDb');
    const trashed = await filesService.getTrashedFile(db, id);
    if (!trashed) return error.notFound(c, 'File', id);
    const role = fileRole(await driveAccess(c), trashed);
    if (!role) return error.notFound(c, 'File', id);
    if (!canEdit(role)) return error.forbidden(c, DRIVE_VIEW_ONLY);
    const row = await filesService.restoreFile(db, id);
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
    const db = c.get('tenantDb');
    const trashed = await foldersService.getTrashedFolder(db, id);
    if (!trashed) return error.notFound(c, 'Folder', id);
    const role = folderRole(await driveAccess(c), trashed);
    if (!role) return error.notFound(c, 'Folder', id);
    if (!canEdit(role)) return error.forbidden(c, DRIVE_VIEW_ONLY);
    const row = await foldersService.restoreFolder(db, id);
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
    const db = c.get('tenantDb');
    const trashed = await filesService.getTrashedFile(db, id);
    if (!trashed) return error.notFound(c, 'File', id);
    const role = fileRole(await driveAccess(c), trashed);
    if (!role) return error.notFound(c, 'File', id);
    if (!canEdit(role)) return error.forbidden(c, DRIVE_VIEW_ONLY);
    const row = await filesService.purgeFile(db, id);
    if (!row) return error.notFound(c, 'File', id);

    const r2Key = row.fileKey || row.storagePath;
    if (r2Key) {
      await deleteStoredObject(c.env, r2Key).catch(() => {});
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
    const access = await driveAccess(c);
    const role = folderRole(access, loaded.folder);
    if (!role) return error.notFound(c, 'Folder', id);
    if (!canEdit(role)) return error.forbidden(c, DRIVE_VIEW_ONLY);
    // The purge takes every file in the folder for good, so it may not take
    // one the caller could not delete on its own (a restricted file another
    // member put in a folder the caller edits through general access).
    if (loaded.folderFiles.some((f) => !canEdit(fileRole(access, f)))) {
      return error.forbidden(c, DRIVE_FOLDER_HOLDS_LOCKED_FILES);
    }

    if (c.env.STORAGE || c.env.PRIVATE_STORAGE) {
      await Promise.all(
        loaded.folderFiles.map((f) => {
          const key = f.fileKey || f.storagePath;
          return key ? deleteStoredObject(c.env, key).catch(() => {}) : Promise.resolve();
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
// DELETE /trash/empty — purge every trashed item the caller may change
// ============================================================================

app.delete('/trash/empty', requirePermission('files:delete'), async (c) => {
  try {
    const db = c.get('tenantDb');
    const [trashedFiles, trashedFolders, access] = await Promise.all([
      filesService.listTrashedFiles(db),
      foldersService.listTrashedFolders(db),
      driveAccess(c),
    ]);
    const editableFolderIds = trashedFolders.filter((f) => canEdit(folderRole(access, f))).map((f) => f.id);
    // A folder goes with its files, so one holding a file the caller may not
    // change stays in the trash (see DELETE /trash/folder/:id).
    const locked = new Set(
      (await foldersService.listFilesInFolders(db, editableFolderIds))
        .filter((f) => !canEdit(fileRole(access, f)))
        .map((f) => f.folderId),
    );
    const ids = {
      fileIds: trashedFiles.filter((f) => canEdit(fileRole(access, f))).map((f) => f.id),
      folderIds: editableFolderIds.filter((id) => !locked.has(id)),
    };
    if (c.env.STORAGE || c.env.PRIVATE_STORAGE) {
      const keys = await listPurgedFileKeys(db, ids);
      await Promise.all(keys.map((k) => deleteStoredObject(c.env, k).catch(() => {})));
    }
    await purgeTrashed(db, ids);
    return success(c, { emptied: true });
  } catch (err) {
    console.error('[app-api/drive] empty trash failed:', err);
    return error.internal(c, 'Failed to empty trash');
  }
});

export const driveRoutes = app;
