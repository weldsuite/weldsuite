import { Hono } from 'hono';
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

/** Metadata CRUD only — no /:id/content or R2/STORAGE binding. DELETE = soft delete. */

const table = schema.files;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('files:read'), zValidator('query', listFilesQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) where.push(like(table.fileName, `%${q.search}%`));
  if (q.type) where.push(eq(table.fileType, q.type));
  if (q.folderId) where.push(eq(table.folderId, q.folderId));
  const result = await listWithCursor({ db, table, where, cursor: undefined, limit: q.pageSize });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('files:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'File', id);
  return success(c, row);
});

app.post('/', requireScope('files:write'), zValidator('json', createFileSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('fil');
  const values = { ...(body as Record<string, unknown>), id, createdAt: now, updatedAt: now };
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
