/**
 * /api/task-dependencies: typed task dependencies: create, update type and lag,
 * delete, list by project or task (design: weldflow-delivery-and-portfolio.md;
 * ADR FLOW-015).
 *
 *   GET    /           list (projectId and/or taskId, cursor)
 *   POST   /           link two tasks of one project (type fs by default, lag 0)
 *   PATCH  /:id        change the type and/or the lag
 *   DELETE /:id        remove the link
 *
 * Permissions: projects:read | projects:update (a link is an edit of the
 * tasks it joins, as the control links are), plus the project membership
 * boundary (FLOW-001). The checks run in a fixed order so every backend answers
 * alike: permission, then the objects (404), then project access (403), then
 * the body (400), then the business rules.
 *
 * Compatibility, one release: `tasks.depends_on` / `tasks.blocks` stay, and a
 * write here keeps them in step in the same batch (the other direction is the
 * tasks routes', through `@weldsuite/flow-domain/task-dependencies`).
 */

import { Hono } from 'hono';
import { and, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  createTaskDependencySchema,
  listTaskDependenciesQuerySchema,
  updateTaskDependencySchema,
} from '@weldsuite/app-api-client/schemas/project-schedule';
import { DEPENDENCY_MESSAGES, withId, withoutId, wouldCloseCycle } from '@weldsuite/flow-domain/task-dependencies';
import type { Env, Variables } from '../../types';
import { canAccessProject, canWriteProject } from '../../lib/project-access';
import { parseLimit } from '../../lib/query-params';
import {
  PROJECT_DENIED,
  PROJECT_WRITE_DENIED,
  parseBody,
  readQuery,
  type ScheduleContext,
} from '../../lib/schedule-request';
import { taskAnalyticsPayload } from '../../lib/weldflow-analytics-payload';
import {
  findDependency,
  findTasksForLink,
  presentTaskDependency,
  taskDependencyEventData,
  type DependencyRow,
} from '../../services/project-schedule';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const deps = schema.taskDependencies;
const tasks = schema.tasks;

const LABEL = 'Dependency';

type LinkedTask = Awaited<ReturnType<typeof findTasksForLink>>[number];

function publishDependency(c: ScheduleContext, action: 'created' | 'updated' | 'deleted', row: DependencyRow) {
  publishEntityEvent({
    c,
    entityType: 'task_dependency',
    entityId: row.id,
    action,
    data: taskDependencyEventData(row),
  });
}

/** The tasks of a link changed their `dependsOn` / `blocks`: say so, as the tasks route does for the same edit. */
function publishLinkedTask(c: ScheduleContext, id: string, current: LinkedTask, patch: { dependsOn?: string[]; blocks?: string[] }) {
  publishEntityEvent({
    c,
    entityType: 'project_task',
    entityId: id,
    action: 'updated',
    data: taskAnalyticsPayload({ ...current, ...patch } as Record<string, unknown>),
  });
}

// ── List ────────────────────────────────────────────────────────────────────

/** The conditions of the list's scope (a project, a task), or the refusal when the caller may not see it. */
async function scopeConditions(
  c: ScheduleContext,
  db: Database,
  q: { projectId?: string; taskId?: string },
): Promise<{ ok: true; data: SQL[] } | { ok: false; response: Response }> {
  const conditions: SQL[] = [];
  if (q.projectId) {
    if (!(await canAccessProject(c, q.projectId))) return { ok: false, response: error.forbidden(c, PROJECT_DENIED) };
    conditions.push(eq(deps.projectId, q.projectId));
  }
  if (q.taskId) {
    const [task] = await findTasksForLink(db, [q.taskId]);
    if (!task) return { ok: false, response: error.notFound(c, 'Task', q.taskId) };
    if (!task.projectId || !(await canAccessProject(c, task.projectId))) return { ok: false, response: error.forbidden(c, PROJECT_DENIED) };
    conditions.push(or(eq(deps.predecessorId, q.taskId), eq(deps.successorId, q.taskId)) as SQL);
  }
  return { ok: true, data: conditions };
}

/** The keyset condition for the rows after the cursor, or null (no cursor, or it names no row). */
async function cursorCondition(db: Database, cursor: string | undefined): Promise<SQL | null> {
  if (!cursor) return null;
  const [cur] = await db.select({ createdAt: deps.createdAt, id: deps.id }).from(deps).where(eq(deps.id, cursor)).limit(1);
  if (!cur) return null;
  return sql`(${deps.createdAt} < ${cur.createdAt} OR (${deps.createdAt} = ${cur.createdAt} AND ${deps.id} < ${cur.id}))`;
}

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const query = readQuery(c, listTaskDependenciesQuerySchema);
  if (!query.ok) return query.response;
  const q = query.data;
  if (!q.projectId && !q.taskId) return error.badRequest(c, DEPENDENCY_MESSAGES.listScope);
  const limit = parseLimit(q.limit, 100, 500);

  const scoped = await scopeConditions(c, db, q);
  if (!scoped.ok) return scoped.response;
  const conditions = scoped.data;
  const countWhere = and(...conditions);
  const afterCursor = await cursorCondition(db, q.cursor);
  if (afterCursor) conditions.push(afterCursor);

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(deps).where(and(...conditions)).orderBy(desc(deps.createdAt), desc(deps.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(deps).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    return list(c, data.map(presentTaskDependency), cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor));
  } catch (err) {
    console.error('[flow-api/task-dependencies] list failed:', err);
    return error.internal(c, 'Failed to list dependencies');
  }
});

// ── Create ──────────────────────────────────────────────────────────────────

