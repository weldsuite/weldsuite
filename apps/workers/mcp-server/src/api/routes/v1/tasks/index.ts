import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, gte, inArray, isNull, like, lte, or, sql, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { softDeleteTaskTree } from '@weldsuite/flow-domain/task-tree';
import { applyStatusChange } from '@weldsuite/flow-domain/task-stage';
import { createTask } from '@weldsuite/flow-domain/tasks';
import {
  checkNewTaskLinks,
  commitDependencyUpdate,
  planDependencyUpdate,
  validateTaskRelations,
} from '@weldsuite/flow-domain/task-dependencies';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  createTaskSchema,
  taskStatusAliases,
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

/**
 * Drop server-owned columns a client must not set. PATCH validates against an
 * explicit allow-list (`updateTaskSchema`), so none of these reach here today;
 * this stays as defence in depth should the schema ever widen. A PATCH carrying
 * `number` would renumber a task — or collide with the unique index and surface
 * as a 500.
 */
function stripServerOwned(data: Record<string, unknown>): Record<string, unknown> {
  const {
    number: _number,
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    deletedAt: _deletedAt,
    ...rest
  } = data;
  return rest;
}

const table = schema.tasks;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('tasks:read'), zValidator('query', listTasksQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) {
    const term = `%${q.search}%`;
    const clauses = [like(table.title, term), like(table.description, term)];
    // Let callers find a task by its number: "TASK-1042", "#1042", or "1042".
    const numberMatch = q.search.trim().replace(/^#/, '').replace(/^task-/i, '');
    if (/^\d+$/.test(numberMatch)) clauses.push(eq(table.number, Number(numberMatch)));
    where.push(or(...clauses));
  }
  if (q.projectId) where.push(eq(table.projectId, q.projectId));
  // Every stored spelling: `review` also finds rows still on the legacy `in_review`.
  if (q.status) where.push(inArray(table.status, taskStatusAliases(q.status)));
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

// Create goes through flow-domain's `createTask`, the insert flow-api uses: it
// writes named columns only (a client cannot set `deletedAt`, `key`, `watchers`,
// `position`, `progress`, ... even if it sends them), allocates the number and
// position, and derives the status from the stage. `.strip()` drops unknown
// keys up front (the shared create schema is `.passthrough()`).
const createBodySchema = createTaskSchema.strip();

app.post('/', requireScope('tasks:write'), zValidator('json', createBodySchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  // dependsOn / blocks are links, not plain columns: written below with their
  // reciprocal side once the task exists.
  const { dependsOn, blocks, ...data } = c.req.valid('json') as Record<string, unknown> & {
    dependsOn?: string[];
    blocks?: string[];
  };
  const projectId = (data.projectId as string | null | undefined) ?? null;
  if (projectId) {
    const [project] = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)))
      .limit(1);
    if (!project) return error.notFound(c, 'Project', projectId);
  }
  const relationError = await validateTaskRelations(db, null, null, {
    projectId,
    parentTaskId: data.parentTaskId as string | null | undefined,
  });
  if (relationError) return error.badRequest(c, relationError);
  const hasLinks = dependsOn !== undefined || blocks !== undefined;
  if (hasLinks) {
    const linkFailure = await checkNewTaskLinks(db, { dependsOn, blocks });
    if (linkFailure) return error.badRequest(c, linkFailure.message);
  }

  const { row: created } = await createTask(db, coerceDates(data), { projectId, userId });
  let row = created;
  if (hasLinks) {
    const plan = await planDependencyUpdate(db, created.id, { dependsOn, blocks });
    if (!plan.ok) return error.badRequest(c, plan.message);
    await commitDependencyUpdate(db, created.id, plan);
    const [linked] = await db.select().from(table).where(eq(table.id, created.id)).limit(1);
    if (linked) row = linked;
  }
  publishEntityEvent({
    c,
    entityType: 'project_task',
    entityId: row.id,
    action: 'created',
    data: { id: row.id, projectId: row.projectId, title: row.title },
  });
  return success(c, row, 201);
});

