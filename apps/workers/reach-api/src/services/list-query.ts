/**
 * Cursor pagination helpers shared by the reach list endpoints.
 *
 * Lists are ordered newest first by (created_at, id); the cursor is the id of
 * the last row of the previous page, so a page boundary survives rows being
 * added or removed in between.
 */

import { eq, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '@weldsuite/worker-kit';

export function parseLimit(raw: string | undefined, fallback = 25, max = 100): number {
  const n = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/** Escape LIKE wildcards in user-typed search text. */
export function likePattern(term: string): string {
  return `%${term.trim().replace(/[\\%_]/g, '\\$&')}%`;
}

type CursorTable = PgTable & { id: PgColumn; createdAt: PgColumn };

/** The WHERE fragment that continues after `cursor`; undefined for the first page or an unknown cursor. */
export async function cursorCondition(
  db: Database,
  table: CursorTable,
  cursor: string | undefined,
): Promise<SQL | undefined> {
  if (!cursor) return undefined;
  const [row] = await db
    .select({ createdAt: table.createdAt, id: table.id })
    .from(table as PgTable)
    .where(eq(table.id, cursor))
    .limit(1);
  if (!row) return undefined;
  return sql`(${table.createdAt} < ${row.createdAt} OR (${table.createdAt} = ${row.createdAt} AND ${table.id} < ${row.id}))`;
}

/** Trim the `limit + 1` probe row and derive the cursor. */
export function pageOf<T extends { id: string }>(
  rows: T[],
  limit: number,
): { data: T[]; hasMore: boolean; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return { data, hasMore, nextCursor: hasMore && last ? last.id : null };
}
