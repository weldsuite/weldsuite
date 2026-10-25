/**
 * Project sheet routes — /api/project-sheets/*.
 *
 * A project's sheets are drive files with entityType='project' +
 * entityId=<projectId> + fileType='spreadsheet': WeldSheets spreadsheets
 * (`metadata.weldsheetId`), and .xlsx files saved by the old project grid
 * that nobody has opened since (sheets-api converts one on first open). This
 * route lists them; sheets-api creates, edits and converts them.
 */

import { Hono } from 'hono';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import { schema } from '@weldsuite/worker-kit/db';
import { canAccessProject } from '../../lib/project-access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/:projectId', requirePermission('projects:read'), async (c) => {
  const projectId = c.req.param('projectId');
  const db = c.get('tenantDb');
  if (!(await canAccessProject(c, projectId))) {
    return error.forbidden(c, 'You are not a member of this project');
  }
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

export const projectSheetsRoutes = app;
