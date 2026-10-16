/**
 * Project label routes — flat /api/project-labels/* surface backed by `projectLabels`.
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, ilike, inArray, isNull, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createProjectLabelSchema, updateProjectLabelSchema } from '@weldsuite/core-api-client/schemas/project-labels';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import { accessibleProjectIds, canAccessProject, canWriteProject, projectNotDeleted } from '../../lib/project-access';
import { containsPattern } from '../../lib/ilike-pattern';
import { PROJECT_LABEL_WRITABLE_FIELDS, pickWritable } from '../../lib/writable-columns';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectLabels;

const PROJECT_DENIED = 'You are not a member of this project';
const PROJECT_WRITE_DENIED = 'You do not have write access to this project';
/** `project_labels.color` is NOT NULL; a label created without one gets a neutral grey. */
const DEFAULT_LABEL_COLOR = '#6b7280';

type TenantDb = Variables['tenantDb'];
type LabelCtx = Context<{ Bindings: Env; Variables: Variables }>;

/** Restricts the label-usage scan to tasks of projects the caller can access (or personal tasks). */
async function taskUsageScope(c: LabelCtx, taskProjectId: AnyColumn): Promise<SQL> {
  const accessible = await accessibleProjectIds(c);
  if (accessible === null) return projectNotDeleted(taskProjectId);
  if (accessible.length === 0) return sql`${taskProjectId} IS NULL`;
  return sql`(${taskProjectId} IS NULL OR ${inArray(taskProjectId, accessible)})`;
}

/**
 * A live label whose name matches case-insensitively (ignoring surrounding
 * whitespace) in the same scope: a project's labels also include the
 * workspace-wide ones, so those count as "the same list" for that project.
 */
async function findDuplicateLabel(
  db: TenantDb,
  name: string,
  projectId: string | null | undefined,
  excludeId?: string,
) {
  const conditions = [
    isNull(t.deletedAt),
    sql`lower(btrim(${t.name})) = ${name.trim().toLowerCase()}`,
    projectId ? sql`(${t.projectId} = ${projectId} OR ${t.projectId} IS NULL)` : isNull(t.projectId),
  ];
  if (excludeId) conditions.push(sql`${t.id} <> ${excludeId}`);
  const [row] = await db.select({ id: t.id, name: t.name }).from(t).where(and(...conditions)).limit(1);
  return row;
}

const duplicateLabelMessage = (name: string) => `A label named "${name}" already exists`;

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? Number.parseInt(q.limit, 10) : 25, 100);

  const conditions: SQL[] = [isNull(t.deletedAt)];
  // Project-membership boundary. With a projectId: that project's labels PLUS
  // workspace-wide labels (projectId IS NULL), and the caller must have access to
  // the project. Without one (cross-project views like my-tasks / CRM): the
  // workspace-wide labels plus the labels of the projects the caller can access.
  if (q.projectId !== undefined && q.projectId !== '') {
    if (!(await canAccessProject(c, q.projectId))) return error.forbidden(c, PROJECT_DENIED);
    conditions.push(sql`(${t.projectId} = ${q.projectId} OR ${t.projectId} IS NULL)`);
  } else {
    const accessible = await accessibleProjectIds(c);
    if (accessible === null) conditions.push(projectNotDeleted(t.projectId));
    else if (accessible.length) conditions.push(sql`(${t.projectId} IS NULL OR ${inArray(t.projectId, accessible)})`);
    else conditions.push(isNull(t.projectId));
  }
  if (q.search) {
    conditions.push(ilike(t.name, containsPattern(q.search)));
  }
  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: t.createdAt, id: t.id })
      .from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
      );
    }
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const tasks = schema.tasks;
    // Usage only counts tasks of projects the caller can see, so a workspace-wide
    // label's number does not leak activity in other projects.
    const usageScope = await taskUsageScope(c, tasks.projectId);
    const [rows, countRes, usageRows] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
      // Aggregate label usage from tasks.labels (jsonb string[]). Cheap
      // workspace-wide scan; this is how api-worker did it.
      db.execute<{ label_id: string; count: number }>(sql`
        SELECT jsonb_array_elements_text(${tasks.labels}) AS label_id,
               COUNT(*)::int AS count
        FROM ${tasks}
        WHERE ${tasks.labels} IS NOT NULL
          AND ${tasks.deletedAt} IS NULL
          AND ${usageScope}
        GROUP BY label_id
      `),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);

    const counts = new Map<string, number>();
    const usageArr =
      (usageRows as unknown as { rows?: Array<{ label_id: string; count: number }> }).rows ??
      (usageRows as unknown as Array<{ label_id: string; count: number }>);
    for (const r of usageArr ?? []) counts.set(r.label_id, Number(r.count));
    const withUsage = data.map((l) => ({ ...l, usageCount: counts.get(l.id) ?? 0 }));

    return list(c, withUsage, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/project-labels] list failed:', err);
    return error.internal(c, 'Failed to list project labels');
  }
});

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Project label', id);
    if (row.projectId && !(await canAccessProject(c, row.projectId))) {
      return error.forbidden(c, PROJECT_DENIED);
    }
    return success(c, row);
  } catch (err) {
    console.error('[app-api/project-labels] get failed:', err);
    return error.internal(c, 'Failed to fetch project label');
  }
});

