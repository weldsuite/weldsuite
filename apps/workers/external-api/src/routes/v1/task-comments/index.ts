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
  createTaskCommentSchema,
  updateTaskCommentSchema,
} from '@weldsuite/core-api-client/schemas/task-comments';

const listTaskCommentsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  taskId: z.string().optional(),
});

const table = schema.taskComments;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('task_comments:read'), zValidator('query', listTaskCommentsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) where.push(like(table.content, `%${q.search}%`));
  if (q.taskId) where.push(eq(table.taskId, q.taskId));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('task_comments:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'TaskComment', id);
  return success(c, row);
});

app.post('/', requireScope('task_comments:write'), zValidator('json', createTaskCommentSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('tcmt');
  // Map schema `body` field to table `content`; fall back to body if both provided
  const { body: msgBody, authorId, taskId, ...rest } = body as Record<string, unknown>;
  const values = {
    ...rest,
    id,
    taskId,
    authorId: authorId ?? c.get('userId'),
    content: msgBody ?? '',
    taskType: (rest.taskType as string | undefined) ?? 'project',
    createdAt: now,
    updatedAt: now,
  };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create task comment');
  publishEntityEvent({
    c,
    entityType: 'task_comment',
    entityId: id,
    action: 'created',
    data: { id, taskId: row.taskId },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('task_comments:write'), zValidator('json', updateTaskCommentSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const { body: msgBody, ...rest } = body as Record<string, unknown>;
  const setValues: Record<string, unknown> = { ...rest, updatedAt: new Date() };
  if (msgBody !== undefined) setValues.content = msgBody;
  const [row] = await db
    .update(table)
    .set(setValues as Partial<typeof table.$inferInsert>)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'TaskComment', id);
  publishEntityEvent({
    c,
    entityType: 'task_comment',
    entityId: id,
    action: 'updated',
    data: { id, taskId: row.taskId },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('task_comments:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'TaskComment', id);
  publishEntityEvent({
    c,
    entityType: 'task_comment',
    entityId: id,
    action: 'deleted',
    data: { id, taskId: row.taskId },
  });
  return noContent(c);
});

export default app;
