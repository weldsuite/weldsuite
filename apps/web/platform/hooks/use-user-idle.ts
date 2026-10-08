/**
 * User idle detection + idle-aware polling.
 *
 * Every workspace has its own Neon database that scales to zero after a few
 * minutes without queries. A `refetchInterval` poll keeps running while a tab
 * is merely *visible*, so an open-but-unattended tab (or desktop window) would
 * keep the tenant database awake forever. These helpers let a poll stop once
 * nobody has touched the page for a while and resume as soon as they return.
 *
 * Idle is decided from input on this document only (pointer, keyboard, wheel,
 * scroll, touch, focus, tab becoming visible). It is intentionally independent
 * of the presence status: a user who set themselves to "busy" or "dnd" is
 * still at the keyboard. It needs no provider, so it also works in tests and on
 * pages outside the shell.
 *
 * Limitation: input that lands inside a cross-origin iframe (WeldApps) never
 * reaches this document, so a user working only inside an app counts as idle
 * until their pointer or focus returns to the platform shell.
 */

import { useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';

/** How long without input before the user counts as idle. */
export const DEFAULT_IDLE_AFTER_MS = 5 * 60 * 1000;

/** Input events fire constantly (mousemove); only register one per interval. */
const ACTIVITY_THROTTLE_MS = 1000;

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

// ---------------------------------------------------------------------------
// Shared activity tracker
//
// One set of document listeners serves every consumer. They are attached when
// the first consumer mounts and removed with the last, so nothing leaks into
// tests or pages that never use the hook.
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
let lastActivityAt = Date.now();
let detachDomListeners: (() => void) | null = null;

function registerActivity(): void {
  const now = Date.now();
  if (now - lastActivityAt < ACTIVITY_THROTTLE_MS) return;
  lastActivityAt = now;
  for (const listener of listeners) listener();
}

function onVisibilityChange(): void {
  // Coming back to the tab counts as activity; hiding it does not.
  if (document.visibilityState === 'visible') registerActivity();
}

function attachDomListeners(): () => void {
  // Nothing was observed while detached, so start from "just now".
  lastActivityAt = Date.now();
  // Capture so a handler that stops propagation cannot hide input from us;
  // capture also catches `scroll` on any element, not just the document.
  const options = { passive: true, capture: true } as const;
  for (const event of ACTIVITY_EVENTS) document.addEventListener(event, registerActivity, options);
  document.addEventListener('visibilitychange', onVisibilityChange, options);
  window.addEventListener('focus', registerActivity, options);
  return () => {
    for (const event of ACTIVITY_EVENTS) document.removeEventListener(event, registerActivity, options);
    document.removeEventListener('visibilitychange', onVisibilityChange, options);
    window.removeEventListener('focus', registerActivity, options);
  };
}

function subscribeToActivity(listener: () => void): () => void {
  if (listeners.size === 0) detachDomListeners = attachDomListeners();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      detachDomListeners?.();
      detachDomListeners = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * True once the user has not interacted with the page for `idleAfterMs`.
 *
 * Re-renders only on the idle <-> active transitions, never on individual
 * input events. Starts as "not idle".
 */
export function useUserIdle(idleAfterMs: number = DEFAULT_IDLE_AFTER_MS): boolean {
  const [isIdle, setIsIdle] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    let idle = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function arm(): void {
      const remaining = Math.max(0, idleAfterMs - (Date.now() - lastActivityAt));
      timer = setTimeout(check, remaining);
    }

    // The timer is never reset on input: when it fires it re-measures against
    // the shared clock and re-arms for whatever is left.
    function check(): void {
      timer = undefined;
      if (Date.now() - lastActivityAt >= idleAfterMs) {
        idle = true;
        setIsIdle(true);
      } else {
        arm();
      }
    }

    function onActivity(): void {
      if (!idle) return;
      idle = false;
      setIsIdle(false);
      arm();
    }

    const unsubscribe = subscribeToActivity(onActivity);
    // A consumer that mounts while the user is already idle must start idle.
    idle = Date.now() - lastActivityAt >= idleAfterMs;
    setIsIdle(idle);
    if (!idle) arm();

    return () => {
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [idleAfterMs]);

  return isIdle;
}

interface IdleAwareRefetchIntervalOptions {
  /**
   * Extra gate on top of idleness (e.g. "this frame is the visible one").
   * While false the poll is off; flipping it back to true refreshes once.
   */
  active?: boolean;
  /** Override the idle threshold (defaults to {@link DEFAULT_IDLE_AFTER_MS}). */
  idleAfterMs?: number;
}

/**
 * `refetchInterval` for a poll that should only run while the user is around.
 *
 * Returns `intervalMs` while the user is active (and `active` is not false),
 * `false` otherwise. When polling resumes after having been paused, the query
 * is refreshed once straight away so the data is current the moment the user
 * is back instead of up to one interval later.
 *
 * Pass the same `queryKey` the `useQuery` uses:
 *
 * ```ts
 * const refetchInterval = useIdleAwareRefetchInterval(key, 60_000);
 * useQuery({ queryKey: key, queryFn, refetchInterval });
 * ```
 */
export function useIdleAwareRefetchInterval(
  queryKey: QueryKey,
  intervalMs: number,
  options: IdleAwareRefetchIntervalOptions = {},
): number | false {
  const { active = true, idleAfterMs } = options;
  const isIdle = useUserIdle(idleAfterMs);
  const queryClient = useQueryClient();

  const polling = active && !isIdle;

  // Key arrays are usually rebuilt on every render; keep the latest in a ref
  // so the resume effect only re-runs when `polling` actually changes.
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;
  const wasPollingRef = useRef(polling);

  useEffect(() => {
    if (polling && !wasPollingRef.current) {
      // `cancelRefetch: false` so several observers of one query resuming in
      // the same tick share a single request instead of cancelling each other.
      void queryClient.invalidateQueries({ queryKey: queryKeyRef.current, exact: true }, { cancelRefetch: false });
    }
    wasPollingRef.current = polling;
  }, [polling, queryClient]);

  return polling ? intervalMs : false;
}
