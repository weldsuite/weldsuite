/**
 * Folders routes — /api/folders/*.
 *
 * Permissions: `folders:read | create | update | delete` open the door;
 * which folders a caller sees, and whether they may change them, follows the
 * WeldDrive sharing rules (`@weldsuite/core-domain/drive-access`). A folder's
 * sharing reaches everything in it. A folder the caller cannot see is a 404.
 * Entity events: `folder:created | updated | deleted | shared | unshared`.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  listFoldersQuery,
  createFolderSchema,
  updateDriveFolderSchema,
} from '@weldsuite/core-api-client/schemas/folders';
import { shareDriveItemSchema } from '@weldsuite/core-api-client/schemas/drive-shares';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import { checkFolderParent, FOLDER_PARENT_ERRORS } from '@weldsuite/core-domain/folders';
import {
  canEdit,
  containerRole,
  describeSharing,
  folderRole,
  isShareableMember,
  removeShare,
  upsertShare,
  withFolderAccess,
  type DriveAccessIndex,
  type DriveRole,
} from '@weldsuite/core-domain/drive-access';
import * as foldersService from '../../services/folders';
import { DRIVE_VIEW_ONLY, driveAccess } from '../../lib/drive-access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
type FoldersContext = Context<{ Bindings: Env; Variables: Variables }>;

type FolderRow = NonNullable<Awaited<ReturnType<typeof foldersService.getFolder>>>;

interface OpenedFolder {
  row: FolderRow;
  access: DriveAccessIndex;
  role: DriveRole;
}

/**
 * Load a live folder and the caller's role on it; `edit` also needs owner
 * or editor. Answers the error response instead when the folder is missing
 * or hidden (404) or only viewable (403).
 */
async function openFolder(c: FoldersContext, id: string, mode: 'view' | 'edit'): Promise<OpenedFolder | Response> {
  const row = await foldersService.getFolder(c.get('tenantDb'), id);
  if (!row) return error.notFound(c, 'Folder', id);
  const access = await driveAccess(c);
  const role = folderRole(access, row);
  if (!role) return error.notFound(c, 'Folder', id);
  if (mode === 'edit' && !canEdit(role)) return error.forbidden(c, DRIVE_VIEW_ONLY);
  return { row, access, role };
}

/** The error response, unless the caller may put a folder under `parentId` (null: My Drive). */
function checkDestination(c: FoldersContext, access: DriveAccessIndex, parentId: string | null | undefined): Response | null {
  if (!parentId) return null;
  const role = containerRole(access, parentId);
  if (!role) return error.notFound(c, 'Folder', parentId);
  return canEdit(role) ? null : error.forbidden(c, DRIVE_VIEW_ONLY);
}

/** Who an opened folder is open to, for the Share dialog. */
function folderSharing(c: FoldersContext, { row, access, role }: OpenedFolder) {
  return describeSharing(
    c.get('tenantDb'),
    access,
    { kind: 'folder', id: row.id, ownerId: row.createdById, generalAccess: row.generalAccess, parentId: row.parentId },
    role,
  );
}

app.get('/', requirePermission('folders:read'), zValidator('query', listFoldersQuery), async (c) => {
  const { parentId, all } = c.req.valid('query');
  try {
    const [rows, access] = await Promise.all([
      foldersService.listFolders(c.get('tenantDb'), { parentId: parentId ?? null, all }),
      driveAccess(c),
    ]);
    return success(c, withFolderAccess(access, rows));
  } catch (err) {
    console.error('[app-api/folders] list failed:', err);
    return error.internal(c, 'Failed to list folders');
  }
});

app.get('/:id', requirePermission('folders:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const opened = await openFolder(c, id, 'view');
    if (opened instanceof Response) return opened;
    const [row] = withFolderAccess(opened.access, [opened.row]);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/folders] get failed:', err);
    return error.internal(c, 'Failed to fetch folder');
  }
});

