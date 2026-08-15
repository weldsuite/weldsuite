import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ThreadSummary } from '../lib/thread-utils';
import {
  addHiddenId,
  filterHiddenThreads,
  findThreadIdToHide,
  removeHiddenId,
  retainHiddenIdsStillOnServer,
  type ThreadRef,
} from '../lib/optimistic-thread-list';

/**
 * Overlay on the server thread list so archive (and similar) can drop a
 * row immediately. Hidden ids survive stale refetches and clear once the
 * server snapshot no longer contains that thread — or when the caller
 * unhides after a failed mutation.
 */
export function useOptimisticThreadList(serverThreads: ThreadSummary[]) {
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setHiddenIds((prev) => retainHiddenIdsStillOnServer(serverThreads, prev));
  }, [serverThreads]);

  const threads = useMemo(
    () => filterHiddenThreads(serverThreads, hiddenIds),
    [serverThreads, hiddenIds],
  );

  const hideThread = useCallback(
    (current: ThreadRef) => {
      const id = findThreadIdToHide(serverThreads, current);
      if (!id) return;
      setHiddenIds((prev) => addHiddenId(prev, id));
    },
    [serverThreads],
  );

  const unhideThread = useCallback(
    (current: ThreadRef) => {
      const id = current.threadId || findThreadIdToHide(serverThreads, current);
      if (!id) return;
      setHiddenIds((prev) => removeHiddenId(prev, id));
    },
    [serverThreads],
  );

  return {
    threads,
    hiddenCount: hiddenIds.size,
    hideThread,
    unhideThread,
  };
}
