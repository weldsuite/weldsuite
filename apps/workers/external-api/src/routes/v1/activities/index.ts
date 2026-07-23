import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, like, or, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  createActivitySchema,
  updateActivitySchema,
  listActivitiesQuery,
} from '@weldsuite/core-api-client/schemas/activities';

const table = schema.crmActivities;
const app = new Hono<HonoEnv>();

/** Timestamp columns that arrive as ISO strings and must be coerced to Date. */
const DATE_FIELDS = new Set(['dueDate', 'startTime', 'endTime', 'followUpDate']);

app.get('/', requireScope('activities:read'), zValidator('query', listActivitiesQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) {
    const term = `%${q.search}%`;
    where.push(or(like(table.subject, term), like(table.description, term)));
  }
  if (q.type) where.push(eq(table.type, q.type));
  if (q.status) where.push(eq(table.status, q.status));
  if (q.assignedToId) where.push(eq(table.assignedToId, q.assignedToId));
  if (q.customerId) where.push(eq(table.customerId, q.customerId));
  if (q.contactId) where.push(eq(table.contactId, q.contactId));
  if (q.leadId) where.push(eq(table.leadId, q.leadId));
  if (q.opportunityId) where.push(eq(table.opportunityId, q.opportunityId));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('activities:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Activity', id);
  return success(c, row);
});

app.post('/', requireScope('activities:write'), zValidator('json', createActivitySchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  // assignedToId references a real workspace member — fall back to the key's
  // user (personal keys only); workspace keys must supply it explicitly.
  const assignedToId = body.assignedToId ?? c.get('apiSession').userId;
  if (!assignedToId) return error.badRequest(c, 'assignedToId is required for workspace API keys');
  const now = new Date();
  const id = generateId('act');
  const values = {
    ...(body as Record<string, unknown>),
    id,
    assignedToId,
    status: body.status ?? 'planned',
    priority: body.priority ?? 'medium',
    dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
    startTime: body.startTime ? new Date(body.startTime) : undefined,
    endTime: body.endTime ? new Date(body.endTime) : undefined,
    followUpDate: body.followUpDate ? new Date(body.followUpDate) : undefined,
    createdAt: now,
    updatedAt: now,
  };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create activity');
  publishEntityEvent({
    c,
    entityType: 'activity',
    entityId: id,
    action: 'created',
    data: {
      id,
      type: row.type,
      subject: row.subject,
      status: row.status,
      customerId: row.customerId,
      contactId: row.contactId,
      assigneeId: row.assignedToId,
      dueDate: row.dueDate ? new Date(row.dueDate).toISOString() : null,
    },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('activities:write'), zValidator('json', updateActivitySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [existing] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!existing) return error.notFound(c, 'Activity', id);
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    update[k] = DATE_FIELDS.has(k) && typeof v === 'string' ? new Date(v) : v;
  }
  const [row] = await db
    .update(table)
    .set(update)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.internal(c, 'Failed to update activity');
  publishEntityEvent({
    c,
    entityType: 'activity',
    entityId: id,
    action: 'updated',
    data: {
      id,
      type: row.type,
      subject: row.subject,
      status: row.status,
      customerId: row.customerId,
      contactId: row.contactId,
      assigneeId: row.assignedToId,
    },
  });
  if (row.status === 'completed' && existing.status !== 'completed') {
    publishEntityEvent({
      c,
      entityType: 'activity',
      entityId: id,
      action: 'completed',
      data: { id, type: row.type },
    });
  }
  return success(c, row);
});

app.delete('/:id', requireScope('activities:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Activity', id);
  publishEntityEvent({
    c,
    entityType: 'activity',
    entityId: id,
    action: 'deleted',
    data: { id, type: row.type, customerId: row.customerId, contactId: row.contactId },
  });
  return noContent(c);
});

export default app;
