'use client';

import { useCallback, useEffect, useState } from 'react';
import { portalGet } from '@/lib/client';

interface UsePortalQueryOptions {
  query?: Record<string, string | undefined>;
  enabled?: boolean;
}

interface UsePortalQueryResult<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refetch: () => void;
}

/** Minimal client-side data fetching for a GET endpoint behind the portal proxy. */
export function usePortalQuery<T>(slug: string, path: string, opts?: UsePortalQueryOptions): UsePortalQueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(opts?.enabled !== false);
  const [reloadKey, setReloadKey] = useState(0);
  const queryKey = JSON.stringify(opts?.query ?? {});

  useEffect(() => {
    if (opts?.enabled === false) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    portalGet<T>(slug, path, opts?.query)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error('Request failed'));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, path, queryKey, opts?.enabled, reloadKey]);

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);

  return { data, error, loading, refetch };
}
