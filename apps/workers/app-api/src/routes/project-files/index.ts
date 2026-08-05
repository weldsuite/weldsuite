/**
 * Project file routes — /api/project-files/* surface backed by `projectFiles`.
 *
 * Supports a folder hierarchy via `parentId` + `isFolder` rows.
 * Permissions: files:read | files:create | files:update | files:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createProjectFileSchema,
  createProjectFolderSchema,
  updateProjectFileSchema,
} from '@weldsuite/core-api-client/schemas/project-files';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema, type Database } from '../../db';
import { accessibleProjectIds, canAccessProject } from '../../lib/project-access';
import {
  createProjectFolder,
  softDeleteProjectFolderCascade,
  wouldCreateCycle,
  replacedStorageKey,
} from '../../services/project-files';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectFiles;

const PROJECT_DENIED = 'You are not a member of this project';

type ParentCheck =
  | { ok: true }
  | { ok: false; kind: 'not_found'; parentId: string }
  | { ok: false; kind: 'cross_project' };

async function assertValidParent(
  db: Database,
  parentId: string,
  projectId: string | null | undefined,
): Promise<ParentCheck> {
  const [parent] = await db
    .select({ id: t.id, isFolder: t.isFolder, projectId: t.projectId })
    .from(t)
    .where(and(eq(t.id, parentId), isNull(t.deletedAt)))
    .limit(1);
  if (!parent || !parent.isFolder) return { ok: false, kind: 'not_found', parentId };
  if (projectId && parent.projectId !== projectId) return { ok: false, kind: 'cross_project' };
  return { ok: true };
}

app.get('/', requirePermission('files:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const parsedLimit = q.limit ? Number.parseInt(q.limit, 10) : 25;
  const limit = Math.min(Math.max(Number.isFinite(parsedLimit) ? parsedLimit : 25, 1), 500);

  const conditions = [isNull(t.deletedAt)];
  if (q.projectId !== undefined && q.projectId !== '') conditions.push(eq(t.projectId, q.projectId));
  if (q.projectId) {
    if (!(await canAccessProject(c, q.projectId))) return error.forbidden(c, PROJECT_DENIED);
  } else {
    const accessible = await accessibleProjectIds(c);
    if (accessible !== null) conditions.push(inArray(t.projectId, accessible.length ? accessible : ['']));
  }
  if (q.uploadedById !== undefined && q.uploadedById !== '') conditions.push(eq(t.uploadedById, q.uploadedById));
  if (q.fileType !== undefined && q.fileType !== '') conditions.push(eq(t.fileType, q.fileType));

  // Folder navigation:
  //   parentId=root (or empty string) → only root-level items
  //   parentId=<id> → children of that folder
  //   all=true → no parent filter (flat list, used by move dialogs)
  //   omitted → same as all=true for backwards compatibility
  if (q.all !== 'true' && q.parentId !== undefined) {
    if (q.parentId === '' || q.parentId === 'root') {
      conditions.push(isNull(t.parentId));
    } else {
      conditions.push(eq(t.parentId, q.parentId));
    }
  }
  if (q.foldersOnly === 'true') {
    conditions.push(eq(t.isFolder, true));
  }

  if (q.cursor) {
    const [cur] = await db
      .select({ isFolder: t.isFolder, createdAt: t.createdAt, id: t.id })
      .from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur) {
      // Predicate must match orderBy: desc(isFolder), desc(createdAt), desc(id).
      conditions.push(
        sql`((${t.isFolder} < ${cur.isFolder}) OR (${t.isFolder} = ${cur.isFolder} AND (${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))))`,
      );
    }
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.isFolder), desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/project-files] list failed:', err);
    return error.internal(c, 'Failed to list project files');
  }
});

app.get('/:id', requirePermission('files:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Project file', id);
    if (row.projectId && !(await canAccessProject(c, row.projectId))) {
      return error.forbidden(c, PROJECT_DENIED);
    }
    return success(c, row);
  } catch (err) {
    console.error('[app-api/project-files] get failed:', err);
    return error.internal(c, 'Failed to fetch project file');
  }
});

/** Create a folder row (isFolder=true). Separate from file upload POST. */
app.post('/folders', requirePermission('files:create'), zValidator('json', createProjectFolderSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  if (!(await canAccessProject(c, data.projectId))) {
    return error.forbidden(c, PROJECT_DENIED);
  }
  try {
    const row = await createProjectFolder(db, {
      projectId: data.projectId,
      name: data.name,
      parentId: data.parentId ?? null,
      uploadedById: c.get('userId') ?? null,
    });
    publishEntityEvent({
      c,
      entityType: 'project_file',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, projectId: data.projectId, fileName: row.fileName, fileType: 'folder' },
    });
    return success(c, row, 201);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return error.notFound(c, 'Parent folder', data.parentId ?? '');
    if (status === 400) return error.badRequest(c, (err as Error).message);
    console.error('[app-api/project-files] create folder failed:', err);
    return error.internal(c, 'Failed to create folder');
  }
});

