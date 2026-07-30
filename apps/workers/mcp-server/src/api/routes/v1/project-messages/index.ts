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
  createProjectMessageSchema,
  updateProjectMessageSchema,
} from '@weldsuite/core-api-client/schemas/project-messages';

const listProjectMessagesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  projectId: z.string().optional(),
});

const table = schema.projectMessages;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('project_messages:read'), zValidator('query', listProjectMessagesQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) where.push(like(table.message, `%${q.search}%`));
  if (q.projectId) where.push(eq(table.projectId, q.projectId));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('project_messages:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'ProjectMessage', id);
  return success(c, row);
});

app.post('/', requireScope('project_messages:write'), zValidator('json', createProjectMessageSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('pmsg');
  const values = { ...(body as Record<string, unknown>), id, senderId: (body as Record<string, unknown>).senderId ?? c.get('userId'), createdAt: now, updatedAt: now };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create project message');
  publishEntityEvent({
    c,
    entityType: 'project_message',
    entityId: id,
    action: 'created',
    data: { id, projectId: row.projectId },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('project_messages:write'), zValidator('json', updateProjectMessageSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'ProjectMessage', id);
  publishEntityEvent({
    c,
    entityType: 'project_message',
    entityId: id,
    action: 'updated',
    data: { id, projectId: row.projectId },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('project_messages:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'ProjectMessage', id);
  publishEntityEvent({
    c,
    entityType: 'project_message',
    entityId: id,
    action: 'deleted',
    data: { id, projectId: row.projectId },
  });
  return noContent(c);
});

export default app;
