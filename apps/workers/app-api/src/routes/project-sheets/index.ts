/**
 * Project sheet routes — /api/project-sheets/*.
 *
 * Sheets are stored as .xlsx files in R2, registered in the `files` table.
 * One file row per sheet, with entityType='project' + entityId=<projectId> +
 * fileType='spreadsheet'. The xlsx binary is fetched/saved through
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
import { buildEmptyXlsx } from '../../lib/office-templates';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const SPREADSHEET_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const createSheetSchema = z.object({
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
          eq(schema.files.fileType, 'spreadsheet'),
          isNull(schema.files.deletedAt),
        ),
      )
      .orderBy(desc(schema.files.createdAt));
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/project-sheets] list failed:', err);
    return error.internal(c, 'Failed to list project sheets');
  }
});

app.post(
  '/:projectId',
  requirePermission('projects:update'),
  zValidator('json', createSheetSchema),
  async (c) => {
    const projectId = c.req.param('projectId');
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);
    const workspaceId = c.get('workspaceId') || c.get('orgId');
    if (!workspaceId) return error.orgRequired(c);

    const { name } = c.req.valid('json');
    const fileName = name.endsWith('.xlsx') ? name : `${name}.xlsx`;
    const sanitized = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const fileKey = `workspaces/${workspaceId}/sheets/${projectId}/${Date.now()}_${sanitized}`;
    const r2PublicUrl = c.env.R2_PUBLIC_URL || 'https://weldsuite-storage-test.weldsuite.org';
    const publicUrl = `${r2PublicUrl}/${fileKey}`;

    try {
      // Seed R2 with a minimal valid empty .xlsx so the file is downloadable
      // before the editor's first auto-save. Without this seed, a brand-new
      // sheet 404s from R2 when downloaded via /welddrive.
      const emptyXlsx = buildEmptyXlsx();
      if (c.env.STORAGE) {
        await c.env.STORAGE.put(fileKey, emptyXlsx, {
          httpMetadata: { contentType: SPREADSHEET_MIME },
        });
      }

      const row = await filesService.createFile(c.get('tenantDb'), {
        fileName,
        originalName: fileName,
        mimeType: SPREADSHEET_MIME,
        fileSize: emptyXlsx.byteLength,
        fileType: 'spreadsheet',
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
      return success(c, row, 201);
    } catch (err) {
      console.error('[app-api/project-sheets] create failed:', err);
      return error.internal(c, 'Failed to create project sheet');
    }
  },
);

export const projectSheetsRoutes = app;
