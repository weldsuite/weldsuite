import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, gte, isNull, like, lte, or, sql, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  createTaskSchema,
  updateTaskSchema,
} from '@weldsuite/app-api-client/schemas/tasks';

const listTasksQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  projectId: z.string().optional(),
  assigneeId: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  type: z.string().optional(),
  sprintId: z.string().optional(),
  milestoneId: z.string().optional(),
  parentTaskId: z.string().optional(),
  dueDateFrom: z.string().optional(),
  dueDateTo: z.string().optional(),
});

/** Timestamp columns that arrive as ISO strings and must be coerced to Date. */
function coerceDates(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  for (const f of ['dueDate', 'startDate'] as const) {
    if (typeof out[f] === 'string') out[f] = new Date(out[f] as string);
  }
  return out;
}

const table = schema.tasks;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('tasks:read'), zValidator('query', listTasksQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) {
    const term = `%${q.search}%`;
    where.push(or(like(table.title, term), like(table.description, term)));
  }
  if (q.projectId) where.push(eq(table.projectId, q.projectId));
  if (q.status) where.push(eq(table.status, q.status));
  if (q.priority) where.push(eq(table.priority, q.priority));
  if (q.type) where.push(eq(table.type, q.type));
  if (q.sprintId) where.push(eq(table.sprintId, q.sprintId));
  if (q.milestoneId) where.push(eq(table.milestoneId, q.milestoneId));
  if (q.parentTaskId) where.push(eq(table.parentTaskId, q.parentTaskId));
  if (q.assigneeId) {
    where.push(
      or(eq(table.assigneeId, q.assigneeId), sql`${table.assigneeIds} @> ${JSON.stringify([q.assigneeId])}::jsonb`),
    );
  }
  if (q.dueDateFrom) where.push(gte(table.dueDate, new Date(q.dueDateFrom)));
  if (q.dueDateTo) where.push(lte(table.dueDate, new Date(q.dueDateTo)));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Task', id);
  return success(c, row);
});

app.post('/', requireScope('tasks:write'), zValidator('json', createTaskSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('task');
  const values = { ...coerceDates(body as Record<string, unknown>), id, createdAt: now, updatedAt: now };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create task');
  publishEntityEvent({
    c,
    entityType: 'project_task',
    entityId: id,
    action: 'created',
    data: { id, projectId: row.projectId, title: row.title },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('tasks:write'), zValidator('json', updateTaskSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...coerceDates(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Task', id);
  publishEntityEvent({
    c,
    entityType: 'project_task',
    entityId: id,
    action: 'updated',
    data: { id, projectId: row.projectId, title: row.title },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('tasks:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Task', id);
  publishEntityEvent({
    c,
    entityType: 'project_task',
    entityId: id,
    action: 'deleted',
    data: { id, projectId: row.projectId, title: row.title },
  });
  return noContent(c);
});

export default app;
