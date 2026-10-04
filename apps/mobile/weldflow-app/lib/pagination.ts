/**
 * Paging helpers for the WeldFlow infinite lists.
 *
 * Two server contracts exist behind app-api's `{ data, pagination }` envelope:
 * keyset (`/projects`, `/tasks` from page 2 on) hands back the id of the last
 * row as `pagination.cursor`, while offset (`/my-tasks`) always returns a null
 * cursor and is advanced by page number. Kept free of React so the rules are
 * unit-testable.
 */

import type { PaginationMeta } from '@/types/weldflow';

interface PageLike {
  pagination: Pick<PaginationMeta, 'hasMore' | 'cursor'>;
}

/** Keyset mode: the cursor for the next page, or `undefined` when the list is exhausted. */
export function nextCursorParam(lastPage: PageLike): string | undefined {
  if (!lastPage.pagination.hasMore) return undefined;
  return lastPage.pagination.cursor ?? undefined;
}

/** Offset mode: the next 1-based page number, or `undefined` when the list is exhausted. */
export function nextPageParam(lastPage: PageLike, allPages: readonly unknown[]): number | undefined {
  return lastPage.pagination.hasMore ? allPages.length + 1 : undefined;
}

/**
 * Concatenate pages in order, dropping rows whose `id` was already seen. A
 * keyset request whose cursor row was deleted gets page 1 again, which would
 * otherwise repeat rows (and React keys) in the list.
 */
export function flattenPages<T extends { id: string }>(
  pages: ReadonlyArray<{ data: T[] }> | undefined,
): T[] {
  if (!pages) return [];
  const seen = new Set<string>();
  const rows: T[] = [];
  for (const page of pages) {
    for (const row of page.data) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  return rows;
}
