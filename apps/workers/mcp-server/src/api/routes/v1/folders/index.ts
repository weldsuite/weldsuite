import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  listFoldersQuery,
  createFolderSchema,
  updateFolderSchema,
} from '@weldsuite/core-api-client/schemas/folders';
import { checkFolderParent, FOLDER_PARENT_ERRORS } from '@weldsuite/core-domain/folders';
import {
  canEdit,
  containerRole,
  folderRole,
  loadDriveAccessForUser,
  visibleFolderIds,
  type DriveAccessIndex,
} from '@weldsuite/core-domain/drive-access';

/**
 * Drive folders follow the WeldDrive sharing rules
 * (`@weldsuite/core-domain/drive-access`): a workspace key sees folders that
 * are not restricted, a user token what that person may open. A folder the
 * caller cannot see is a 404.
 */

const table = schema.folders;
const app = new Hono<HonoEnv>();

const VIEW_ONLY = 'You can view this item but not change it';

/** The error response, unless the caller may put a folder under `parentId` (null: the root). */
function checkDestination(c: Context<HonoEnv>, access: DriveAccessIndex, parentId: string | null | undefined): Response | null {
  if (!parentId) return null;
  const role = containerRole(access, parentId);
  if (!role) return error.notFound(c, 'Folder', parentId);
  return canEdit(role) ? null : error.forbidden(c, VIEW_ONLY);
}

/** The live folder and the caller's rules, or the error response (404 hidden, 403 view-only). */
async function openFolder(c: Context<HonoEnv>, id: string, mode: 'view' | 'edit') {
  const db = c.get('tenantDb');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Folder', id);
  const access = await loadDriveAccessForUser(db, c.get('apiSession').userId);
  const role = folderRole(access, row);
  if (!role) return error.notFound(c, 'Folder', id);
  if (mode === 'edit' && !canEdit(role)) return error.forbidden(c, VIEW_ONLY);
  return { row, access };
}

app.get('/', requireScope('folders:read'), zValidator('query', listFoldersQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const visible = visibleFolderIds(await loadDriveAccessForUser(db, c.get('apiSession').userId));
  const where: (SQL | undefined)[] = [visible.length > 0 ? inArray(table.id, visible) : sql`false`];
  if (q.parentId) where.push(eq(table.parentId, q.parentId));
  const result = await listWithCursor({ db, table, where, cursor: undefined, limit: undefined });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('folders:read'), async (c) => {
  const opened = await openFolder(c, c.req.param('id'), 'view');
  if (opened instanceof Response) return opened;
  return success(c, opened.row);
});

app.post('/', requireScope('folders:write'), zValidator('json', createFolderSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const parentCheck = await checkFolderParent(db, null, body.parentId);
  if (parentCheck !== 'ok') return error.badRequest(c, FOLDER_PARENT_ERRORS[parentCheck]);
  const userId = c.get('apiSession').userId;
  const denied = checkDestination(c, await loadDriveAccessForUser(db, userId), body.parentId);
  if (denied) return denied;
  const now = new Date();
  const id = generateId('fld');
  // A user token's person owns the folder; a workspace key's folders have no owner.
  const values = { ...(body as Record<string, unknown>), id, createdById: userId, createdAt: now, updatedAt: now };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create folder');
  publishEntityEvent({
    c,
    entityType: 'folder',
    entityId: id,
    action: 'created',
    data: { id, name: row.name, parentId: row.parentId },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('folders:write'), zValidator('json', updateFolderSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const opened = await openFolder(c, id, 'edit');
  if (opened instanceof Response) return opened;
  // A parent inside the folder would cut it and its contents off from the tree.
  const parentCheck = await checkFolderParent(db, id, body.parentId);
  if (parentCheck !== 'ok') return error.badRequest(c, FOLDER_PARENT_ERRORS[parentCheck]);
  if (body.parentId !== undefined && body.parentId !== opened.row.parentId) {
    const denied = checkDestination(c, opened.access, body.parentId);
    if (denied) return denied;
  }
  const [row] = await db
    .update(table)
    .set({ ...(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Folder', id);
  publishEntityEvent({
    c,
    entityType: 'folder',
    entityId: id,
    action: 'updated',
    data: { id, name: row.name, parentId: row.parentId },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('folders:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const opened = await openFolder(c, id, 'edit');
  if (opened instanceof Response) return opened;
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Folder', id);
  publishEntityEvent({
    c,
    entityType: 'folder',
    entityId: id,
    action: 'deleted',
    data: { id, name: row.name, parentId: row.parentId },
  });
  return noContent(c);
});

export default app;
