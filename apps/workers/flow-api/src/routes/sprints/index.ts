/**
 * Sprint routes — flat /api/sprints/* surface backed by `sprints`.
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createSprintSchema, updateSprintSchema } from '@weldsuite/core-api-client/schemas/sprints';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import { accessibleProjectIds, canAccessProject, canWriteProject, projectNotDeleted } from '../../lib/project-access';
import { containsPattern } from '../../lib/ilike-pattern';
import {
  SPRINT_TIMESTAMP_FIELDS,
  SPRINT_WRITABLE_FIELDS,
  coerceTimestamps,
  pickWritable,
} from '../../lib/writable-columns';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.sprints;

const PROJECT_DENIED = 'You are not a member of this project';
const PROJECT_WRITE_DENIED = 'You do not have write access to this project';
const SPRINT_ACTIVE = 'active';
const SPRINT_COMPLETED = 'completed';

type Db = Variables['tenantDb'];
type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/** Keyset condition for "rows after the cursor row", or null when the cursor row is unknown. */
async function cursorCondition(db: Db, cursor: string) {
  const [cur] = await db
    .select({ createdAt: t.createdAt, id: t.id })
    .from(t).where(eq(t.id, cursor)).limit(1);
  if (!cur?.createdAt) return null;
  return sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`;
}

/**
 * Row-level scope: restrict to projects the caller can access. Returns `denied`
 * when an explicit projectId is not accessible, else the restricting condition
 * (null when the caller is unrestricted).
 */
async function projectScope(c: Ctx, projectId: string | undefined): Promise<{ denied: boolean; condition: SQL | null }> {
  if (projectId) {
    return { denied: !(await canAccessProject(c, projectId)), condition: null };
  }
  const accessible = await accessibleProjectIds(c);
  if (accessible === null) return { denied: false, condition: projectNotDeleted(t.projectId) };
  return { denied: false, condition: inArray(t.projectId, accessible.length ? accessible : ['']) };
}

function hasValue(v: string | undefined): v is string {
  return v !== undefined && v !== '';
}

function filterConditions(q: Record<string, string>, scope: SQL | null): SQL[] {
  const conditions: SQL[] = [isNull(t.deletedAt)];
  if (hasValue(q.projectId)) conditions.push(eq(t.projectId, q.projectId));
  if (scope) conditions.push(scope);
  if (hasValue(q.status)) conditions.push(eq(t.status, q.status));
  if (q.search) conditions.push(ilike(t.name, containsPattern(q.search)));
  return conditions;
}

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? Number.parseInt(q.limit, 10) : 25, 100);

  const scope = await projectScope(c, q.projectId);
  if (scope.denied) return error.forbidden(c, PROJECT_DENIED);
  const filters = filterConditions(q, scope.condition);
  const cursorCond = q.cursor ? await cursorCondition(db, q.cursor) : null;
  const conditions = cursorCond ? [...filters, cursorCond] : filters;
  const where = conditions.length ? and(...conditions) : undefined;
  const countWhere = filters.length ? and(...filters) : undefined;

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/sprints] list failed:', err);
    return error.internal(c, 'Failed to list sprints');
  }
});

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Sprint', id);
    if (row.projectId && !(await canAccessProject(c, row.projectId))) {
      return error.forbidden(c, PROJECT_DENIED);
    }
    return success(c, row);
  } catch (err) {
    console.error('[app-api/sprints] get failed:', err);
    return error.internal(c, 'Failed to fetch sprint');
  }
});

app.post('/', requirePermission('projects:create'), zValidator('json', createSprintSchema), async (c) => {
  const db = c.get('tenantDb');
  // Allow-listed columns only (the schema is passthrough, the DB row is not), with
  // date strings coerced to Date so the timestamp columns bind.
  const writable = coerceTimestamps(
    pickWritable(c.req.valid('json') as Record<string, unknown>, SPRINT_WRITABLE_FIELDS),
    SPRINT_TIMESTAMP_FIELDS,
  );
  if (!writable.ok) return error.badRequest(c, `Invalid date: ${writable.field}`);
  const data = writable.values;
  const id = generateId('spr');
  const now = new Date();
  // `projectId` is NOT NULL at the DB (FK to projects) — surface a
  // clean 400 instead of a 500 from the Drizzle insert.
  const projectId = data.projectId as string | null | undefined;
  if (!projectId) {
    return error.badRequest(c, 'Missing required field: projectId');
  }
  if (!(await canWriteProject(c, projectId))) {
    return error.forbidden(c, PROJECT_WRITE_DENIED);
  }
  // A sprint created already active/completed carries its lifecycle stamps.
  const startedAt = data.status === SPRINT_ACTIVE || data.status === SPRINT_COMPLETED ? now : null;
  const completedAt = data.status === SPRINT_COMPLETED ? now : null;
  try {
    await db
      .insert(t)
      .values({ ...data, id, startedAt, completedAt, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    const eventData = { id, projectId, name: data.name, status: data.status ?? 'planned' };
    publishEntityEvent({ c, entityType: 'project_sprint', entityId: id, action: 'created', data: eventData });
    if (startedAt) {
      publishEntityEvent({ c, entityType: 'project_sprint', entityId: id, action: 'started', data: eventData });
    }
    if (completedAt) {
      publishEntityEvent({ c, entityType: 'project_sprint', entityId: id, action: 'completed', data: eventData });
    }
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/sprints] create failed:', err);
    return error.internal(c, 'Failed to create sprint');
  }
});

app.patch('/:id', requirePermission('projects:update'), zValidator('json', updateSprintSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const writable = coerceTimestamps(
    pickWritable(c.req.valid('json') as Record<string, unknown>, SPRINT_WRITABLE_FIELDS),
    SPRINT_TIMESTAMP_FIELDS,
  );
  if (!writable.ok) return error.badRequest(c, `Invalid date: ${writable.field}`);
  const data = writable.values;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Sprint', id);
    if (existing.projectId && !(await canWriteProject(c, existing.projectId))) {
      return error.forbidden(c, PROJECT_WRITE_DENIED);
    }
    const newProjectId = data.projectId as string | null | undefined;
    if (newProjectId && newProjectId !== existing.projectId && !(await canWriteProject(c, newProjectId))) {
      return error.forbidden(c, PROJECT_WRITE_DENIED);
    }
    const now = new Date();
    const update = { ...data, updatedAt: now } as Partial<typeof t.$inferInsert>;
    // Lifecycle stamps follow the status: started when it first becomes active,
    // completed when it first becomes completed.
    const before = existing.status;
    const after = update.status ?? before;
    const started = after === SPRINT_ACTIVE && before !== SPRINT_ACTIVE;
    const completed = after === SPRINT_COMPLETED && before !== SPRINT_COMPLETED;
    if (started && !existing.startedAt) update.startedAt = now;
    if (completed) {
      update.completedAt = now;
      if (!existing.startedAt) update.startedAt = now;
    } else if (after !== SPRINT_COMPLETED && before === SPRINT_COMPLETED) {
      update.completedAt = null;
    }
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    const eventData = {
      id,
      projectId: existing.projectId,
      name: update.name ?? existing.name,
      status: after,
    };
    publishEntityEvent({ c, entityType: 'project_sprint', entityId: id, action: 'updated', data: eventData });
    if (started) {
      publishEntityEvent({ c, entityType: 'project_sprint', entityId: id, action: 'started', data: eventData });
    }
    if (completed) {
      publishEntityEvent({ c, entityType: 'project_sprint', entityId: id, action: 'completed', data: eventData });
    }
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/sprints] update failed:', err);
    return error.internal(c, 'Failed to update sprint');
  }
});

app.delete('/:id', requirePermission('projects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Sprint', id);
    if (existing.projectId && !(await canWriteProject(c, existing.projectId))) {
      return error.forbidden(c, PROJECT_WRITE_DENIED);
    }
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'project_sprint',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/sprints] delete failed:', err);
    return error.internal(c, 'Failed to delete sprint');
  }
});

export const sprintsRoutes = app;
