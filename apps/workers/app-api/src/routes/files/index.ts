/**
 * Files routes — /api/files/*.
 *
 * Drive-native file store. Permissions: `files:read | create | update | delete`
 * open the door; which files a caller sees, and whether they may change them,
 * follows the WeldDrive sharing rules (`@weldsuite/core-domain/drive-access`).
 * A file the caller cannot see is a 404.
 * Entity events: `file:created | updated | deleted | moved | starred | pinned | shared | unshared`.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { computeChanges, publishEntityEvent } from '@weldsuite/entity-events';
import {
  listFilesQuery,
  createFileSchema,
  updateDriveFileSchema,
  moveFileSchema,
} from '@weldsuite/core-api-client/schemas/files';
import { shareDriveItemSchema } from '@weldsuite/core-api-client/schemas/drive-shares';
import { tagsToSpaces } from '@weldsuite/text';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import * as filesService from '@weldsuite/core-domain/files';
import {
  canEdit,
  containerRole,
  describeSharing,
  fileRole,
  isModuleFile,
  isShareableMember,
  removeShare,
  upsertShare,
  withFileAccess,
  type DriveAccessIndex,
  type DriveRole,
} from '@weldsuite/core-domain/drive-access';
import { normalizeGenericFiles, queryArray, type UnifiedFile } from '../../services/drive-aggregation';
import { DRIVE_MODULE_FILE, DRIVE_VIEW_ONLY, driveAccess } from '../../lib/drive-access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
type FilesContext = Context<{ Bindings: Env; Variables: Variables }>;

type FileRow = NonNullable<Awaited<ReturnType<typeof filesService.getFile>>>;

interface OpenedFile {
  row: FileRow;
  access: DriveAccessIndex;
  role: DriveRole;
}

/**
 * Load a live file and the caller's role on it; `edit` also needs owner or
 * editor. Answers the error response instead when the file is missing or
 * hidden (404) or only viewable (403).
 */
async function openFile(c: FilesContext, id: string, mode: 'view' | 'edit'): Promise<OpenedFile | Response> {
  const row = await filesService.getFile(c.get('tenantDb'), id);
  if (!row) return error.notFound(c, 'File', id);
  const access = await driveAccess(c);
  const role = fileRole(access, row);
  if (!role) return error.notFound(c, 'File', id);
  if (mode === 'edit' && !canEdit(role)) return error.forbidden(c, DRIVE_VIEW_ONLY);
  return { row, access, role };
}

/** The error response, unless the caller may put a file in `folderId` (null: My Drive). */
function checkDestination(c: FilesContext, access: DriveAccessIndex, folderId: string | null | undefined): Response | null {
  if (!folderId) return null;
  const role = containerRole(access, folderId);
  if (!role) return error.notFound(c, 'Folder', folderId);
  return canEdit(role) ? null : error.forbidden(c, DRIVE_VIEW_ONLY);
}

/** Who an opened file is open to, for the Share dialog. */
function fileSharing(c: FilesContext, { row, access, role }: OpenedFile) {
  return describeSharing(
    c.get('tenantDb'),
    access,
    { kind: 'file', id: row.id, ownerId: row.uploadedById, generalAccess: row.generalAccess, parentId: row.folderId },
    role,
  );
}

/**
 * The fields a file's activity shows as "from → to". The description is
 * rich text, so it goes in as a short plain-text excerpt.
 */
