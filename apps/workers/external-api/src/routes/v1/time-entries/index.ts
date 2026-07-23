import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, gte, isNull, lte, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';

// Mirrors app-api's inline time-entry schema (the legacy core-api-client
// schema used field names that do not match the `time_entries` columns).
const createTimeEntrySchema = z
  .object({
    projectId: z.string().optional(),
    taskId: z.string().optional(),
    // Personal keys infer userId from the session; workspace keys must pass it.
    userId: z.string().optional(),
    date: z.string(),
    duration: z.union([z.string(), z.number()]),
    description: z.string().optional(),
    activity: z.string().optional(),
    billable: z.boolean().default(true),
    rate: z.union([z.string(), z.number()]).optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    location: z.string().optional(),
    isRemote: z.boolean().default(false),
  })
  .passthrough();

const updateTimeEntrySchema = createTimeEntrySchema.partial();

const listTimeEntriesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  userId: z.string().optional(),
  status: z.string().optional(),
  billable: z.coerce.boolean().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});

function computeCost(rate?: string | number | null, duration?: string | number | null): string | null {
  if (rate === undefined || rate === null || duration === undefined || duration === null) return null;
  const r = Number(rate);
  const d = Number(duration);
  if (!Number.isFinite(r) || !Number.isFinite(d)) return null;
  return String((d / 60) * r);
}

const table = schema.timeEntries;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('time_entries:read'), zValidator('query', listTimeEntriesQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.projectId) where.push(eq(table.projectId, q.projectId));
  if (q.taskId) where.push(eq(table.taskId, q.taskId));
  if (q.userId) where.push(eq(table.userId, q.userId));
  if (q.status) where.push(eq(table.status, q.status));
  if (q.billable !== undefined) where.push(eq(table.billable, q.billable));
  if (q.fromDate) where.push(gte(table.date, q.fromDate));
  if (q.toDate) where.push(lte(table.date, q.toDate));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('time_entries:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'TimeEntry', id);
  return success(c, row);
});

app.post('/', requireScope('time_entries:write'), zValidator('json', createTimeEntrySchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const userId = c.get('apiSession').userId ?? body.userId;
  if (!userId) return error.badRequest(c, 'userId is required for workspace API keys');
  const now = new Date();
  const id = generateId('te');
  const [row] = await db
    .insert(table)
    .values({
      id,
      projectId: body.projectId ?? null,
      taskId: body.taskId ?? null,
      userId,
      date: body.date,
      duration: String(body.duration),
      description: body.description ?? null,
      activity: body.activity ?? null,
      billable: body.billable ?? true,
      rate: body.rate !== undefined ? String(body.rate) : null,
      cost: computeCost(body.rate, body.duration),
      startTime: body.startTime ? new Date(body.startTime) : null,
      endTime: body.endTime ? new Date(body.endTime) : null,
      location: body.location ?? null,
      isRemote: body.isRemote ?? false,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    } as typeof table.$inferInsert)
    .returning();
  if (!row) return error.internal(c, 'Failed to create time entry');
  publishEntityEvent({
    c,
    entityType: 'project_time_entry',
    entityId: id,
    action: 'created',
    data: { id, projectId: row.projectId ?? null, taskId: row.taskId ?? null, userId, duration: Number(row.duration) },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('time_entries:write'), zValidator('json', updateTimeEntrySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [existing] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!existing) return error.notFound(c, 'TimeEntry', id);
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (body.date !== undefined) update.date = body.date;
  if (body.duration !== undefined) update.duration = String(body.duration);
  if (body.description !== undefined) update.description = body.description;
  if (body.activity !== undefined) update.activity = body.activity;
  if (body.billable !== undefined) update.billable = body.billable;
  if (body.rate !== undefined) update.rate = body.rate === null ? null : String(body.rate);
  if (body.startTime !== undefined) update.startTime = body.startTime ? new Date(body.startTime) : null;
  if (body.endTime !== undefined) update.endTime = body.endTime ? new Date(body.endTime) : null;
  if (body.location !== undefined) update.location = body.location;
  if (body.isRemote !== undefined) update.isRemote = body.isRemote;
  if (body.taskId !== undefined) update.taskId = body.taskId;
  if (body.projectId !== undefined) update.projectId = body.projectId;
  if (body.rate !== undefined || body.duration !== undefined) {
    update.cost = computeCost(body.rate ?? existing.rate, body.duration ?? existing.duration);
  }
  const [row] = await db
    .update(table)
    .set(update)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.internal(c, 'Failed to update time entry');
  publishEntityEvent({
    c,
    entityType: 'project_time_entry',
    entityId: id,
    action: 'updated',
    data: {
      id,
      projectId: row.projectId ?? null,
      taskId: row.taskId ?? null,
      userId: row.userId,
      duration: Number(row.duration),
    },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('time_entries:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'TimeEntry', id);
  publishEntityEvent({
    c,
    entityType: 'project_time_entry',
    entityId: id,
    action: 'deleted',
    data: {
      id,
      projectId: row.projectId ?? null,
      taskId: row.taskId ?? null,
      userId: row.userId,
      duration: Number(row.duration),
    },
  });
  return noContent(c);
});

export default app;
