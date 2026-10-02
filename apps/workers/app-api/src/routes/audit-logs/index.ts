/**
 * Audit log routes — flat /api/audit-logs/* surface backed by `auditLogs`.
 *
 * Permissions: general:read | general:create | general:update | general:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { createAuditLogSchema, updateAuditLogSchema } from '@weldsuite/core-api-client/schemas/audit-logs';
import type { Env, Variables } from '../../types';
import type { PaginationMeta } from '@weldsuite/worker-kit/response';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';

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

/** A query param counts as supplied only when present and non-empty. */
function hasValue(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

interface ListPaging {
  limit: number;
  page: number;
  pageSize: number;
  useCursor: boolean;
}

/** Resolve cursor-vs-offset mode plus the clamped limit / page / pageSize. */
function parseListPaging(q: Record<string, string>): ListPaging {
  // Clamp rather than reject, matching this route's existing behaviour — a
  // stricter validator would start 400ing requests that succeed today.
  const limit = Math.min(Math.max(q.limit ? Number.parseInt(q.limit, 10) : 25, 1), 100);
  const rawPage = hasValue(q.page) ? Number.parseInt(q.page, 10) : Number.NaN;
  const rawPageSize = hasValue(q.pageSize) ? Number.parseInt(q.pageSize, 10) : Number.NaN;
  // A cursor always wins; offset mode engages only on an explicit, valid `page`.
  const useCursor = q.cursor !== undefined || Number.isNaN(rawPage);
  const page = Number.isNaN(rawPage) ? 1 : Math.max(rawPage, 1);
  // Legacy api-worker paged by `limit`; `/api/tasks` uses `pageSize`. Accept both.
  const pageSize = Number.isNaN(rawPageSize) ? limit : Math.min(Math.max(rawPageSize, 1), 100);
  return { limit, page, pageSize, useCursor };
}

/** Query params that filter by exact column equality. */
const EQUALITY_FILTERS = [
  ['action', t.action],
  ['entityType', t.entityType],
  ['entityId', t.entityId],
  // performedBy/startDate/endDate reach parity with the legacy api-worker route.
  // settings/activity ships date filters, so without these they'd silently no-op.
  ['performedBy', t.performedBy],
] as const;

/** Query params that bound `createdAt` by an ISO 8601 date. */
const DATE_FILTERS = [
  { param: 'startDate', apply: (d: Date) => gte(t.createdAt, d) },
  { param: 'endDate', apply: (d: Date) => lte(t.createdAt, d) },
] as const;

/** Build the list filter conditions, or the 400 message for an invalid date. */
function buildListFilters(q: Record<string, string>): { conditions: SQL[] } | { errorMessage: string } {
  const conditions: SQL[] = [];
  for (const [param, column] of EQUALITY_FILTERS) {
    const value = q[param];
    if (hasValue(value)) conditions.push(eq(column, value));
  }
  for (const { param, apply } of DATE_FILTERS) {
    const value = q[param];
    if (!hasValue(value)) continue;
    const d = parseDateParam(value);
    if (!d) return { errorMessage: `Invalid ${param} — expected an ISO 8601 date` };
    conditions.push(apply(d));
  }
  return { conditions };
}

/** Keyset condition selecting rows strictly after the cursor row, if it exists. */
async function cursorCondition(db: Database, cursor: string): Promise<SQL | null> {
  const [cur] = await db
    .select({ createdAt: t.createdAt, id: t.id })
    .from(t).where(eq(t.id, cursor)).limit(1);
  if (!cur?.createdAt) return null;
  return sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`;
}

/** Shape the page of rows into the cursor or offset (numbered-page) response body. */
function buildListPage<T extends { id: string }>(
  rows: T[],
  totalCount: number,
  paging: ListPaging,
  offset: number,
): { data: T[]; pagination: PaginationMeta | OffsetPaginationMeta } {
  const { limit, page, pageSize, useCursor } = paging;

  if (useCursor) {
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    return { data, pagination: cursorPagination(totalCount, hasMore, nextCursor) };
  }

  const hasMore = offset + rows.length < totalCount;
  const pagination: OffsetPaginationMeta = {
    totalCount,
    hasMore,
    cursor: hasMore && rows.length > 0 ? rows[rows.length - 1].id : null,
    page,
    pageSize,
    totalPages: Math.ceil(totalCount / pageSize),
  };
  return { data: rows, pagination };
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

  const paging = parseListPaging(q);
  const { limit, page, pageSize, useCursor } = paging;

  const filters = buildListFilters(q);
  if ('errorMessage' in filters) return error.badRequest(c, filters.errorMessage);

  const filterConditions = filters.conditions;
  const conditions = [...filterConditions];
  if (useCursor && q.cursor) {
    const cursorCond = await cursorCondition(db, q.cursor);
    if (cursorCond) conditions.push(cursorCond);
  }
  // `and()` of no conditions is `undefined` (no WHERE clause).
  const where = and(...conditions);
  // Count reflects the filters only — never the cursor window.
  const countWhere = and(...filterConditions);

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
    const { data, pagination } = buildListPage(rows, totalCount, paging, offset);
    return list(c, data, pagination);
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
  const limit = Math.min(c.req.query('limit') ? Number.parseInt(c.req.query('limit')!, 10) : 100, 200);
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
