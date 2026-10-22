/**
 * Cursor-paginated list with debounced server-side search, pull-to-refresh,
 * "load more" at the end of the list, and a silent refetch when the screen
 * regains focus (so a record created on a pushed screen shows up on return).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { ApiResponse } from '@weldsuite/mobile-ui/types';
import type { Page } from '@/services/api';

const SEARCH_DEBOUNCE_MS = 300;

interface FetchParams {
  cursor: string | null;
  search: string;
}

interface ListState<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
  totalCount: number;
}

const EMPTY_STATE = { items: [], cursor: null, hasMore: false, totalCount: 0 };

type Mode = 'initial' | 'refresh' | 'silent';

export function usePagedList<T extends { id: string }>(
  fetchPage: (params: FetchParams) => Promise<ApiResponse<Page<T>>>,
  options: { search?: string; enabled?: boolean; resetKey?: string } = {},
) {
  const { search = '', enabled = true, resetKey = '' } = options;
  const [state, setState] = useState<ListState<T>>(EMPTY_STATE as ListState<T>);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState(search);

  // Only the latest request may write state, so a slow earlier one can't overwrite a newer one.
  const requestId = useRef(0);
  const fetchRef = useRef(fetchPage);
  const loadedOnce = useRef(false);

  useEffect(() => {
    fetchRef.current = fetchPage;
  }, [fetchPage]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), search ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [search]);

  const reload = useCallback(
    async (mode: Mode) => {
      const current = ++requestId.current;
      if (mode === 'initial') setLoading(true);
      if (mode === 'refresh') setRefreshing(true);
      const res = await fetchRef.current({ cursor: null, search: debouncedSearch });
      if (current !== requestId.current) return;
      if (res.success && res.data) {
        const { items, cursor, hasMore, totalCount } = res.data;
        setState({ items, cursor, hasMore, totalCount });
        setError(false);
        loadedOnce.current = true;
      } else if (mode !== 'silent') {
        setError(true);
      }
      setLoading(false);
      setRefreshing(false);
    },
    [debouncedSearch],
  );

  // `resetKey` reloads the list when a filter outside the hook changes.
  useEffect(() => {
    if (enabled) void reload('initial');
  }, [enabled, reload, resetKey]);

  useFocusEffect(
    useCallback(() => {
      // The first focus is the initial load above; later ones refetch quietly.
      if (enabled && loadedOnce.current) void reload('silent');
    }, [enabled, reload]),
  );

  const refresh = useCallback(() => reload('refresh'), [reload]);

  const loadMore = useCallback(async () => {
    if (!state.hasMore || !state.cursor || loading || loadingMore || refreshing) return;
    const current = requestId.current;
    setLoadingMore(true);
    const res = await fetchRef.current({ cursor: state.cursor, search: debouncedSearch });
    // A reload that started meanwhile owns the list now.
    if (current !== requestId.current) {
      setLoadingMore(false);
      return;
    }
    if (res.success && res.data) {
      const page = res.data;
      setState((prev) => {
        const known = new Set(prev.items.map((item) => item.id));
        return {
          items: [...prev.items, ...page.items.filter((item) => !known.has(item.id))],
          cursor: page.cursor,
          hasMore: page.hasMore,
          totalCount: page.totalCount,
        };
      });
    }
    setLoadingMore(false);
  }, [state.hasMore, state.cursor, loading, loadingMore, refreshing, debouncedSearch]);

  const removeItem = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      items: prev.items.filter((item) => item.id !== id),
      totalCount: Math.max(0, prev.totalCount - 1),
    }));
  }, []);

  const updateItem = useCallback((updated: T) => {
    setState((prev) => ({ ...prev, items: prev.items.map((item) => (item.id === updated.id ? updated : item)) }));
  }, []);

  const addItem = useCallback((added: T) => {
    setState((prev) => ({
      ...prev,
      items: [added, ...prev.items.filter((item) => item.id !== added.id)],
      totalCount: prev.totalCount + 1,
    }));
  }, []);

  return {
    items: state.items,
    totalCount: state.totalCount,
    loading,
    refreshing,
    loadingMore,
    error,
    refresh,
    loadMore,
    removeItem,
    updateItem,
    addItem,
  };
}
