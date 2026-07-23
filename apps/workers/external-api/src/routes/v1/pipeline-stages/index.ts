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
  createPipelineStageSchema,
  updatePipelineStageSchema,
  listPipelineStagesQuery,
} from '@weldsuite/core-api-client/schemas/pipeline-stages';

const table = schema.crmPipelineStages;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('pipeline_stages:read'), zValidator('query', listPipelineStagesQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.pipeline) where.push(eq(table.pipeline, q.pipeline));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('pipeline_stages:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Pipeline stage', id);
  return success(c, row);
});

app.post('/', requireScope('pipeline_stages:write'), zValidator('json', createPipelineStageSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('pls');
  const values = { ...(body as Record<string, unknown>), id, createdAt: now, updatedAt: now };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create pipeline stage');
  publishEntityEvent({ c, entityType: 'pipeline_stage', entityId: id, action: 'created', data: { id, name: row.name, pipeline: row.pipeline } });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('pipeline_stages:write'), zValidator('json', updatePipelineStageSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Pipeline stage', id);
  publishEntityEvent({ c, entityType: 'pipeline_stage', entityId: id, action: 'updated', data: { id, name: row.name, pipeline: row.pipeline } });
  return success(c, row);
});

app.delete('/:id', requireScope('pipeline_stages:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Pipeline stage', id);
  publishEntityEvent({ c, entityType: 'pipeline_stage', entityId: id, action: 'deleted', data: { id, name: row.name } });
  return noContent(c);
});

export default app;
