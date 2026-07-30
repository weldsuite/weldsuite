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
  createSprintSchema,
  updateSprintSchema,
} from '@weldsuite/core-api-client/schemas/sprints';

const listSprintsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  projectId: z.string().optional(),
  status: z.string().optional(),
});

function coerceDates(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  for (const f of ['startDate', 'endDate', 'startedAt', 'completedAt'] as const) {
    if (typeof out[f] === 'string') out[f] = new Date(out[f] as string);
  }
  return out;
}

const table = schema.sprints;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('sprints:read'), zValidator('query', listSprintsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) where.push(like(table.name, `%${q.search}%`));
  if (q.projectId) where.push(eq(table.projectId, q.projectId));
  if (q.status) where.push(eq(table.status, q.status));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('sprints:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Sprint', id);
  return success(c, row);
});

app.post('/', requireScope('sprints:write'), zValidator('json', createSprintSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('spr');
  const values = { ...coerceDates(body as Record<string, unknown>), id, createdAt: now, updatedAt: now };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create sprint');
  publishEntityEvent({
    c,
    entityType: 'project_sprint',
    entityId: id,
    action: 'created',
    data: { id, name: row.name, projectId: row.projectId },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('sprints:write'), zValidator('json', updateSprintSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...coerceDates(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Sprint', id);
  publishEntityEvent({
    c,
    entityType: 'project_sprint',
    entityId: id,
    action: 'updated',
    data: { id, name: row.name, projectId: row.projectId },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('sprints:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Sprint', id);
  publishEntityEvent({
    c,
    entityType: 'project_sprint',
    entityId: id,
    action: 'deleted',
    data: { id, name: row.name, projectId: row.projectId },
  });
  return noContent(c);
});

export default app;
