import type { EntitySyncMap, QueryClientLike } from '@weldsuite/realtime/react';

type QueryClientWithGet = QueryClientLike & {
  getQueryData: (queryKey: readonly unknown[]) => unknown;
};

/**
 * Ensure every invalidate prefix in a sync map exists in the QueryClient
 * cache. Without a matching query entry, `invalidateQueries` is a no-op —
 * which breaks apps that still use imperative list state (usePagedList) and
 * listen via `useQueryKeyInvalidation`.
 */
export function seedSyncMapKeys(
  queryClient: QueryClientLike,
  syncMap: EntitySyncMap,
): void {
  const qc = queryClient as QueryClientWithGet;
  for (const config of Object.values(syncMap)) {
    for (const key of config.invalidate) {
      if (qc.getQueryData(key) === undefined) {
        qc.setQueryData(key, null);
      }
    }
  }
}
