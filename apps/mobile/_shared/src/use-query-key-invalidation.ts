import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

function keyMatchesPrefix(
  queryKey: readonly unknown[],
  prefix: readonly unknown[],
): boolean {
  if (prefix.length > queryKey.length) return false;
  return prefix.every((part, i) => queryKey[i] === part);
}

/**
 * Call `onInvalidate` when any of the given query-key prefixes are invalidated.
 * Used by Expo screens that still load data imperatively (usePagedList /
 * local state) but sit under a shell that runs `useRealtimeSync`.
 */
export function useQueryKeyInvalidation(
  prefixes: readonly (readonly unknown[])[],
  onInvalidate: () => void,
  enabled = true,
): void {
  const queryClient = useQueryClient();
  const callbackRef = useRef(onInvalidate);
  useEffect(() => {
    callbackRef.current = onInvalidate;
  });

  useEffect(() => {
    if (!enabled || prefixes.length === 0) return;

    return queryClient.getQueryCache().subscribe((event) => {
      if (event?.type !== 'updated') return;
      // TanStack Query v5 invalidate actions use type 'invalidate'.
      const actionType = (event.action as { type?: string } | undefined)?.type;
      if (actionType !== 'invalidate') return;

      const queryKey = event.query.queryKey;
      for (const prefix of prefixes) {
        if (keyMatchesPrefix(queryKey, prefix)) {
          callbackRef.current();
          return;
        }
      }
    });
  }, [queryClient, enabled, prefixes]);
}