app.post('/', requirePermission('projects:create'), zValidator('json', createProjectLabelSchema), async (c) => {
  const db = c.get('tenantDb');
  // Allow-listed columns only (the schema is passthrough, the DB row is not).
  const data = pickWritable(c.req.valid('json') as Record<string, unknown>, PROJECT_LABEL_WRITABLE_FIELDS) as {
    name: string;
    color?: string;
    projectId?: string | null;
  };
  const id = generateId('plbl');
  const now = new Date();
  // Workspace-wide labels (null projectId) stay permission-only; project labels need write access.
  if (data.projectId && !(await canWriteProject(c, data.projectId))) {
    return error.forbidden(c, PROJECT_WRITE_DENIED);
  }
  data.name = String(data.name).trim();
  if (!data.name) return error.badRequest(c, 'Label name is required');
  const values = { ...data, color: data.color ?? DEFAULT_LABEL_COLOR };
  try {
    if (await findDuplicateLabel(db, data.name, data.projectId)) {
      return error.conflict(c, duplicateLabelMessage(data.name));
    }
    await db.insert(t).values({ ...values, id, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'project_label',
      entityId: id,
      action: 'created',
      data: { id, ...values },
    });
    return success(c, { id, ...values }, 201);
  } catch (err) {
    console.error('[app-api/project-labels] create failed:', err);
    return error.internal(c, 'Failed to create project label');
  }
});

app.patch('/:id', requirePermission('projects:update'), zValidator('json', updateProjectLabelSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = pickWritable(c.req.valid('json') as Record<string, unknown>, PROJECT_LABEL_WRITABLE_FIELDS) as {
    name?: string;
    color?: string;
    projectId?: string | null;
  };
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Project label', id);
    if (existing.projectId && !(await canWriteProject(c, existing.projectId))) {
      return error.forbidden(c, PROJECT_WRITE_DENIED);
    }
    if (data.projectId && data.projectId !== existing.projectId && !(await canWriteProject(c, data.projectId))) {
      return error.forbidden(c, PROJECT_WRITE_DENIED);
    }
    if (typeof data.name === 'string') {
      data.name = data.name.trim();
      if (!data.name) return error.badRequest(c, 'Label name is required');
      const targetProject = data.projectId !== undefined ? data.projectId : existing.projectId;
      if (await findDuplicateLabel(db, data.name, targetProject, id)) {
        return error.conflict(c, duplicateLabelMessage(data.name));
      }
    }
    const update = { ...data, updatedAt: new Date() } as Partial<typeof t.$inferInsert>;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'project_label',
      entityId: id,
      action: 'updated',
      data: { id, ...data },
    });
    return success(c, { id, ...data });
  } catch (err) {
    console.error('[app-api/project-labels] update failed:', err);
    return error.internal(c, 'Failed to update project label');
  }
});

app.delete('/:id', requirePermission('projects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Project label', id);
    if (existing.projectId && !(await canWriteProject(c, existing.projectId))) {
      return error.forbidden(c, PROJECT_WRITE_DENIED);
    }
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'project_label',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/project-labels] delete failed:', err);
    return error.internal(c, 'Failed to delete project label');
  }
});

export const projectLabelsRoutes = app;
