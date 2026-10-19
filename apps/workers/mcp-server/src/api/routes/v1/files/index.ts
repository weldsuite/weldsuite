import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, like, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  listFilesQuery,
  createFileSchema,
  updateFileSchema,
} from '@weldsuite/core-api-client/schemas/files';
import {
  canEdit,
  containerRole,
  fileRole,
  loadDriveAccessForUser,
  visibleFilesCondition,
  type DriveAccessIndex,
} from '@weldsuite/core-domain/drive-access';

/**
 * Metadata CRUD only — no /:id/content or R2/STORAGE binding. DELETE = soft delete.
 *
 * Drive files follow the WeldDrive sharing rules
 * (`@weldsuite/core-domain/drive-access`): a workspace key sees files that are
 * not restricted, a user token what that person may open. A file the caller
 * cannot see is a 404.
 */

const table = schema.files;
const app = new Hono<HonoEnv>();

const VIEW_ONLY = 'You can view this item but not change it';

/** The error response, unless the caller may put a file in `folderId` (null: My Drive). */
function checkDestination(c: Context<HonoEnv>, access: DriveAccessIndex, folderId: string | null | undefined): Response | null {
  if (!folderId) return null;
  const role = containerRole(access, folderId);
  if (!role) return error.notFound(c, 'Folder', folderId);
  return canEdit(role) ? null : error.forbidden(c, VIEW_ONLY);
}

/** The live file and the caller's rules, or the error response (404 hidden, 403 view-only). */
async function openFile(c: Context<HonoEnv>, id: string, mode: 'view' | 'edit') {
  const db = c.get('tenantDb');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'File', id);
  const access = await loadDriveAccessForUser(db, c.get('apiSession').userId);
  const role = fileRole(access, row);
  if (!role) return error.notFound(c, 'File', id);
  if (mode === 'edit' && !canEdit(role)) return error.forbidden(c, VIEW_ONLY);
  return { row, access };
}

app.get('/', requireScope('files:read'), zValidator('query', listFilesQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const access = await loadDriveAccessForUser(db, c.get('apiSession').userId);
  const where: (SQL | undefined)[] = [visibleFilesCondition(access)];
  if (q.search) where.push(like(table.fileName, `%${q.search}%`));
  if (q.type) where.push(eq(table.fileType, q.type));
  if (q.folderId) where.push(eq(table.folderId, q.folderId));
  const result = await listWithCursor({ db, table, where, cursor: undefined, limit: q.pageSize });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('files:read'), async (c) => {
  const opened = await openFile(c, c.req.param('id'), 'view');
  if (opened instanceof Response) return opened;
  return success(c, opened.row);
});

app.post('/', requireScope('files:write'), zValidator('json', createFileSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const userId = c.get('apiSession').userId;
  const denied = checkDestination(c, await loadDriveAccessForUser(db, userId), body.folderId);
  if (denied) return denied;
  const now = new Date();
  const id = generateId('fil');
  // A user token's person owns what they upload; a workspace key's files have no owner.
  const values = { ...(body as Record<string, unknown>), id, uploadedById: userId, createdAt: now, updatedAt: now };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create file');
  publishEntityEvent({
    c,
    entityType: 'file',
    entityId: id,
    action: 'created',
    data: { id, name: row.fileName, folderId: row.folderId },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('files:write'), zValidator('json', updateFileSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const opened = await openFile(c, id, 'edit');
  if (opened instanceof Response) return opened;
  if (body.folderId !== undefined && body.folderId !== opened.row.folderId) {
    const denied = checkDestination(c, opened.access, body.folderId);
    if (denied) return denied;
  }
  const [row] = await db
    .update(table)
    .set({ ...(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'File', id);
  publishEntityEvent({
    c,
    entityType: 'file',
    entityId: id,
    action: 'updated',
    data: { id, name: row.fileName, folderId: row.folderId },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('files:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const opened = await openFile(c, id, 'edit');
  if (opened instanceof Response) return opened;
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'File', id);
  publishEntityEvent({
    c,
    entityType: 'file',
    entityId: id,
    action: 'deleted',
    data: { id, name: row.fileName, folderId: row.folderId },
  });
  return noContent(c);
});

export default app;
