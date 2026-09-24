'use client';

import { useCallback } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { portalGet } from '@/lib/client';
import { portalQueryKey } from '@/lib/query-client';

interface UsePortalQueryOptions {
  query?: Record<string, string | undefined>;
}

interface UsePortalQueryResult<T> {
  data: T;
  /** Kept for the views' existing checks — with Suspense there is never a render without data. */
  error: null;
  loading: false;
  /** A background revalidation is in flight (cached data is on screen). */
  refreshing: boolean;
  refetch: () => void;
}

/**
 * Cached GET through the portal proxy, keyed by `['portal', slug, path, query]`
 * (see lib/query-client.ts).
 *
 * Suspense-based so navigation never blocks:
 * - cached data renders immediately (and revalidates in the background when
 *   stale), so going back to a page is instant;
 * - otherwise the nearest `loading.tsx` shows while the server-streamed
 *   request (lib/server/portal.ts `streamPortalQueries`) finishes;
 * - failures surface in the `(portal)/error.tsx` boundary, which can retry.
 */
export function usePortalQuery<T>(slug: string, path: string, opts?: UsePortalQueryOptions): UsePortalQueryResult<T> {
  const query = useSuspenseQuery({
    queryKey: portalQueryKey(slug, path, opts?.query),
    queryFn: () => portalGet<T>(slug, path, opts?.query),
  });

  const { refetch: refetchQuery } = query;
  const refetch = useCallback(() => {
    void refetchQuery();
  }, [refetchQuery]);

  return {
    data: query.data as T,
    error: null,
    loading: false,
    refreshing: query.isFetching,
    refetch,
  };
}
