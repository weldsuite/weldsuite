import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, count, eq, inArray, isNull, like, type SQL } from 'drizzle-orm';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { error, list, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  loadDriveAccessForUser,
  visibleFilesCondition,
  visibleFolderIds,
} from '@weldsuite/core-domain/drive-access';

/**
 * READ-ONLY aggregation endpoints.
 *
 * The app-api drive aggregation service requires STORAGE (R2) and other
 * bindings external-api does not have. Instead these endpoints use simple
 * direct queries over schema.files + schema.folders — binding-free and
 * suitable for the public API surface.
 *
 * Exposed:
 *   GET /all    — paginated list of non-deleted files (metadata only)
 *   GET /stats  — per-fileType counts + total file count
 *
 * Both count only what the caller may open under the WeldDrive sharing rules
 * (`@weldsuite/core-domain/drive-access`).
 */

const listAllQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  type: z.string().optional(),
  folderId: z.string().optional(),
  source: z.string().optional(),
});

const app = new Hono<HonoEnv>();

// ============================================================================
// GET /all — cross-source file list (files table only, metadata)
// ============================================================================

app.get('/all', requireScope('drive:read'), zValidator('query', listAllQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const table = schema.files;
  const access = await loadDriveAccessForUser(db, c.get('apiSession').userId);
  const where: (SQL | undefined)[] = [isNull(table.deletedAt), visibleFilesCondition(access)];
  if (q.search) where.push(like(table.fileName, `%${q.search}%`));
  if (q.type) where.push(eq(table.fileType, q.type));
  if (q.folderId) where.push(eq(table.folderId, q.folderId));
  try {
    const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
    return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch {
    return error.internal(c, 'Failed to fetch files');
  }
});

// ============================================================================
// GET /stats — counts by fileType + total
// ============================================================================

app.get('/stats', requireScope('drive:read'), async (c) => {
  const db = c.get('tenantDb');
  const table = schema.files;
  try {
    const access = await loadDriveAccessForUser(db, c.get('apiSession').userId);
    const rows = await db
      .select({ fileType: table.fileType, total: count() })
      .from(table)
      .where(and(isNull(table.deletedAt), visibleFilesCondition(access)))
      .groupBy(table.fileType);

    const byType: Record<string, number> = {};
    let totalFiles = 0;
    for (const row of rows) {
      byType[row.fileType] = Number(row.total);
      totalFiles += Number(row.total);
    }

    const visibleFolders = visibleFolderIds(access);
    const [folderRow] = visibleFolders.length > 0
      ? await db
          .select({ total: count() })
          .from(schema.folders)
          .where(and(isNull(schema.folders.deletedAt), inArray(schema.folders.id, visibleFolders)))
      : [{ total: 0 }];
    const totalFolders = Number(folderRow?.total ?? 0);

    return success(c, { totalFiles, totalFolders, byType });
  } catch {
    return error.internal(c, 'Failed to get stats');
  }
});

export default app;
