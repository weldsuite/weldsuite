/**
 * Cursor-paginated list helpers for direct Drizzle access.
 *
 * Cursor is the last row's `id` (decoded by looking up its createdAt+id and
 * filtering for strictly older rows). Sort is always `(createdAt DESC, id DESC)`
 * for stable ordering. Matches the convention in app-api's services.
 */

import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db';
import { clampLimit } from './pagination';

export interface ListResult<T> {
  data: T[];
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

/** Columns expected to exist on every list-able table. */
interface ListableTable {
  id: { name: string };
  createdAt: { name: string };
  deletedAt?: { name: string };
}

export interface CursorListOptions<TTable extends ListableTable, TRow> {
  db: Database;
  table: TTable;
  /** Extra WHERE conditions (filters/search). */
  where?: (SQL | undefined)[];
  /** Cursor opaque value (= last row's id). */
  cursor?: string | null;
  /** Page size — clamped to [1, MAX_LIMIT]. */
  limit?: number | string;
  /** Whether the table supports soft-delete (`deletedAt IS NULL`). Defaults to true. */
  softDelete?: boolean;
  /** Map raw rows to the API response shape. Identity by default. */
  mapRow?: (row: TRow) => unknown;
}

export async function listWithCursor<TTable extends ListableTable, TRow>(
  opts: CursorListOptions<TTable, TRow>,
): Promise<ListResult<unknown>> {
  const { db, table } = opts;
  const limit = clampLimit(opts.limit);
  const softDelete = opts.softDelete ?? true;

  const t = table as unknown as {
    id: any;
    createdAt: any;
    deletedAt?: any;
  };

  const conditions: SQL[] = [];
  if (softDelete && t.deletedAt) conditions.push(isNull(t.deletedAt));
  for (const c of opts.where ?? []) {
    if (c) conditions.push(c);
  }

  const filterOnly = conditions.length > 0 ? and(...conditions) : undefined;
  const cursorConditions = [...conditions];

  if (opts.cursor) {
    const [cursorRow] = await db
      .select({ createdAt: t.createdAt, id: t.id })
      .from(table as any)
      .where(eq(t.id, opts.cursor))
      .limit(1);
    if (cursorRow) {
      cursorConditions.push(
        sql`(${t.createdAt} < ${cursorRow.createdAt} OR (${t.createdAt} = ${cursorRow.createdAt} AND ${t.id} < ${cursorRow.id}))`,
      );
    }
  }

  const pageWhere = cursorConditions.length > 0 ? and(...cursorConditions) : undefined;

  const [rows, countResult] = await Promise.all([
    (db.select().from(table as any) as any)
      .where(pageWhere)
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit + 1) as unknown as Promise<TRow[]>,
    (db
      .select({ count: sql<number>`count(*)` })
      .from(table as any) as any).where(filterOnly) as unknown as Promise<{ count: number }[]>,
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && data.length > 0
      ? ((data[data.length - 1] as unknown as { id: string }).id ?? null)
      : null;
  const mapper = opts.mapRow ?? ((r: TRow) => r as unknown);
  return {
    data: data.map(mapper),
    totalCount: Number(countResult[0]?.count ?? 0),
    hasMore,
    cursor: nextCursor,
  };
}
