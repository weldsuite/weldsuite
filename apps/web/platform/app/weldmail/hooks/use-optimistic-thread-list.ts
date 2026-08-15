import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ThreadSummary } from '../lib/thread-utils';
import {
  addHiddenId,
  countHiddenOnServer,
  filterHiddenThreads,
  findThreadIdToHide,
  removeHiddenId,
  retainHiddenIdsStillOnServer,
  type HiddenThreadMap,
  type ThreadRef,
} from '../lib/optimistic-thread-list';

/**
 * Overlay on the server thread list so archive (and similar) can drop a
 * row immediately. Each hidden id is scoped to the list query it came
 * from (`listKey`), so paging away does not clear it. The overlay drops
 * once that originating page refreshes without the row, or when the
 * caller unhides after a failed mutation.
 */
export function useOptimisticThreadList(serverThreads: ThreadSummary[], listKey: string) {
  const [hidden, setHidden] = useState<HiddenThreadMap>(() => new Map());

  useEffect(() => {
    setHidden((prev) => retainHiddenIdsStillOnServer(serverThreads, prev, listKey));
  }, [serverThreads, listKey]);

  const threads = useMemo(
    () => filterHiddenThreads(serverThreads, hidden),
    [serverThreads, hidden],
  );

  const hideThread = useCallback(
    (current: ThreadRef) => {
      const id = findThreadIdToHide(serverThreads, current);
      if (!id) return;
      setHidden((prev) => addHiddenId(prev, id, listKey));
    },
    [serverThreads, listKey],
  );

  const unhideThread = useCallback(
    (current: ThreadRef) => {
      const id = current.threadId || findThreadIdToHide(serverThreads, current);
      if (!id) return;
      setHidden((prev) => removeHiddenId(prev, id));
    },
    [serverThreads],
  );

  return {
    threads,
    hiddenCount: countHiddenOnServer(serverThreads, hidden),
    hideThread,
    unhideThread,
  };
}
