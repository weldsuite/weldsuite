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
  createProjectLabelSchema,
  updateProjectLabelSchema,
} from '@weldsuite/core-api-client/schemas/project-labels';

const listProjectLabelsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  projectId: z.string().optional(),
});

const table = schema.projectLabels;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('project_labels:read'), zValidator('query', listProjectLabelsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) where.push(like(table.name, `%${q.search}%`));
  if (q.projectId) where.push(eq(table.projectId, q.projectId));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('project_labels:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'ProjectLabel', id);
  return success(c, row);
});

app.post('/', requireScope('project_labels:write'), zValidator('json', createProjectLabelSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('plbl');
  // color is NOT NULL in the DB but optional in the schema — default it so a
  // label without an explicit colour creates cleanly instead of 500ing.
  const color = body.color ?? '#6B7280';
  const values = { ...(body as Record<string, unknown>), id, color, createdAt: now, updatedAt: now };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create project label');
  publishEntityEvent({
    c,
    entityType: 'project_label',
    entityId: id,
    action: 'created',
    data: { id, name: row.name },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('project_labels:write'), zValidator('json', updateProjectLabelSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'ProjectLabel', id);
  publishEntityEvent({
    c,
    entityType: 'project_label',
    entityId: id,
    action: 'updated',
    data: { id, name: row.name },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('project_labels:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'ProjectLabel', id);
  publishEntityEvent({
    c,
    entityType: 'project_label',
    entityId: id,
    action: 'deleted',
    data: { id, name: row.name },
  });
  return noContent(c);
});

export default app;