function trackedFileFields(row: FileRow): Record<string, unknown> {
  const description = filesService.fileDescription(row);
  return {
    name: row.fileName,
    isStarred: row.isStarred,
    isPublic: row.isPublic,
    generalAccess: row.generalAccess,
    description: description ? tagsToSpaces(description).replaceAll(/\s+/g, ' ').trim().slice(0, 200) : null,
  };
}

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
    const [rows, access] = await Promise.all([
      filesService.listFiles(c.get('tenantDb'), {
        folderId,
        rootOnly,
        type: q.type,
        entityType: q.entityType,
        entityId: q.entityId,
      }),
      driveAccess(c),
    ]);
    const normalized = normalizeGenericFiles(withFileAccess(access, rows), c.env.R2_PUBLIC_URL);
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
    const opened = await openFile(c, id, 'view');
    if (opened instanceof Response) return opened;
    const [row] = withFileAccess(opened.access, [opened.row]);
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
  const body = c.req.valid('json');
  try {
    const denied = checkDestination(c, await driveAccess(c), body.folderId);
    if (denied) return denied;
    const row = await filesService.createFile(c.get('tenantDb'), {
      ...body,
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

app.patch('/:id', requirePermission('files:update'), zValidator('json', updateDriveFileSchema), async (c) => {
  const id = c.req.param('id');
  const body = c.req.valid('json');
  try {
    const opened = await openFile(c, id, 'edit');
    if (opened instanceof Response) return opened;
    if (body.folderId !== undefined && body.folderId !== opened.row.folderId) {
      const denied = checkDestination(c, opened.access, body.folderId);
      if (denied) return denied;
    }
    if (body.generalAccess !== undefined && isModuleFile(opened.row)) {
      return error.badRequest(c, DRIVE_MODULE_FILE);
    }
    const result = await filesService.updateFile(c.get('tenantDb'), id, body);
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
        // e.g. name 'E2E image.png' → 'E2E renamed', shown in the file's activity
        changes: computeChanges(trackedFileFields(result.previous), trackedFileFields(result.row)),
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
    const opened = await openFile(c, id, 'edit');
    if (opened instanceof Response) return opened;
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
    const opened = await openFile(c, id, 'view');
    if (opened instanceof Response) return opened;
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
    // The pin shows for the whole workspace, so it is a change to the file.
    const opened = await openFile(c, id, 'edit');
    if (opened instanceof Response) return opened;
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
    const opened = await openFile(c, id, 'view');
    if (opened instanceof Response) return opened;
    const { row } = opened;
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
      const safeName = (row.fileName || `file-${id}`).replaceAll('"', '');
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
    const opened = await openFile(c, id, 'edit');
    if (opened instanceof Response) return opened;
    const { row } = opened;
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
    const opened = await openFile(c, id, 'edit');
    if (opened instanceof Response) return opened;
    const denied = checkDestination(c, opened.access, folderId);
    if (denied) return denied;
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

// ============================================================================
// Sharing — /:id/shares
// ============================================================================

app.get('/:id/shares', requirePermission('files:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const opened = await openFile(c, id, 'view');
    if (opened instanceof Response) return opened;
    if (isModuleFile(opened.row)) return error.badRequest(c, DRIVE_MODULE_FILE);
    return success(c, await fileSharing(c, opened));
  } catch (err) {
    console.error('[app-api/files] sharing failed:', err);
    return error.internal(c, 'Failed to load sharing');
  }
});

/** Share the file with a teammate, or change their role. Owner and editors only. */
app.put('/:id/shares/:userId', requirePermission('files:update'), zValidator('json', shareDriveItemSchema), async (c) => {
  const id = c.req.param('id');
  const targetUserId = c.req.param('userId');
  const { role } = c.req.valid('json');
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  try {
    const db = c.get('tenantDb');
    const opened = await openFile(c, id, 'edit');
    if (opened instanceof Response) return opened;
    const { row } = opened;
    if (isModuleFile(row)) return error.badRequest(c, DRIVE_MODULE_FILE);
    if (targetUserId === userId) return error.badRequest(c, 'You cannot share a file with yourself');
    if (targetUserId === row.uploadedById) return error.badRequest(c, 'The owner already has access to this file');
    if (!(await isShareableMember(db, targetUserId))) {
      return error.badRequest(c, 'Files can only be shared with active members of this workspace');
    }
    const { previousRole } = await upsertShare(db, { kind: 'file', id }, { userId: targetUserId, role, sharedBy: userId });
    publishEntityEvent({
      c,
      entityType: 'file',
      entityId: id,
      action: 'shared',
      data: { id, name: row.fileName, folderId: row.folderId, userId: targetUserId, role, previousRole },
    });
    return success(c, await fileSharing(c, opened));
  } catch (err) {
    console.error('[app-api/files] share failed:', err);
    return error.internal(c, 'Failed to share file');
  }
});

/**
 * Stop sharing the file with a teammate. Owner and editors may remove anyone;
 * anyone may remove themselves (leave a file shared with them). Answers the
 * updated sharing, or null once the caller can no longer see the file.
 */
app.delete('/:id/shares/:userId', requirePermission('files:read'), async (c) => {
  const id = c.req.param('id');
  const targetUserId = c.req.param('userId');
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  try {
    const leaving = targetUserId === userId;
    const opened = await openFile(c, id, leaving ? 'view' : 'edit');
    if (opened instanceof Response) return opened;
    if (!leaving && !(await hasContextPermission(c, 'files:update'))) {
      return error.forbidden(c, 'Missing permission: files:update');
    }
    const removedRole = await removeShare(c.get('tenantDb'), { kind: 'file', id }, targetUserId);
    if (!removedRole) return error.notFound(c, 'Share', targetUserId);
    publishEntityEvent({
      c,
      entityType: 'file',
      entityId: id,
      action: 'unshared',
      data: { id, name: opened.row.fileName, folderId: opened.row.folderId, userId: targetUserId, role: removedRole },
    });
    const after = await openFile(c, id, 'view');
    return success(c, after instanceof Response ? null : await fileSharing(c, after));
  } catch (err) {
    console.error('[app-api/files] unshare failed:', err);
    return error.internal(c, 'Failed to stop sharing file');
  }
});

export const filesRoutes = app;
