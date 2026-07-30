import { Hono } from 'hono';
import { z } from 'zod';
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
  createWorkflowSchema,
  updateWorkflowSchema,
  createScheduleSchema,
  updateScheduleSchema,
} from '@weldsuite/core-api-client/schemas/weldconnect';

// Nested schedule create takes workflowId from the URL, not the body.
const createScheduleBody = createScheduleSchema.omit({ workflowId: true });

const listWorkflowsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  status: z.string().optional(),
  folderId: z.string().optional(),
});

const listSchedulesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  isEnabled: z.coerce.boolean().optional(),
});

const listExecutionsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  status: z.string().optional(),
});

const workflowTable = schema.workflows;
const scheduleTable = schema.workflowSchedules;
const executionTable = schema.workflowExecutions;

const app = new Hono<HonoEnv>();

// ---- Workflows ---------------------------------------------------------------

app.get('/', requireScope('workflows:read'), zValidator('query', listWorkflowsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) {
    const term = `%${q.search}%`;
    where.push(or(like(workflowTable.name, term), like(workflowTable.description, term)));
  }
  if (q.status) where.push(eq(workflowTable.status, q.status));
  if (q.folderId) where.push(eq(workflowTable.folderId, q.folderId));
  const result = await listWithCursor({ db, table: workflowTable, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('workflows:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(workflowTable)
    .where(and(eq(workflowTable.id, id), isNull(workflowTable.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Workflow', id);
  return success(c, row);
});

app.post('/', requireScope('workflows:write'), zValidator('json', createWorkflowSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json') as Record<string, unknown>;
  const now = new Date();
  const id = generateId('wf');
  const values = {
    ...body,
    id,
    status: body.status ?? 'draft',
    triggers: body.triggers ?? [],
    steps: body.steps ?? [],
    settings: body.settings ?? {},
    tags: body.tags ?? [],
    createdBy: c.get('userId'),
    version: 1,
    executionCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const [row] = await db.insert(workflowTable).values(values as typeof workflowTable.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create workflow');
  publishEntityEvent({ c, entityType: 'workflow', entityId: id, action: 'created', data: { id, name: row.name } });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('workflows:write'), zValidator('json', updateWorkflowSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(workflowTable)
    .set({ ...(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(workflowTable.id, id), isNull(workflowTable.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Workflow', id);
  publishEntityEvent({ c, entityType: 'workflow', entityId: id, action: 'updated', data: { id, name: row.name, status: row.status } });
  return success(c, row);
});

app.delete('/:id', requireScope('workflows:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(workflowTable)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(workflowTable.id, id), isNull(workflowTable.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Workflow', id);
  publishEntityEvent({ c, entityType: 'workflow', entityId: id, action: 'deleted', data: { id, name: row.name, status: row.status } });
  return noContent(c);
});

// ---- Nested: /:workflowId/schedules -----------------------------------------

const schedulesApp = new Hono<HonoEnv>();

schedulesApp.get('/', requireScope('workflows:read'), zValidator('query', listSchedulesQuery), async (c) => {
  const db = c.get('tenantDb');
  const workflowId = c.req.param('workflowId') as string;
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [eq(scheduleTable.workflowId, workflowId)];
  if (q.isEnabled !== undefined) where.push(eq(scheduleTable.isEnabled, q.isEnabled));
  const result = await listWithCursor({ db, table: scheduleTable, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

schedulesApp.get('/:id', requireScope('workflows:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(scheduleTable)
    .where(and(eq(scheduleTable.id, id), isNull(scheduleTable.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'WorkflowSchedule', id);
  return success(c, row);
});

schedulesApp.post('/', requireScope('workflows:write'), zValidator('json', createScheduleBody), async (c) => {
  const db = c.get('tenantDb');
  const workflowId = c.req.param('workflowId') as string;
  const body = c.req.valid('json');
  // Verify the parent workflow exists.
  const [workflow] = await db
    .select({ id: workflowTable.id })
    .from(workflowTable)
    .where(and(eq(workflowTable.id, workflowId), isNull(workflowTable.deletedAt)))
    .limit(1);
  if (!workflow) return error.notFound(c, 'Workflow', workflowId);
  const now = new Date();
  const id = generateId('wfs');
  const [row] = await db
    .insert(scheduleTable)
    .values({
      ...(body as Record<string, unknown>),
      id,
      workflowId,
      startDate: body.startDate ? new Date(body.startDate) : undefined,
      endDate: body.endDate ? new Date(body.endDate) : undefined,
      createdAt: now,
      updatedAt: now,
    } as typeof scheduleTable.$inferInsert)
    .returning();
  if (!row) return error.internal(c, 'Failed to create workflow schedule');
  publishEntityEvent({ c, entityType: 'workflow_schedule', entityId: id, action: 'created', data: { id, workflowId } });
  return success(c, row, 201);
});

schedulesApp.patch('/:id', requireScope('workflows:write'), zValidator('json', updateScheduleSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json') as Record<string, unknown>;
  const update: Record<string, unknown> = { ...body, updatedAt: new Date() };
  if (typeof body.startDate === 'string') update.startDate = new Date(body.startDate);
  if (typeof body.endDate === 'string') update.endDate = new Date(body.endDate);
  const [row] = await db
    .update(scheduleTable)
    .set(update)
    .where(and(eq(scheduleTable.id, id), isNull(scheduleTable.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'WorkflowSchedule', id);
  publishEntityEvent({ c, entityType: 'workflow_schedule', entityId: id, action: 'updated', data: { id } });
  return success(c, row);
});

schedulesApp.delete('/:id', requireScope('workflows:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(scheduleTable)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(scheduleTable.id, id), isNull(scheduleTable.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'WorkflowSchedule', id);
  publishEntityEvent({ c, entityType: 'workflow_schedule', entityId: id, action: 'deleted', data: { id } });
  return noContent(c);
});

// ---- Nested: /:workflowId/executions (read-only) ----------------------------

const executionsApp = new Hono<HonoEnv>();

executionsApp.get('/', requireScope('workflows:read'), zValidator('query', listExecutionsQuery), async (c) => {
  const db = c.get('tenantDb');
  const workflowId = c.req.param('workflowId') as string;
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [eq(executionTable.workflowId, workflowId)];
  if (q.status) where.push(eq(executionTable.status, q.status));
  // workflowExecutions has no deletedAt
  const result = await listWithCursor({
    db,
    table: executionTable,
    where,
    cursor: q.cursor,
    limit: q.limit,
    softDelete: false,
  });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

executionsApp.get('/:id', requireScope('workflows:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(executionTable)
    .where(eq(executionTable.id, id))
    .limit(1);
  if (!row) return error.notFound(c, 'WorkflowExecution', id);
  return success(c, row);
});

app.route('/:workflowId/schedules', schedulesApp);
app.route('/:workflowId/executions', executionsApp);

export default app;
