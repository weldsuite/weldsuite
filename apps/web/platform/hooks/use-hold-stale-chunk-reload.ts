import { useEffect, useSyncExternalStore } from 'react';
import {
  getStaleChunkReloadState,
  holdStaleChunkReload,
  subscribeStaleChunkReload,
  type StaleChunkReloadState,
} from '@/lib/chunk-reload';

/**
 * While `active` (a call or meeting is live), a new frontend version does not
 * reload the page: the reload waits until the call is over. See
 * `lib/chunk-reload.ts`.
 */
export function useHoldStaleChunkReload(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return holdStaleChunkReload();
  }, [active]);
}

/** Whether a call holds the update reload, and whether one is waiting. */
export function useStaleChunkReloadState(): StaleChunkReloadState {
  return useSyncExternalStore(subscribeStaleChunkReload, getStaleChunkReloadState, getStaleChunkReloadState);
}