/**
 * The only `tasks` columns a PATCH writes (mirrors flow-api's list). Listed here
 * as well as in `updateTaskSchema` so a future schema addition cannot silently
 * become a column write. `assigneeIds` goes through `syncAssigneeFields`;
 * `projectId`, `dependsOn` and `blocks` have their own handling in the handler.
 */
const PATCHABLE_TASK_COLUMNS = [
  'title',
  'description',
  'status',
  'priority',
  'type',
  'stageId',
  'sprintId',
  'milestoneId',
  'parentTaskId',
  'assigneeId',
  'customerId',
  'contactId',
  'personId',
  'startDate',
  'dueDate',
  'estimatedHours',
  'duration',
  'storyPoints',
  'labels',
  'tags',
  'isBillable',
  'repeat',
  'customFields',
] as const;

/** Keep `assigneeId` and `assigneeIds` consistent with whichever one the caller sent. */
function syncAssigneeFields(update: Record<string, unknown>, data: Record<string, unknown>): void {
  if (data.assigneeIds !== undefined) {
    const ids = (data.assigneeIds as string[] | null) ?? [];
    update.assigneeIds = ids.length > 0 ? ids : null;
    update.assigneeId = ids[0] ?? null;
  } else if (data.assigneeId !== undefined) {
    update.assigneeIds = data.assigneeId ? [data.assigneeId] : null;
  }
}

app.patch('/:id', requireScope('tasks:write'), zValidator('json', updateTaskSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  // projectId / dependsOn / blocks are not plain column writes, see below.
  const { projectId: _projectId, dependsOn, blocks, ...data } = body;
  const [existing] = await db
    .select({
      projectId: table.projectId,
      parentTaskId: table.parentTaskId,
      stageId: table.stageId,
      status: table.status,
    })
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!existing) return error.notFound(c, 'Task', id);

  // A project change is a move (sprint / milestone / stage / key / position all
  // reset), not a column write, so PATCH may only repeat the current project.
  // A changed parent must be a live task of the same project.
  const relationError = await validateTaskRelations(db, existing, id, body);
  if (relationError) return error.badRequest(c, relationError);

  // Dependencies get the same existence + cycle checks and reciprocal sync as
  // flow-api. Validated here, written below together with the columns.
  let dependencyPlan: Awaited<ReturnType<typeof planDependencyUpdate>> | null = null;
  if (dependsOn !== undefined || blocks !== undefined) {
    const plan = await planDependencyUpdate(db, id, { dependsOn, blocks });
    if (!plan.ok) {
      return plan.kind === 'not-found' ? error.notFound(c, 'Task', id) : error.badRequest(c, plan.message);
    }
    dependencyPlan = plan;
  }

  const coerced = stripServerOwned(coerceDates(data as Record<string, unknown>));
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of PATCHABLE_TASK_COLUMNS) {
    if (coerced[k] !== undefined) update[k] = coerced[k];
  }
  syncAssigneeFields(update, coerced);
  // Keep status and board column in step, as flow-api does: boards place a task
  // by stageId first, so a status change alone would leave it in its old column.
  await applyStatusChange(db, existing, body, update);
  if (dependencyPlan) {
    await commitDependencyUpdate(db, id, dependencyPlan, update);
  } else {
    await db
      .update(table)
      .set(update)
      .where(and(eq(table.id, id), isNull(table.deletedAt)));
  }
  const [row] = await db.select().from(table).where(eq(table.id, id)).limit(1);
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

// Takes the subtask tree, calendar slots and dependency links with it, the
// same as flow-api's DELETE /api/tasks/:id.
app.delete('/:id', requireScope('tasks:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const removed = await softDeleteTaskTree(db, id);
  if (!removed) return error.notFound(c, 'Task', id);
  for (const row of removed) {
    publishEntityEvent({
      c,
      entityType: 'project_task',
      entityId: row.id,
      action: 'deleted',
      data: { id: row.id, projectId: row.projectId, title: row.title },
    });
  }
  return noContent(c);
});

export default app;