app.post('/', requirePermission('folders:create'), zValidator('json', createFolderSchema), async (c) => {
  const userId = c.get('userId') ?? null;
  const body = c.req.valid('json');
  try {
    const db = c.get('tenantDb');
    const parentCheck = await checkFolderParent(db, null, body.parentId);
    if (parentCheck !== 'ok') return error.badRequest(c, FOLDER_PARENT_ERRORS[parentCheck]);
    const denied = checkDestination(c, await driveAccess(c), body.parentId);
    if (denied) return denied;
    const row = await foldersService.createFolder(db, {
      ...body,
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

app.patch('/:id', requirePermission('folders:update'), zValidator('json', updateDriveFolderSchema), async (c) => {
  const id = c.req.param('id');
  const body = c.req.valid('json');
  try {
    const db = c.get('tenantDb');
    const opened = await openFolder(c, id, 'edit');
    if (opened instanceof Response) return opened;
    // A parent inside the folder would cut it and its contents off from My Drive.
    const parentCheck = await checkFolderParent(db, id, body.parentId);
    if (parentCheck !== 'ok') return error.badRequest(c, FOLDER_PARENT_ERRORS[parentCheck]);
    if (body.parentId !== undefined && body.parentId !== opened.row.parentId) {
      const denied = checkDestination(c, opened.access, body.parentId);
      if (denied) return denied;
    }
    const row = await foldersService.updateFolder(db, id, body);
    if (!row) return error.notFound(c, 'Folder', id);
    publishEntityEvent({
      c,
      entityType: 'folder',
      entityId: row.id,
      action: 'updated',
      data: { id: row.id, name: row.name, parentId: row.parentId, generalAccess: row.generalAccess },
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
    const opened = await openFolder(c, id, 'edit');
    if (opened instanceof Response) return opened;
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

// ============================================================================
// Sharing — /:id/shares (reaches everything in the folder)
// ============================================================================

app.get('/:id/shares', requirePermission('folders:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const opened = await openFolder(c, id, 'view');
    if (opened instanceof Response) return opened;
    return success(c, await folderSharing(c, opened));
  } catch (err) {
    console.error('[app-api/folders] sharing failed:', err);
    return error.internal(c, 'Failed to load sharing');
  }
});

/** Share the folder with a teammate, or change their role. Owner and editors only. */
app.put('/:id/shares/:userId', requirePermission('folders:update'), zValidator('json', shareDriveItemSchema), async (c) => {
  const id = c.req.param('id');
  const targetUserId = c.req.param('userId');
  const { role } = c.req.valid('json');
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  try {
    const db = c.get('tenantDb');
    const opened = await openFolder(c, id, 'edit');
    if (opened instanceof Response) return opened;
    const { row } = opened;
    if (targetUserId === userId) return error.badRequest(c, 'You cannot share a folder with yourself');
    if (targetUserId === row.createdById) return error.badRequest(c, 'The owner already has access to this folder');
    if (!(await isShareableMember(db, targetUserId))) {
      return error.badRequest(c, 'Folders can only be shared with active members of this workspace');
    }
    const { previousRole } = await upsertShare(db, { kind: 'folder', id }, { userId: targetUserId, role, sharedBy: userId });
    publishEntityEvent({
      c,
      entityType: 'folder',
      entityId: id,
      action: 'shared',
      data: { id, name: row.name, parentId: row.parentId, userId: targetUserId, role, previousRole },
    });
    return success(c, await folderSharing(c, opened));
  } catch (err) {
    console.error('[app-api/folders] share failed:', err);
    return error.internal(c, 'Failed to share folder');
  }
});

/**
 * Stop sharing the folder with a teammate. Owner and editors may remove
 * anyone; anyone may remove themselves. Answers the updated sharing, or null
 * once the caller can no longer see the folder.
 */
app.delete('/:id/shares/:userId', requirePermission('folders:read'), async (c) => {
  const id = c.req.param('id');
  const targetUserId = c.req.param('userId');
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  try {
    const leaving = targetUserId === userId;
    const opened = await openFolder(c, id, leaving ? 'view' : 'edit');
    if (opened instanceof Response) return opened;
    if (!leaving && !(await hasContextPermission(c, 'folders:update'))) {
      return error.forbidden(c, 'Missing permission: folders:update');
    }
    const removedRole = await removeShare(c.get('tenantDb'), { kind: 'folder', id }, targetUserId);
    if (!removedRole) return error.notFound(c, 'Share', targetUserId);
    publishEntityEvent({
      c,
      entityType: 'folder',
      entityId: id,
      action: 'unshared',
      data: { id, name: opened.row.name, parentId: opened.row.parentId, userId: targetUserId, role: removedRole },
    });
    const after = await openFolder(c, id, 'view');
    return success(c, after instanceof Response ? null : await folderSharing(c, after));
  } catch (err) {
    console.error('[app-api/folders] unshare failed:', err);
    return error.internal(c, 'Failed to stop sharing folder');
  }
});

export const foldersRoutes = app;
