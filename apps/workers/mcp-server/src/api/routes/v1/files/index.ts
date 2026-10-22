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
import { getStoredObject, isWorkspaceObjectKey, locateStoredObject } from '@weldsuite/worker-kit/storage';

/**
 * Metadata CRUD, plus `GET /:id/content` to download the stored file. Private
 * files have no URL an integrator can fetch (their `url` is served by app-api
 * to members only), so the content route is how the API reads them. DELETE =
 * soft delete.
 *
 * Drive files follow the WeldDrive sharing rules
 * (`@weldsuite/core-domain/drive-access`): a workspace key sees files that are
 * not restricted, a user token what that person may open. A file the caller
 * cannot see is a 404.
 *
 * A row's `storagePath` / `fileKey` must be under this workspace's own
 * `workspaces/<id>/` prefix: checked on create, and again before a download,
 * for rows written before the check.
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

/**
 * True when `key` is one of this workspace's objects. Uploads are keyed by the
 * Clerk org id, a few server-side writers by the master `workspaces.id`.
 */
function isOwnKey(c: Context<HonoEnv>, key: string): boolean {
  const session = c.get('apiSession');
  return isWorkspaceObjectKey(key, c.get('workspaceId'), session.clerkOrgId, session.workspaceId);
}

/** RFC 6266 filename, with an ASCII fallback for old clients. */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
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

// Always an attachment, never cached, never sniffed: a file is not rendered
// inline from the API origin.
app.get('/:id/content', requireScope('files:read'), async (c) => {
  const id = c.req.param('id');
  const opened = await openFile(c, id, 'view');
  if (opened instanceof Response) return opened;
  const { row } = opened;
  const key = row.fileKey || row.storagePath;
  if (!key || !isOwnKey(c, key)) return error.notFound(c, 'File content', id);
  if (!c.env.STORAGE && !c.env.PRIVATE_STORAGE) {
    return c.json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'File storage is not configured' } }, 503);
  }
  const obj = await getStoredObject(c.env, key);
  if (!obj) return error.notFound(c, 'File content', id);
  return new Response(obj.body, {
    headers: {
      'Content-Type': row.mimeType || obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Content-Disposition': contentDisposition(row.fileName || `file-${id}`),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

app.post('/', requireScope('files:write'), zValidator('json', createFileSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  if (![body.storagePath, body.fileKey].every((key) => key === undefined || isOwnKey(c, key))) {
    return error.badRequest(c, 'storagePath / fileKey is not a file of this workspace');
  }
  const userId = c.get('apiSession').userId;
  const denied = checkDestination(c, await loadDriveAccessForUser(db, userId), body.folderId);
  if (denied) return denied;
  const now = new Date();
  const id = generateId('fil');
  // The drive builds a keyed row's URL from its bucket: record where the object is.
  const located = await locateStoredObject(c.env, body.fileKey ?? body.storagePath);
  // A user token's person owns what they upload; a workspace key's files have no owner.
  const values = {
    ...(body as Record<string, unknown>),
    id,
    bucket: located?.bucket ?? null,
    uploadedById: userId,
    createdAt: now,
    updatedAt: now,
  };
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