app.post('/', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = await parseBody(c, createTaskDependencySchema);
  if (!body.ok) return body.response;
  const input = body.data;
  if (input.predecessorId === input.successorId) return error.badRequest(c, DEPENDENCY_MESSAGES.self);

  try {
    const found = await findTasksForLink(db, [input.predecessorId, input.successorId]);
    const predecessor = found.find((task) => task.id === input.predecessorId);
    const successor = found.find((task) => task.id === input.successorId);
    if (!predecessor) return error.notFound(c, 'Task', input.predecessorId);
    if (!successor) return error.notFound(c, 'Task', input.successorId);
    if (!predecessor.projectId || !successor.projectId) return error.badRequest(c, DEPENDENCY_MESSAGES.noProject);
    // Both projects before anything is said about how they relate.
    if (!(await canWriteProject(c, predecessor.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
    if (successor.projectId !== predecessor.projectId && !(await canWriteProject(c, successor.projectId))) {
      return error.forbidden(c, PROJECT_WRITE_DENIED);
    }
    if (successor.projectId !== predecessor.projectId) return error.badRequest(c, DEPENDENCY_MESSAGES.differentProjects);

    const [existing] = await db
      .select({ id: deps.id })
      .from(deps)
      .where(and(eq(deps.predecessorId, input.predecessorId), eq(deps.successorId, input.successorId)))
      .limit(1);
    if (existing) return error.conflict(c, DEPENDENCY_MESSAGES.duplicate);
    if (await wouldCloseCycle(db, input.predecessorId, input.successorId)) {
      return error.badRequest(c, DEPENDENCY_MESSAGES.cycle);
    }

    const now = new Date();
    const id = generateId('tdp');
    const nextDependsOn = withId(successor.dependsOn, predecessor.id);
    const nextBlocks = withId(predecessor.blocks, successor.id);
    await atomically(db, (handle) => [
      handle.insert(deps).values({
        id,
        projectId: predecessor.projectId as string,
        predecessorId: predecessor.id,
        successorId: successor.id,
        type: input.type ?? 'fs',
        lagDays: input.lagDays ?? 0,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      }),
      // The arrays stay in step while they exist.
      handle.update(tasks).set({ dependsOn: nextDependsOn, updatedAt: now }).where(eq(tasks.id, successor.id)),
      handle.update(tasks).set({ blocks: nextBlocks, updatedAt: now }).where(eq(tasks.id, predecessor.id)),
    ]);
    const row = await findDependency(db, id);
    if (!row) return error.internal(c, 'Failed to create dependency');

    publishDependency(c, 'created', row);
    publishLinkedTask(c, predecessor.id, predecessor, { blocks: nextBlocks });
    publishLinkedTask(c, successor.id, successor, { dependsOn: nextDependsOn });
    return success(c, presentTaskDependency(row), 201);
  } catch (err) {
    console.error('[flow-api/task-dependencies] create failed:', err);
    return error.internal(c, 'Failed to create dependency');
  }
});

// ── Update ──────────────────────────────────────────────────────────────────

app.patch('/:id', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await findDependency(db, id);
  if (!existing) return error.notFound(c, LABEL, id);
  if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  const body = await parseBody(c, updateTaskDependencySchema);
  if (!body.ok) return body.response;

  try {
    const now = new Date();
    await db
      .update(deps)
      .set({
        ...(body.data.type !== undefined && { type: body.data.type }),
        ...(body.data.lagDays !== undefined && { lagDays: body.data.lagDays }),
        updatedAt: now,
      })
      .where(eq(deps.id, id));
    const row = await findDependency(db, id);
    if (!row) return error.notFound(c, LABEL, id);
    publishDependency(c, 'updated', row);
    return success(c, presentTaskDependency(row));
  } catch (err) {
    console.error('[flow-api/task-dependencies] update failed:', err);
    return error.internal(c, 'Failed to update dependency');
  }
});

// ── Delete ──────────────────────────────────────────────────────────────────

app.delete('/:id', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const existing = await findDependency(db, id);
    if (!existing) return error.notFound(c, LABEL, id);
    if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);

    const [predecessor, successor] = await Promise.all([
      findTasksForLink(db, [existing.predecessorId]).then((rows) => rows[0] ?? null),
      findTasksForLink(db, [existing.successorId]).then((rows) => rows[0] ?? null),
    ]);
    const now = new Date();
    const nextBlocks = predecessor ? withoutId(predecessor.blocks, existing.successorId) : null;
    const nextDependsOn = successor ? withoutId(successor.dependsOn, existing.predecessorId) : null;
    await atomically(db, (handle) => [
      handle.delete(deps).where(eq(deps.id, id)),
      ...(predecessor && nextBlocks
        ? [handle.update(tasks).set({ blocks: nextBlocks, updatedAt: now }).where(eq(tasks.id, predecessor.id))]
        : []),
      ...(successor && nextDependsOn
        ? [handle.update(tasks).set({ dependsOn: nextDependsOn, updatedAt: now }).where(eq(tasks.id, successor.id))]
        : []),
    ]);

    publishDependency(c, 'deleted', existing);
    if (predecessor && nextBlocks) publishLinkedTask(c, predecessor.id, predecessor, { blocks: nextBlocks });
    if (successor && nextDependsOn) publishLinkedTask(c, successor.id, successor, { dependsOn: nextDependsOn });
    return noContent(c);
  } catch (err) {
    console.error('[flow-api/task-dependencies] delete failed:', err);
    return error.internal(c, 'Failed to delete dependency');
  }
});

export const taskDependenciesRoutes = app;
