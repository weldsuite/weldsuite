/**
 * A callback that runs at most once per `intervalMs`: the first call runs at
 * once, calls inside the window collapse into one trailing run at its end.
 * The pending run is dropped on unmount.
 */

import { useCallback, useEffect, useRef } from 'react';

export function useThrottledCallback(callback: () => void, intervalMs: number): () => void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const lastRunRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    },
    [],
  );

  return useCallback(() => {
    if (timerRef.current !== null) return;
    const now = Date.now();
    const last = lastRunRef.current;
    const wait = last === null ? 0 : Math.max(0, last + intervalMs - now);
    if (wait === 0) {
      lastRunRef.current = now;
      callbackRef.current();
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      lastRunRef.current = Date.now();
      callbackRef.current();
    }, wait);
  }, [intervalMs]);
}
