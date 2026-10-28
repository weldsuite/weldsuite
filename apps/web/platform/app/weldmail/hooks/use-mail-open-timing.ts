import { useEffect } from 'react';
import { markMailListFailed, markMailListShown } from '../lib/open-timing';

interface ThreadListQueryState {
  data: unknown;
  isFetching: boolean;
  isFetchedAfterMount: boolean;
  isError: boolean;
}

/**
 * Report the thread list to the open timing (../lib/open-timing.ts): when it
 * first has threads to show, and when it shows threads fetched from the server
 * during this open, which ends the open. Data restored from the persisted cache
 * counts as shown but not as fetched.
 */
export function useMailOpenTiming(query: ThreadListQueryState, enabled = true): void {
  const { data, isFetching, isFetchedAfterMount, isError } = query;
  useEffect(() => {
    if (!enabled) return;
    if (isError) {
      markMailListFailed();
      return;
    }
    if (data === undefined) return;
    markMailListShown(isFetchedAfterMount && !isFetching);
  }, [enabled, data, isFetching, isFetchedAfterMount, isError]);
}
