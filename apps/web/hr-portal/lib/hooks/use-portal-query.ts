'use client';

import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { portalGet } from '@/lib/client';
import { portalQueryKey } from '@/lib/query-client';

interface UsePortalQueryOptions {
  query?: Record<string, string | undefined>;
  enabled?: boolean;
}

interface UsePortalQueryResult<T> {
  data: T | null;
  error: Error | null;
  /** True only while there is nothing to show yet — cached data renders immediately and revalidates in the background. */
  loading: boolean;
  /** A background revalidation is in flight (cached data is on screen). */
  refreshing: boolean;
  refetch: () => void;
}

/**
 * Cached GET through the portal proxy. Keyed by `['portal', slug, path, query]`
 * (see lib/query-client.ts), so pages share entries — `/employee/overview`
 * fetched on the home page is instant when the user comes back to it.
 */
export function usePortalQuery<T>(slug: string, path: string, opts?: UsePortalQueryOptions): UsePortalQueryResult<T> {
  const enabled = opts?.enabled !== false && Boolean(slug);
  const query = useQuery({
    queryKey: portalQueryKey(slug, path, opts?.query),
    queryFn: () => portalGet<T>(slug, path, opts?.query),
    enabled,
  });

  const { refetch: refetchQuery } = query;
  const refetch = useCallback(() => {
    void refetchQuery();
  }, [refetchQuery]);

  return {
    data: query.data ?? null,
    error: query.data === undefined && query.error ? query.error : null,
    loading: enabled && query.isPending,
    refreshing: query.isFetching && !query.isPending,
    refetch,
  };
}
