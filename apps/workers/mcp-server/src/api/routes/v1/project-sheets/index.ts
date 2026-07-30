import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { list, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';

/** Read-only view over schema.files filtered to entityType='project' + fileType='spreadsheet'. */

const listProjectSheetsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  projectId: z.string().optional(),
});

const table = schema.files;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('project_sheets:read'), zValidator('query', listProjectSheetsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [
    eq(table.entityType, 'project'),
    eq(table.fileType, 'spreadsheet'),
    isNull(table.deletedAt),
  ];
  if (q.projectId) where.push(eq(table.entityId, q.projectId));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

export default app;
