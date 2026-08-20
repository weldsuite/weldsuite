/**
 * Search + filter + infinite-scroll state for the WeldBooks list screens.
 *
 * Both the invoice and expense lists page through app-api the same way, so the
 * debounce, page tracking and append-vs-replace logic live here rather than
 * being written twice and drifting.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Paged } from '@/types/accounting';

const SEARCH_DEBOUNCE_MS = 300;

export interface PagedListOptions<T> {
  fetcher: (params: { page: number; limit: number; search?: string; status?: string }) => Promise<Paged<T>>;
  limit?: number;
  /** Undefined means "no status filter" — the `all` tab. */
  status?: string;
}

export interface PagedListState<T> {
  items: T[];
  loading: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  error: boolean;
  totalCount: number;
  search: string;
  setSearch: (value: string) => void;
  refresh: () => void;
  loadMore: () => void;
  /** Re-fetch page 1 in place — for after a mutation. */
  reload: () => void;
}

export function usePagedList<T>({
  fetcher,
  limit = 20,
  status,
}: PagedListOptions<T>): PagedListState<T> {
  const [items, setItems] = useState<T[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Keep the latest fetcher without making every callback depend on its
  // identity — screens pass an inline arrow that changes each render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchPage = useCallback(
    async (pageNum: number, append: boolean) => {
      try {
        setError(false);
        const result = await fetcherRef.current({
          page: pageNum,
          limit,
          search: debouncedSearch || undefined,
          status,
        });
        setItems((prev) => (append ? [...prev, ...result.items] : result.items));
        setTotalCount(result.totalCount);
        setHasMore(result.hasMore);
        setPage(pageNum);
      } catch (err) {
        console.error('Failed to load list:', err);
        // Only blank the screen when there is nothing to keep showing.
        if (!append) setItems([]);
        setError(true);
      } finally {
        setLoading(false);
        setLoadingMore(false);
        setRefreshing(false);
      }
    },
    [limit, debouncedSearch, status],
  );

  // Reset to page 1 whenever the query or filter changes.
  useEffect(() => {
    setLoading(true);
    fetchPage(1, false);
  }, [fetchPage]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    fetchPage(1, false);
  }, [fetchPage]);

  const reload = useCallback(() => {
    fetchPage(1, false);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore || loading) return;
    setLoadingMore(true);
    fetchPage(page + 1, true);
  }, [hasMore, loadingMore, loading, page, fetchPage]);

  return {
    items,
    loading,
    loadingMore,
    refreshing,
    error,
    totalCount,
    search,
    setSearch,
    refresh,
    loadMore,
    reload,
  };
}
