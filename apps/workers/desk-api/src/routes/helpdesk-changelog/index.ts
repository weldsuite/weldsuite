/**
 * Changelog routes — flat /api/helpdesk-changelog/* surface backed by
 * `helpdeskChangelog`.
 *
 * Ported for W5b: api-worker deleted `/helpdesk/changelog` while the platform
 * kept calling it, so `/welddesk/changelog` has been 404-ing. This restores the
 * read surface on app-api.
 *
 * Permissions: `articles:read` — the same tier the sibling WeldDesk content
 * surfaces use (`helpdesk-news`, `helpdesk-announcements`, `helpdesk-faqs`),
 * and one a MEMBER holds via `welddesk:articles:read`. Read-only for now: the
 * platform only consumes the list (`useChangelog`); no write hook exists, so
 * no create/update/delete routes are speculatively added.
 */

import { Hono, type Context } from 'hono';
import { and, desc, eq, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import type { PaginationMeta } from '@weldsuite/worker-kit/response';
import { cursorPagination, error, list } from '@weldsuite/worker-kit/response';
import { schema } from '@weldsuite/worker-kit/db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.helpdeskChangelog;

/**
 * Offset (numbered-page) pagination meta — a superset of `PaginationMeta`.
 *
 * Identical to the shape `/audit-logs` returns in offset mode; cursor callers
 * keep receiving exactly `{ totalCount, hasMore, cursor }`.
 */
interface OffsetPaginationMeta extends PaginationMeta {
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Parse a query-string integer; NaN when absent or empty. */
function parseIntParam(value: string | undefined): number {
  return value ? Number.parseInt(value, 10) : Number.NaN;
}

/** Resolve pagination mode + window from the query string. */
function parsePaging(q: Record<string, string>) {
  // Clamp rather than reject, matching this route's existing behaviour.
  const limit = Math.min(Math.max(q.limit ? Number.parseInt(q.limit, 10) : 25, 1), 100);
  const rawPage = parseIntParam(q.page);
  const rawPageSize = parseIntParam(q.pageSize);
  // A cursor always wins; offset mode engages only on an explicit, valid `page`.
  const useCursor = q.cursor !== undefined || Number.isNaN(rawPage);
  const page = Number.isNaN(rawPage) ? 1 : Math.max(rawPage, 1);
  const pageSize = Number.isNaN(rawPageSize) ? limit : Math.min(Math.max(rawPageSize, 1), 100);
  return { limit, useCursor, page, pageSize };
}

/** Filter conditions (status / type / search) — never the cursor window. */
function buildChangelogFilters(q: Record<string, string>): SQL[] {
  const conditions: SQL[] = [isNull(t.deletedAt)];
  if (q.status && q.status !== 'all') conditions.push(eq(t.status, q.status));
  if (q.type && q.type !== 'all') conditions.push(eq(t.type, q.type));
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(t.title, term), like(t.version, term), like(t.description, term))!);
  }
  return conditions;
}

/** Keyset condition (release date, then id) for the row identified by `cursorId`, if it exists. */
async function releaseCursorCondition(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  cursorId: string,
): Promise<SQL | null> {
  const db = c.get('tenantDb');
  const [cur] = await db
    .select({ releaseDate: t.releaseDate, id: t.id })
    .from(t)
    .where(eq(t.id, cursorId))
    .limit(1);
  if (!cur?.releaseDate) return null;
  return sql`(${t.releaseDate} < ${cur.releaseDate} OR (${t.releaseDate} = ${cur.releaseDate} AND ${t.id} < ${cur.id}))`;
}

/** Offset-mode pagination meta for one numbered page of rows. */
function offsetMeta(
  rows: Array<{ id: string }>,
  totalCount: number,
  offset: number,
  page: number,
  pageSize: number,
): OffsetPaginationMeta {
  const hasMore = offset + rows.length < totalCount;
  return {
    totalCount,
    hasMore,
    cursor: hasMore && rows.length > 0 ? rows.at(-1)!.id : null,
    page,
    pageSize,
    totalPages: Math.ceil(totalCount / pageSize),
  };
}

/**
 * List changelog entries, newest release first.
 *
 * Two pagination modes share one query builder:
 *  - **cursor** (default) — `?cursor=&limit=`.
 *  - **offset** — `?page=&limit=` (alias `pageSize`); a true numbered pager for
 *    `app/welddesk/changelog`, which renders Prev/Next off `page`/`totalPages`.
 *
 * Offset mode is not optional here: the sole consumer is a numbered pager, and
 * a cursor-only route made Next a no-op that *looked* like it worked — the
 * server re-served page 1 while the client captioned it "Page 2 of 2". Mirrors
 * the fix already applied to `audit-logs/index.ts` for the same mismatch: an
 * explicit `cursor` always wins, and the row count ignores the cursor predicate.
 */
app.get('/', requirePermission('articles:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const { limit, useCursor, page, pageSize } = parsePaging(q);

  const conditions = buildChangelogFilters(q);
  const filterConditions = [...conditions];
  if (useCursor && q.cursor) {
    const cursorCond = await releaseCursorCondition(c, q.cursor);
    if (cursorCond) conditions.push(cursorCond);
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
      // Newest release first — the changelog page reads chronologically,
      // unlike the createdAt-ordered sibling routes.
      db.select().from(t).where(where)
        .orderBy(desc(t.releaseDate), desc(t.id))
        .limit(fetchLimit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const totalCount = Number(countRes[0]?.count ?? 0);

    if (useCursor) {
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore && data.length > 0 ? data.at(-1)!.id : null;
      return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
    }

    return list(c, rows, offsetMeta(rows, totalCount, offset, page, pageSize));
  } catch (err) {
    console.error('[app-api/helpdesk-changelog] list failed:', err);
    return error.internal(c, 'Failed to list changelog entries');
  }
});

export const helpdeskChangelogRoutes = app;
