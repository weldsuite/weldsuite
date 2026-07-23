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
  createPipelineSchema,
  updatePipelineSchema,
  listPipelinesQuery,
} from '@weldsuite/core-api-client/schemas/pipelines-crm';

const table = schema.crmPipelines;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('pipelines:read'), zValidator('query', listPipelinesQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) where.push(like(table.name, `%${q.search}%`));
  if (q.archived === 'active') where.push(eq(table.isArchived, false));
  else if (q.archived === 'archived') where.push(eq(table.isArchived, true));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('pipelines:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Pipeline', id);
  return success(c, row);
});

app.post('/', requireScope('pipelines:write'), zValidator('json', createPipelineSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('pl');
  const values = { ...(body as Record<string, unknown>), id, createdAt: now, updatedAt: now };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create pipeline');
  publishEntityEvent({ c, entityType: 'pipeline', entityId: id, action: 'created', data: { id, name: row.name } });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('pipelines:write'), zValidator('json', updatePipelineSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Pipeline', id);
  publishEntityEvent({ c, entityType: 'pipeline', entityId: id, action: 'updated', data: { id, name: row.name } });
  return success(c, row);
});

app.delete('/:id', requireScope('pipelines:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Pipeline', id);
  publishEntityEvent({ c, entityType: 'pipeline', entityId: id, action: 'deleted', data: { id, name: row.name } });
  return noContent(c);
});

export default app;
