/**
 * Document routes — /api/documents/*.
 *
 * Documents from before WeldDocs: their canonical content is BlockNote block
 * JSON (the source of truth), stored in the `docs` table and paired 1:1 with
 * a drive `files` row. Addressed by the backing file id (`:fileId`).
 *
 * A WeldDocs document (docs-api, `isWeldDocsRow`) shares the table but keeps
 * its content in a DocRoom: reading one returns `content: []`, and every write
 * to one is refused with a 409. Phase 8 of docs/plans/welddocs.md retires
 * this route.
 *
 *   GET    /api/documents/:fileId                          → doc row (or null)
 *   POST   /api/documents                                  → create (drive doc)
 *   PUT    /api/documents/:fileId/content                  → upsert block JSON
 *   GET    /api/documents/:fileId/versions                 → version list
 *   POST   /api/documents/:fileId/versions                 → named snapshot
 *   GET    /api/documents/:fileId/versions/:versionId      → full version
 *   POST   /api/documents/:fileId/versions/:versionId/restore → restore
 *
 * docx/pdf export stays client-side (serialized from the loaded blocks).
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import { schema } from '@weldsuite/worker-kit/db';
import * as documentsService from '../../services/documents';
import * as documentVersionsService from '../../services/document-versions';
import * as filesService from '@weldsuite/core-domain/files';
import { canEdit, containerRole, fileRole, loadDriveAccessForUser } from '@weldsuite/core-domain/drive-access';
import { buildEmptyDocx } from '../../lib/office-templates';
import { canAccessProject, canWriteProject } from '../../lib/project-access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type DocumentCtx = Context<{ Bindings: Env; Variables: Variables }>;

const PROJECT_DENIED = 'You are not a member of this project';
const PROJECT_WRITE_DENIED = 'You do not have write access to this project';
const DRIVE_VIEW_ONLY = 'You can view this item but not change it';

/**
 * Access gate for a document addressed by its backing file id, so the
 * `files:*` permission alone does not let any workspace user read or
 * overwrite it:
 *   - project documents (`files` rows with entityType 'project', entityId =
 *     the project): reads need project access, writes need write access
 *     (viewers are read-only);
 *   - drive documents (no entityType): the WeldDrive sharing rules
 *     (`@weldsuite/core-domain/drive-access`); a hidden document is a 404.
 * Null when the caller may proceed, else the error response.
 */
async function guardDocument(c: DocumentCtx, fileId: string, mode: 'read' | 'write'): Promise<Response | null> {
  const db = c.get('tenantDb');
  const [file] = await db
    .select({
      id: schema.files.id,
      entityType: schema.files.entityType,
      entityId: schema.files.entityId,
      uploadedById: schema.files.uploadedById,
      folderId: schema.files.folderId,
      generalAccess: schema.files.generalAccess,
    })
    .from(schema.files)
    .where(eq(schema.files.id, fileId))
    .limit(1);
  if (!file) return null;
  if (!file.entityType) {
    const role = fileRole(await loadDriveAccessForUser(db, c.get('userId') ?? null), file);
    if (!role) return error.notFound(c, 'Document', fileId);
    return mode === 'write' && !canEdit(role) ? error.forbidden(c, DRIVE_VIEW_ONLY) : null;
  }
  if (file.entityType !== 'project' || !file.entityId) return null;
  if (mode === 'write') {
    return (await canWriteProject(c, file.entityId)) ? null : error.forbidden(c, PROJECT_WRITE_DENIED);
  }
  return (await canAccessProject(c, file.entityId)) ? null : error.forbidden(c, PROJECT_DENIED);
}

const DOCUMENT_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const saveContentSchema = z.object({
  content: z.array(z.record(z.unknown())),
});

const createDocumentSchema = z.object({
  name: z.string().min(1).max(255),
  folderId: z.string().nullish(),
});

