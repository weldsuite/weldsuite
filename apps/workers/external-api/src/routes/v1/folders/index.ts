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
  listFoldersQuery,
  createFolderSchema,
  updateFolderSchema,
} from '@weldsuite/core-api-client/schemas/folders';

const table = schema.folders;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('folders:read'), zValidator('query', listFoldersQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.parentId) where.push(eq(table.parentId, q.parentId));
  const result = await listWithCursor({ db, table, where, cursor: undefined, limit: undefined });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('folders:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Folder', id);
  return success(c, row);
});

app.post('/', requireScope('folders:write'), zValidator('json', createFolderSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('fld');
  const values = { ...(body as Record<string, unknown>), id, createdAt: now, updatedAt: now };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create folder');
  publishEntityEvent({
    c,
    entityType: 'folder',
    entityId: id,
    action: 'created',
    data: { id, name: row.name, parentId: row.parentId },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('folders:write'), zValidator('json', updateFolderSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Folder', id);
  publishEntityEvent({
    c,
    entityType: 'folder',
    entityId: id,
    action: 'updated',
    data: { id, name: row.name, parentId: row.parentId },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('folders:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Folder', id);
  publishEntityEvent({
    c,
    entityType: 'folder',
    entityId: id,
    action: 'deleted',
    data: { id, name: row.name, parentId: row.parentId },
  });
  return noContent(c);
});

export default app;
