/**
 * Project document routes — /api/project-documents/*.
 *
 * Documents are stored as .docx files in R2, registered in the `files` table.
 * One file row per document, with entityType='project' + entityId=<projectId> +
 * fileType='document'. The docx binary is fetched/saved through
 * /api/files/:id/content. This route just lists and creates the file row.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';
import * as filesService from '../../services/files';
import * as documentsService from '../../services/documents';
import { buildEmptyDocx } from '../../lib/office-templates';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const DOCUMENT_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const createDocumentSchema = z.object({
  name: z.string().min(1).max(255),
});

app.get('/:projectId', requirePermission('projects:read'), async (c) => {
  const projectId = c.req.param('projectId');
  const db = c.get('tenantDb');
  try {
    const rows = await db
      .select()
      .from(schema.files)
      .where(
        and(
          eq(schema.files.entityType, 'project'),
          eq(schema.files.entityId, projectId),
          eq(schema.files.fileType, 'document'),
          isNull(schema.files.deletedAt),
        ),
      )
      // Pinned docs first (most recently pinned at the top of that block), then
      // the rest newest-first. The UI groups on isPinned, but ordering here
      // keeps any non-grouping consumer consistent.
      .orderBy(
        desc(schema.files.isPinned),
        desc(schema.files.pinnedAt),
        desc(schema.files.createdAt),
      );
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/project-documents] list failed:', err);
    return error.internal(c, 'Failed to list project documents');
  }
});

app.post(
  '/:projectId',
  requirePermission('projects:update'),
  zValidator('json', createDocumentSchema),
  async (c) => {
    const projectId = c.req.param('projectId');
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);
    const workspaceId = c.get('workspaceId') || c.get('orgId');
    if (!workspaceId) return error.orgRequired(c);

    const { name } = c.req.valid('json');
    const fileName = name.endsWith('.docx') ? name : `${name}.docx`;
    const sanitized = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const fileKey = `workspaces/${workspaceId}/documents/${projectId}/${Date.now()}_${sanitized}`;
    const r2PublicUrl = c.env.R2_PUBLIC_URL || 'https://weldsuite-storage-test.weldsuite.org';
    const publicUrl = `${r2PublicUrl}/${fileKey}`;

    try {
      // Seed R2 with a minimal valid empty .docx so the file is downloadable
      // before the editor's first auto-save. Without this seed, a brand-new
      // doc 404s from R2 when downloaded via /welddrive.
      const emptyDocx = buildEmptyDocx();
      if (c.env.STORAGE) {
        await c.env.STORAGE.put(fileKey, emptyDocx, {
          httpMetadata: { contentType: DOCUMENT_MIME },
        });
      }

      const row = await filesService.createFile(c.get('tenantDb'), {
        fileName,
        originalName: fileName,
        mimeType: DOCUMENT_MIME,
        fileSize: emptyDocx.byteLength,
        fileType: 'document',
        storagePath: fileKey,
        fileKey,
        url: publicUrl,
        entityType: 'project',
        entityId: projectId,
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

      // Create the JSON source-of-truth doc row (empty content). The seeded
      // R2 .docx above is retained only as a legacy download artifact; the
      // `docs` row is what the editor loads/saves from Phase 1 onward.
      const docRow = await documentsService.createDocForFile(c.get('tenantDb'), row.id, userId, []);
      publishEntityEvent({
        c,
        entityType: 'doc',
        entityId: docRow.id,
        action: 'created',
        data: { id: docRow.id, fileId: row.id, updatedById: userId },
      });

      return success(c, row, 201);
    } catch (err) {
      console.error('[app-api/project-documents] create failed:', err);
      return error.internal(c, 'Failed to create project document');
    }
  },
);

export const projectDocumentsRoutes = app;
