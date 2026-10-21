/**
 * What the Companies and People lists share: the page cursor, the search
 * pattern and the order of an explicit sort.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * A list page cursor: where the next page starts, plus the total the first
 * page counted, as `<position>~<total>`, so later pages skip the count(*). The
 * position is the last row's id (default order, keyset paging) or a row
 * offset (explicit sort). Clients pass it back unchanged. A cursor without a
 * total (issued before this format) still works; that page counts again.
 */
export interface ListCursor {
  position: string;
  totalCount: number | null;
}

const TOTAL_SEPARATOR = '~';

export function encodeListCursor(position: string, totalCount: number): string {
  return `${position}${TOTAL_SEPARATOR}${totalCount}`;
}

export function decodeListCursor(cursor: string | undefined): ListCursor | null {
  if (!cursor) return null;
  const at = cursor.lastIndexOf(TOTAL_SEPARATOR);
  if (at < 0) return { position: cursor, totalCount: null };
  const total = Number(cursor.slice(at + 1));
  return {
    position: cursor.slice(0, at),
    totalCount: Number.isSafeInteger(total) && total >= 0 ? total : null,
  };
}

/** `%term%` for ILIKE, with the term's own `%`, `_` and `\` matched literally. */
export function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * ORDER BY for an explicit sort. Blank cells sort last, and text compares
 * case-insensitively: the database compares bytes, which put every lowercase
 * name ("acme") after every capitalised one ("Zeta"). `id` breaks ties in the
 * same direction so OFFSET paging stays stable. A NOT NULL column keeps the
 * default null placement, so one index on `(lower(col), id)` serves both
 * directions (`companies_live_name_idx`, `people_live_name_idx`).
 */
export function explicitSortOrder(column: AnyPgColumn, id: AnyPgColumn, direction: 'asc' | 'desc'): SQL[] {
  const key = column.dataType === 'string' ? sql`lower(${column}::text)` : sql`${column}`;
  const dir = direction === 'asc' ? sql.raw('ASC') : sql.raw('DESC');
  const nulls = column.notNull ? sql`` : sql` NULLS LAST`;
  return [sql`${key} ${dir}${nulls}`, sql`${id} ${dir}`];
}
