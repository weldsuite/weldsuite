/**
 * Audit log routes — flat /api/audit-logs/* surface backed by `auditLogs`.
 *
 * Permissions: general:read | general:create | general:update | general:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { createAuditLogSchema, updateAuditLogSchema } from '@weldsuite/core-api-client/schemas/audit-logs';
import type { Env, Variables } from '../../types';
import type { PaginationMeta } from '../../lib/response';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.auditLogs;

/**
 * Offset (numbered-page) pagination meta — a superset of `PaginationMeta`.
 *
 * Cursor callers keep receiving exactly `{ totalCount, hasMore, cursor }`; only
 * callers that explicitly ask for a `page` get the extra numbered-page fields.
 * Mirrors `createPaginationMeta` in the legacy api-worker so the numbered pager
 * in `app/settings/activity` reads identical values off both workers.
 */
interface OffsetPaginationMeta extends PaginationMeta {
  page: number;
  pageSize: number;
  totalPages: number;
}

/** `new Date(x)` never throws — it yields Invalid Date, which would reach SQL. */
function parseDateParam(value: string): Date | null {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * List audit logs, newest first.
 *
 * Two pagination modes share one query builder:
 *  - **cursor** (default) — `?cursor=&limit=`; the pre-existing contract, unchanged.
 *  - **offset** — `?page=&limit=` (alias `pageSize`); a true numbered pager for
 *    `app/settings/activity`, which renders Prev/Next off `page`/`totalPages`.
 *    Cursor-walking to page N would cost N round-trips, so `page` gets a real
 *    OFFSET. Follows the `/api/tasks` precedent: an explicit `cursor` always
 *    wins, and the row count is computed without the cursor predicate.
 */
app.get('/', requirePermission('general:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();

  // Clamp rather than reject, matching this route's existing behaviour — a
  // stricter validator would start 400ing requests that succeed today.
  const limit = Math.min(Math.max(q.limit ? parseInt(q.limit, 10) : 25, 1), 100);
  const rawPage = q.page !== undefined && q.page !== '' ? parseInt(q.page, 10) : NaN;
  const rawPageSize = q.pageSize !== undefined && q.pageSize !== '' ? parseInt(q.pageSize, 10) : NaN;
  // A cursor always wins; offset mode engages only on an explicit, valid `page`.
  const useCursor = q.cursor !== undefined || Number.isNaN(rawPage);
  const page = Number.isNaN(rawPage) ? 1 : Math.max(rawPage, 1);
  // Legacy api-worker paged by `limit`; `/api/tasks` uses `pageSize`. Accept both.
  const pageSize = Number.isNaN(rawPageSize) ? limit : Math.min(Math.max(rawPageSize, 1), 100);

  const conditions: any[] = [];
  if (q.action !== undefined && q.action !== '') conditions.push(eq(t.action, q.action));
  if (q.entityType !== undefined && q.entityType !== '') conditions.push(eq(t.entityType, q.entityType));
  if (q.entityId !== undefined && q.entityId !== '') conditions.push(eq(t.entityId, q.entityId));
  // performedBy/startDate/endDate reach parity with the legacy api-worker route.
  // settings/activity ships date filters, so without these they'd silently no-op.
  if (q.performedBy !== undefined && q.performedBy !== '') conditions.push(eq(t.performedBy, q.performedBy));
  if (q.startDate !== undefined && q.startDate !== '') {
    const d = parseDateParam(q.startDate);
    if (!d) return error.badRequest(c, 'Invalid startDate — expected an ISO 8601 date');
    conditions.push(gte(t.createdAt, d));
  }
  if (q.endDate !== undefined && q.endDate !== '') {
    const d = parseDateParam(q.endDate);
    if (!d) return error.badRequest(c, 'Invalid endDate — expected an ISO 8601 date');
    conditions.push(lte(t.createdAt, d));
  }

  const filterConditions = [...conditions];
  if (useCursor && q.cursor) {
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
  // Count reflects the filters only — never the cursor window.
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  // Cursor mode over-fetches by one to detect `hasMore`; offset mode reads the
  // exact page and derives `hasMore` from the total instead.
  const fetchLimit = useCursor ? limit + 1 : pageSize;
  const offset = useCursor ? 0 : (page - 1) * pageSize;

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where)
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(fetchLimit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const totalCount = Number(countRes[0]?.count ?? 0);

    if (useCursor) {
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
      return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
    }

    const hasMore = offset + rows.length < totalCount;
    const meta: OffsetPaginationMeta = {
      totalCount,
      hasMore,
      cursor: hasMore && rows.length > 0 ? rows[rows.length - 1].id : null,
      page,
      pageSize,
      totalPages: Math.ceil(totalCount / pageSize),
    };
    return list(c, rows, meta);
  } catch (err) {
    console.error('[app-api/audit-logs] list failed:', err);
    return error.internal(c, 'Failed to list audit logs');
  }
});

/**
 * Entity history — every audit log for a single entity, newest first.
 * Backs the "History" tab in the task/entity detail panels
 * (`useEntityAuditLogs(entityType, entityId)`), e.g. WeldFlow tasks pass
 * `project_task` / `personal_task`.
 */
app.get('/:entityType/:entityId', requirePermission('general:read'), async (c) => {
  const db = c.get('tenantDb');
  const entityType = c.req.param('entityType');
  const entityId = c.req.param('entityId');
  const limit = Math.min(c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : 100, 200);
  try {
    const rows = await db
      .select()
      .from(t)
      .where(and(eq(t.entityType, entityType), eq(t.entityId, entityId)))
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit);
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/audit-logs] entity history failed:', err);
    return error.internal(c, 'Failed to fetch entity history');
  }
});

app.get('/:id', requirePermission('general:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!row) return error.notFound(c, 'Audit log', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/audit-logs] get failed:', err);
    return error.internal(c, 'Failed to fetch audit log');
  }
});

app.post('/', requirePermission('general:create'), zValidator('json', createAuditLogSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('audit');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/audit-logs] create failed:', err);
    return error.internal(c, 'Failed to create audit log');
  }
});

app.patch('/:id', requirePermission('general:update'), zValidator('json', updateAuditLogSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Audit log', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(eq(t.id, id));
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/audit-logs] update failed:', err);
    return error.internal(c, 'Failed to update audit log');
  }
});

app.delete('/:id', requirePermission('general:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Audit log', id);
    await db.delete(t).where(eq(t.id, id));
    return noContent(c);
  } catch (err) {
    console.error('[app-api/audit-logs] delete failed:', err);
    return error.internal(c, 'Failed to delete audit log');
  }
});

export const auditLogsRoutes = app;
