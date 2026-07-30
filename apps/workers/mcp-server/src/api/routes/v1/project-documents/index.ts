import { Hono } from 'hono';
import { z } from 'zod';
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
  createProjectDocumentSchema,
  updateProjectDocumentSchema,
} from '@weldsuite/core-api-client/schemas/project-documents';

const listProjectDocumentsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  projectId: z.string().optional(),
  parentId: z.string().optional(),
});

const table = schema.projectDocuments;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('project_documents:read'), zValidator('query', listProjectDocumentsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) where.push(like(table.title, `%${q.search}%`));
  if (q.projectId) where.push(eq(table.projectId, q.projectId));
  if (q.parentId) where.push(eq(table.parentId, q.parentId));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('project_documents:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'ProjectDocument', id);
  return success(c, row);
});

app.post('/', requireScope('project_documents:write'), zValidator('json', createProjectDocumentSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('pdoc');
  const values = { ...(body as Record<string, unknown>), id, createdAt: now, updatedAt: now };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create project document');
  publishEntityEvent({
    c,
    entityType: 'project_document',
    entityId: id,
    action: 'created',
    data: { id, projectId: row.projectId },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('project_documents:write'), zValidator('json', updateProjectDocumentSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'ProjectDocument', id);
  publishEntityEvent({
    c,
    entityType: 'project_document',
    entityId: id,
    action: 'updated',
    data: { id, projectId: row.projectId },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('project_documents:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'ProjectDocument', id);
  publishEntityEvent({
    c,
    entityType: 'project_document',
    entityId: id,
    action: 'deleted',
    data: { id, projectId: row.projectId },
  });
  return noContent(c);
});

export default app;
