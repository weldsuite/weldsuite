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
  createProjectSchema,
  updateProjectSchema,
} from '@weldsuite/app-api-client/schemas/projects';

const listProjectsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  status: z.string().optional(),
  ownerId: z.string().optional(),
  isActive: z.coerce.boolean().optional(),
});

/** Timestamp columns that arrive as ISO strings and must be coerced to Date. */
function coerceDates(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  for (const f of ['startDate', 'endDate'] as const) {
    if (typeof out[f] === 'string') out[f] = new Date(out[f] as string);
  }
  return out;
}

const table = schema.projects;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('projects:read'), zValidator('query', listProjectsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) where.push(like(table.name, `%${q.search}%`));
  if (q.ownerId) where.push(eq(table.projectManagerId, q.ownerId));
  if (q.status) where.push(eq(table.status, q.status));
  if (q.isActive !== undefined) where.push(eq(table.isActive, q.isActive));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Project', id);
  return success(c, row);
});

app.post('/', requireScope('projects:write'), zValidator('json', createProjectSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('prj');
  const values = { ...coerceDates(body as Record<string, unknown>), id, createdAt: now, updatedAt: now };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create project');
  publishEntityEvent({ c, entityType: 'project', entityId: id, action: 'created', data: { id, name: row.name } });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('projects:write'), zValidator('json', updateProjectSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...coerceDates(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Project', id);
  publishEntityEvent({ c, entityType: 'project', entityId: id, action: 'updated', data: { id, name: row.name } });
  return success(c, row);
});

app.delete('/:id', requireScope('projects:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Project', id);
  publishEntityEvent({ c, entityType: 'project', entityId: id, action: 'deleted', data: { id, name: row.name } });
  return noContent(c);
});

export default app;