const createVersionSchema = z.object({
  label: z.string().min(1).max(255).optional(),
});

app.get('/:fileId', requirePermission('files:read'), async (c) => {
  const fileId = c.req.param('fileId');
  const denied = await guardDocument(c, fileId, 'read');
  if (denied) return denied;
  try {
    const row = await documentsService.getDocByFileId(c.get('tenantDb'), fileId);
    // A WeldDocs document has no BlockNote content; callers expect an array.
    return success(c, row && documentsService.isWeldDocsRow(row) ? { ...row, content: [] } : row);
  } catch (err) {
    console.error('[app-api/documents] get failed:', err);
    return error.internal(c, 'Failed to load document');
  }
});

// Create a standalone (drive) document: a `files` row (fileType=document) +
// an empty `docs` row. Project documents continue to use
// /api/project-documents/:projectId.
app.post('/', requirePermission('files:create'), zValidator('json', createDocumentSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const clerkOrgId = c.get('clerkOrgId') || c.get('orgId');
  if (!clerkOrgId) return error.orgRequired(c);

  const { name, folderId } = c.req.valid('json');
  const fileName = name.endsWith('.docx') ? name : `${name}.docx`;
  const sanitized = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const fileKey = `workspaces/${clerkOrgId}/documents/drive/${Date.now()}_${sanitized}`;
  const r2PublicUrl = c.env.R2_PUBLIC_URL || 'https://weldsuite-storage-test.weldsuite.org';
  const publicUrl = `${r2PublicUrl}/${fileKey}`;
  const db = c.get('tenantDb');

  if (folderId) {
    // A new document goes where the caller may add files.
    const role = containerRole(await loadDriveAccessForUser(db, userId), folderId);
    if (!role) return error.notFound(c, 'Folder', folderId);
    if (!canEdit(role)) return error.forbidden(c, DRIVE_VIEW_ONLY);
  }

  try {
    const emptyDocx = buildEmptyDocx();
    if (c.env.STORAGE) {
      await c.env.STORAGE.put(fileKey, emptyDocx, { httpMetadata: { contentType: DOCUMENT_MIME } });
    }

    const row = await filesService.createFile(db, {
      fileName,
      originalName: fileName,
      mimeType: DOCUMENT_MIME,
      fileSize: emptyDocx.byteLength,
      fileType: 'document',
      storagePath: fileKey,
      fileKey,
      url: publicUrl,
      folderId: folderId ?? null,
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

    const docRow = await documentsService.createDocForFile(db, row.id, userId, []);
    publishEntityEvent({
      c,
      entityType: 'doc',
      entityId: docRow.id,
      action: 'created',
      data: { id: docRow.id, fileId: row.id, updatedById: userId },
    });

    return success(c, row, 201);
  } catch (err) {
    console.error('[app-api/documents] create failed:', err);
    return error.internal(c, 'Failed to create document');
  }
});

app.put(
  '/:fileId/content',
  requirePermission('files:update'),
  zValidator('json', saveContentSchema),
  async (c) => {
    const fileId = c.req.param('fileId');
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);

    const { content } = c.req.valid('json');
    const db = c.get('tenantDb');
    const denied = await guardDocument(c, fileId, 'write');
    if (denied) return denied;

    try {
      // The doc row FK-references files.id — make sure the file exists (and is
      // in this workspace's tenant DB) before writing.
      const file = await filesService.getFile(db, fileId);
      if (!file) return error.notFound(c, 'Document', fileId);
      const current = await documentsService.getDocByFileId(db, fileId);
      if (current && documentsService.isWeldDocsRow(current)) return error.conflict(c, documentsService.WELDDOCS_ROW_MESSAGE);

      const row = await documentsService.upsertDocContent(
        db,
        fileId,
        content as documentsService.DocBlocks,
        userId,
      );
      // Throttled automatic version snapshot.
      await documentVersionsService.maybeAutoSnapshot(
        db,
        fileId,
        content as documentsService.DocBlocks,
        userId,
      );
      publishEntityEvent({
        c,
        entityType: 'doc',
        action: 'updated',
        entityId: row.id,
        data: { id: row.id, fileId: row.fileId, updatedById: row.updatedById },
      });
      return success(c, row);
    } catch (err) {
      console.error('[app-api/documents] save failed:', err);
      return error.internal(c, 'Failed to save document');
    }
  },
);

// ---- Version history ----

app.get('/:fileId/versions', requirePermission('files:read'), async (c) => {
  const fileId = c.req.param('fileId');
  const denied = await guardDocument(c, fileId, 'read');
  if (denied) return denied;
  try {
    const rows = await documentVersionsService.listVersions(c.get('tenantDb'), fileId);
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/documents] list versions failed:', err);
    return error.internal(c, 'Failed to list versions');
  }
});

