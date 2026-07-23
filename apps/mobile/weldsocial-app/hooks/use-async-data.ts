import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';

/**
 * Minimal focus-aware data hook. Loads on screen focus (so lists refresh
 * after a mutation on another screen) and exposes pull-to-refresh state.
 * The fetcher must be referentially stable or memoised by the caller.
 */
export function useAsyncData<T>(fetcher: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against state updates from a stale in-flight request after the
  // screen unmounts or a newer load supersedes it.
  const requestSeq = useRef(0);

  const load = useCallback(
    async (asRefresh = false) => {
      const seq = ++requestSeq.current;
      if (asRefresh) setRefreshing(true);
      try {
        const result = await fetcher();
        if (seq !== requestSeq.current) return;
        setData(result);
        setError(null);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setError(err instanceof Error ? err.message : 'Something went wrong');
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [fetcher],
  );

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const refresh = useCallback(() => load(true), [load]);

  return { data, loading, refreshing, error, refresh, reload: load };
}
