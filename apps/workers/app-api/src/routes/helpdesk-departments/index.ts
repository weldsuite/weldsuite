/**
 * Department routes — flat /api/helpdesk-departments/* surface backed by `helpdeskDepartments`.
 *
 * Permissions: departments:read | departments:create | departments:update | departments:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createHelpdeskDepartmentSchema, updateHelpdeskDepartmentSchema } from '@weldsuite/core-api-client/schemas/helpdesk-departments';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.helpdeskDepartments;
const agents = schema.helpdeskAgents;

/**
 * Sort key, matching api-worker's `orderBy(sortOrder, desc(createdAt))`:
 * departments are user-ordered, and the transfer picker renders them in that
 * order.
 *
 * `sort_order` is nullable (`integer().default(0)`), and a NULL in the cursor's
 * tuple comparison evaluates to NULL — i.e. the row is dropped and pagination
 * silently skips it. COALESCE-ing to 0 keeps ordering and the cursor predicate
 * on the same total order. The only divergence from api-worker is where a NULL
 * lands: Postgres' default ASC puts NULLs last, this groups them with the
 * default-0 rows. The column's DEFAULT *is* 0, so a NULL means "never set",
 * which is what a 0 means too.
 */
const sortKey = sql`COALESCE(${t.sortOrder}, 0)`;

app.get('/', requirePermission('departments:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(t.name, term), like(t.email, term))!);
  }
  // The transfer picker (and `useDepartments`) pass `isActive: true`; without
  // this the list offers deactivated teams as transfer targets.
  if (q.isActive === 'true' || q.isActive === 'false') {
    conditions.push(eq(t.isActive, q.isActive === 'true'));
  }
  if (q.cursor) {
    const [cur] = await db
      .select({ sortOrder: t.sortOrder, createdAt: t.createdAt, id: t.id })
      .from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur?.createdAt) {
      const curSort = cur.sortOrder ?? 0;
      conditions.push(
        sql`(${sortKey} > ${curSort} OR (${sortKey} = ${curSort} AND (${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))))`,
      );
    }
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const [rows, countRes, agentCounts] = await Promise.all([
      db.select().from(t).where(where).orderBy(sortKey, desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
      // `agentCount` is part of this route's contract and is not a column —
      // api-worker fetched every agent and tallied them in JS; a GROUP BY is
      // the same tally without pulling the roster over the wire. Counts by the
      // `departmentId` column only, as api-worker did (an agent listed in a
      // department via `teamIds` is not counted).
      db
        .select({ departmentId: agents.departmentId, count: sql<number>`count(*)::int` })
        .from(agents)
        .where(isNull(agents.deletedAt))
        .groupBy(agents.departmentId),
    ]);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const countByDept = new Map(agentCounts.map((r) => [r.departmentId, r.count]));
    const data = page.map((d) => ({ ...d, agentCount: countByDept.get(d.id) ?? 0 }));
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/helpdesk-departments] list failed:', err);
    return error.internal(c, 'Failed to list departments');
  }
});

/**
 * GET /inbox-counts — active conversation count per department.
 *
 * Ported from api-worker `GET /helpdesk/departments/inbox-counts`, gate
 * unchanged (`departments:read`). MUST stay above `GET /:id` or Hono resolves
 * "inbox-counts" as an `:id` and 404s.
 *
 * Counts conversations that are neither archived nor closed and that are
 * actually assigned to a department — matching the sidebar badge semantics.
 */
app.get('/inbox-counts', requirePermission('departments:read'), async (c) => {
  const db = c.get('tenantDb');
  const conv = schema.helpdeskConversations;
  try {
    const rows = await db
      .select({
        departmentId: conv.departmentId,
        activeCount: sql<number>`count(*)::int`,
      })
      .from(conv)
      .where(
        and(
          isNull(conv.deletedAt),
          sql`${conv.departmentId} IS NOT NULL`,
          sql`${conv.status} NOT IN ('archived', 'closed')`,
        ),
      )
      .groupBy(conv.departmentId);
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/helpdesk-departments] inbox-counts failed:', err);
    return error.internal(c, 'Failed to fetch inbox counts');
  }
});

app.get('/:id', requirePermission('departments:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Department', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/helpdesk-departments] get failed:', err);
    return error.internal(c, 'Failed to fetch department');
  }
});

app.post('/', requirePermission('departments:create'), zValidator('json', createHelpdeskDepartmentSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('hdep');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({ c, entityType: 'department', entityId: id, action: 'created', data: { id, name: (data as Record<string, unknown>).name, email: (data as Record<string, unknown>).email } });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/helpdesk-departments] create failed:', err);
    return error.internal(c, 'Failed to create department');
  }
});

app.patch('/:id', requirePermission('departments:update'), zValidator('json', updateHelpdeskDepartmentSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Department', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({ c, entityType: 'department', entityId: id, action: 'updated', data: { id, name: (update.name as string | undefined) ?? existing.name, email: (update.email as string | undefined) ?? existing.email } });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/helpdesk-departments] update failed:', err);
    return error.internal(c, 'Failed to update department');
  }
});

app.delete('/:id', requirePermission('departments:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Department', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({ c, entityType: 'department', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/helpdesk-departments] delete failed:', err);
    return error.internal(c, 'Failed to delete department');
  }
});

export const helpdeskDepartmentsRoutes = app;