app.post(
  '/:fileId/versions',
  requirePermission('files:update'),
  zValidator('json', createVersionSchema),
  async (c) => {
    const fileId = c.req.param('fileId');
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);
    const { label } = c.req.valid('json');
    const db = c.get('tenantDb');
    const denied = await guardDocument(c, fileId, 'write');
    if (denied) return denied;

    try {
      const doc = await documentsService.getDocByFileId(db, fileId);
      if (!doc) return error.notFound(c, 'Document', fileId);
      if (documentsService.isWeldDocsRow(doc)) return error.conflict(c, documentsService.WELDDOCS_ROW_MESSAGE);
      const row = await documentVersionsService.createVersion(
        db,
        fileId,
        (doc.content ?? []) as documentsService.DocBlocks,
        userId,
        label ?? null,
      );
      return success(c, row, 201);
    } catch (err) {
      console.error('[app-api/documents] create version failed:', err);
      return error.internal(c, 'Failed to create version');
    }
  },
);

app.get('/:fileId/versions/:versionId', requirePermission('files:read'), async (c) => {
  const fileId = c.req.param('fileId');
  const versionId = c.req.param('versionId');
  const denied = await guardDocument(c, fileId, 'read');
  if (denied) return denied;
  try {
    const row = await documentVersionsService.getVersion(c.get('tenantDb'), fileId, versionId);
    if (!row) return error.notFound(c, 'Version', versionId);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/documents] get version failed:', err);
    return error.internal(c, 'Failed to load version');
  }
});

app.post(
  '/:fileId/versions/:versionId/restore',
  requirePermission('files:update'),
  async (c) => {
    const fileId = c.req.param('fileId');
    const versionId = c.req.param('versionId');
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);
    const db = c.get('tenantDb');
    const denied = await guardDocument(c, fileId, 'write');
    if (denied) return denied;

    try {
      const version = await documentVersionsService.getVersion(db, fileId, versionId);
      if (!version) return error.notFound(c, 'Version', versionId);

      // Snapshot what is about to be overwritten, so a restore can be undone.
      const current = await documentsService.getDocByFileId(db, fileId);
      if (current && documentsService.isWeldDocsRow(current)) return error.conflict(c, documentsService.WELDDOCS_ROW_MESSAGE);
      if (current) {
        await documentVersionsService.createVersion(
          db,
          fileId,
          (current.content ?? []) as documentsService.DocBlocks,
          userId,
          null,
        );
      }

      const row = await documentsService.upsertDocContent(
        db,
        fileId,
        version.content as documentsService.DocBlocks,
        userId,
      );
      publishEntityEvent({
        c,
        entityType: 'doc',
        action: 'updated',
        entityId: row.id,
        data: { id: row.id, fileId: row.fileId, updatedById: row.updatedById },
      });
      return success(c, row);
    } catch (err) {
      console.error('[app-api/documents] restore version failed:', err);
      return error.internal(c, 'Failed to restore version');
    }
  },
);

export const documentsRoutes = app;