app.post('/', requirePermission('files:create'), zValidator('json', createProjectFileSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, unknown>;
  const id = generateId('pfile');
  const now = new Date();
  const projectId = typeof data.projectId === 'string' ? data.projectId : undefined;
  if (projectId && !(await canAccessProject(c, projectId))) {
    return error.forbidden(c, PROJECT_DENIED);
  }
  try {
    // If the client is creating a folder via the generic POST, normalize fields.
    if (data.isFolder || data.fileType === 'folder') {
      const row = await createProjectFolder(db, {
        projectId: projectId!,
        name: (data.fileName as string | undefined) ?? (data.name as string | undefined) ?? 'Untitled folder',
        parentId: (data.parentId as string | null | undefined) ?? null,
        uploadedById: c.get('userId') ?? (data.uploadedById as string | null | undefined) ?? null,
      });
      publishEntityEvent({
        c,
        entityType: 'project_file',
        entityId: row.id,
        action: 'created',
        data: { id: row.id, projectId, fileName: row.fileName, fileType: 'folder' },
      });
      return success(c, row, 201);
    }

    const parentId = (data.parentId as string | null | undefined) ?? null;
    if (parentId) {
      const check = await assertValidParent(db, parentId, projectId);
      if (!check.ok && check.kind === 'not_found') return error.notFound(c, 'Parent folder', check.parentId);
      if (!check.ok && check.kind === 'cross_project') {
        return error.badRequest(c, 'Cannot create a file under a folder from a different project');
      }
    }

    await db.insert(t).values({
      id,
      ...data,
      parentId,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'project_file',
      entityId: id,
      action: 'created',
      data: {
        id,
        projectId,
        fileName: data.fileName as string | undefined,
        fileType: (data.fileType as string | undefined) ?? 'file',
      },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/project-files] create failed:', err);
    return error.internal(c, 'Failed to create project file');
  }
});

app.patch('/:id', requirePermission('files:update'), zValidator('json', updateProjectFileSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, unknown>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Project file', id);
    if (existing.projectId && !(await canAccessProject(c, existing.projectId))) {
      return error.forbidden(c, PROJECT_DENIED);
    }

    if (data.parentId !== undefined && existing.isFolder) {
      const cycle = await wouldCreateCycle(db, id, (data.parentId as string | null) ?? null);
      if (cycle) {
        return error.badRequest(c, 'Cannot move a folder into itself or one of its subfolders');
      }
    }

    if (typeof data.parentId === 'string' && data.parentId) {
      const check = await assertValidParent(db, data.parentId, existing.projectId);
      if (!check.ok && check.kind === 'not_found') return error.notFound(c, 'Parent folder', check.parentId);
      if (!check.ok && check.kind === 'cross_project') {
        return error.badRequest(c, 'Cannot move across projects');
      }
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined && k !== 'projectId') update[k] = v;
    }

    // Capture the previous R2 key before the row flips to the new object so we
    // can delete it only after the DB update succeeds (replace-file flow).
    const oldStorageKey = replacedStorageKey(
      { storagePath: existing.storagePath, fileKey: existing.fileKey ?? null },
      update,
    );

    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));

    if (oldStorageKey && c.env.STORAGE) {
      await c.env.STORAGE.delete(oldStorageKey).catch((cleanupErr) => {
        console.error(
          '[app-api/project-files] failed to delete replaced R2 object:',
          oldStorageKey,
          cleanupErr,
        );
      });
    }

    publishEntityEvent({
      c,
      entityType: 'project_file',
      entityId: id,
      action: 'updated',
      data: {
        id,
        projectId: existing.projectId,
        fileName: (update.fileName as string | undefined) ?? existing.fileName,
        fileType: (update.fileType as string | undefined) ?? existing.fileType,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/project-files] update failed:', err);
    return error.internal(c, 'Failed to update project file');
  }
});

app.delete('/:id', requirePermission('files:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Project file', id);
    if (existing.projectId && !(await canAccessProject(c, existing.projectId))) {
      return error.forbidden(c, PROJECT_DENIED);
    }

    if (existing.isFolder) {
      const deletedIds = await softDeleteProjectFolderCascade(db, id);
      for (const deletedId of deletedIds) {
        publishEntityEvent({
          c,
          entityType: 'project_file',
          entityId: deletedId,
          action: 'deleted',
          data: { id: deletedId },
        });
      }
      return noContent(c);
    }

    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'project_file',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/project-files] delete failed:', err);
    return error.internal(c, 'Failed to delete project file');
  }
});

export const projectFilesRoutes = app;
