import { useEffect, useRef } from 'react';

export interface UseLeaveCallGuardOptions {
  /**
   * While true, reloading, closing the tab or navigating the page away asks
   * the browser to confirm first. Set it only for an active call: a prompt on
   * a lobby or an ended screen is noise.
   */
  warn: boolean;
  /**
   * Runs once the page is really going away. Use it for the keepalive "leave"
   * request. It must not run on `beforeunload`: that fires before the user
   * answers the prompt, so cancelling would leave them in a call the server
   * already closed.
   */
  onLeave?: () => void;
}

/**
 * Guards an in-call page against an accidental reload or tab close.
 *
 * Browsers show their own generic "Leave site?" text; a page can no longer
 * supply its own message. In-app (client-side) navigation is not affected,
 * the call keeps running across it.
 */
export function useLeaveCallGuard({ warn, onLeave }: UseLeaveCallGuardOptions): void {
  const onLeaveRef = useRef(onLeave);
  useEffect(() => {
    onLeaveRef.current = onLeave;
  }, [onLeave]);

  useEffect(() => {
    if (!warn) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older Chromium/Safari only prompt when returnValue is set.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [warn]);

  useEffect(() => {
    // `pagehide` fires only when the page is actually unloading (after the
    // prompt was accepted), and is also the event mobile Safari reliably
    // fires on tab close.
    const handler = () => onLeaveRef.current?.();
    window.addEventListener('pagehide', handler);
    return () => window.removeEventListener('pagehide', handler);
  }, []);
}
