import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  createProjectMemberSchema,
  updateProjectMemberSchema,
} from '@weldsuite/core-api-client/schemas/project-members';

const listProjectMembersQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  projectId: z.string().optional(),
  userId: z.string().optional(),
  role: z.string().optional(),
});

const table = schema.projectMembers;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('project_members:read'), zValidator('query', listProjectMembersQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.projectId) where.push(eq(table.projectId, q.projectId));
  if (q.userId) where.push(eq(table.userId, q.userId));
  if (q.role) where.push(eq(table.role, q.role));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('project_members:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'ProjectMember', id);
  return success(c, row);
});

app.post('/', requireScope('project_members:write'), zValidator('json', createProjectMemberSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('pmem');
  const values = { ...(body as Record<string, unknown>), id, createdAt: now, updatedAt: now };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create project member');
  publishEntityEvent({
    c,
    entityType: 'project_member',
    entityId: id,
    action: 'added',
    data: { id, projectId: row.projectId, userId: row.userId },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('project_members:write'), zValidator('json', updateProjectMemberSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'ProjectMember', id);
  publishEntityEvent({
    c,
    entityType: 'project_member',
    entityId: id,
    action: 'updated',
    data: { id, projectId: row.projectId, userId: row.userId },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('project_members:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'ProjectMember', id);
  publishEntityEvent({
    c,
    entityType: 'project_member',
    entityId: id,
    action: 'removed',
    data: { id, projectId: row.projectId, userId: row.userId },
  });
  return noContent(c);
});

export default app;
