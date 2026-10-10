import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from '@/lib/router';
import type { GridSortConfig } from './types';

/**
 * Remembers which column a table is sorted by, so leaving the page and coming
 * back does not drop the sort.
 *
 * The URL (`?sort=name&sortDir=asc`) stays the source of truth while the page is
 * open: it is what the data request and the toolbar read. The pick is also
 * written to localStorage, per grid and per browser, and put back into the URL
 * when the page opens without one. It is not stored with the saved grid view
 * because that view is a server record with a fixed shape (column visibility +
 * widths).
 */

const STORAGE_PREFIX = 'weldsuite:grid-sort:';

export interface PersistedGridSort {
  sort?: string;
  sortDir?: 'asc' | 'desc';
}

function parseDirection(value: unknown): 'asc' | 'desc' | undefined {
  return value === 'asc' || value === 'desc' ? value : undefined;
}

export function readStoredGridSort(gridName: string): PersistedGridSort | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_PREFIX + gridName);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { field?: unknown; direction?: unknown };
    if (typeof parsed.field !== 'string' || parsed.field === '') return null;
    return { sort: parsed.field, sortDir: parseDirection(parsed.direction) };
  } catch {
    // Storage can be blocked or hold something unparseable; no sort to restore.
    return null;
  }
}

/** Stores the user's sort pick, or forgets it when the sort was cleared. */
export function writeStoredGridSort(gridName: string, sort: GridSortConfig): void {
  try {
    if (sort.field) {
      globalThis.localStorage?.setItem(
        STORAGE_PREFIX + gridName,
        JSON.stringify({ field: sort.field, direction: sort.direction }),
      );
    } else {
      globalThis.localStorage?.removeItem(STORAGE_PREFIX + gridName);
    }
  } catch {
    // Best-effort: a blocked or full storage only means the sort is not remembered.
  }
}

/**
 * The sort a list page should request: the URL's, or on first open without one
 * the remembered sort for `gridName`. The restored sort is also written into the
 * URL (replacing the entry, so Back does not land on the bare URL again), after
 * which the URL alone drives it, including clearing it.
 */
export function usePersistedGridSort(gridName: string): PersistedGridSort {
  const searchParams = useSearchParams();
  const router = useRouter();
  const urlSort = searchParams.get('sort') || undefined;
  const urlDirection = parseDirection(searchParams.get('sortDir'));

  // Read once, on mount: a sort cleared later must not be restored again.
  const [restored, setRestored] = useState<PersistedGridSort | null>(() =>
    urlSort ? null : readStoredGridSort(gridName),
  );

  useEffect(() => {
    if (urlSort) {
      // The URL has caught up (or the user navigated with a sort of their own).
      if (restored) setRestored(null);
      return;
    }
    if (!restored?.sort) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('sort', restored.sort);
    if (restored.sortDir) params.set('sortDir', restored.sortDir);
    router.replace(`?${params.toString()}`);
    // `searchParams` is read for its current content only; the restore runs once
    // per `restored` value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSort, restored]);

  if (urlSort) return { sort: urlSort, sortDir: urlDirection };
  return restored ?? {};
}
