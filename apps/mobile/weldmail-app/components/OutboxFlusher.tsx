/**
 * Side-effect component that drains the offline mutation outbox at the moments
 * it's most likely to succeed: on mount, when connectivity returns
 * (offline→online edge), and when the app comes back to the foreground (the JS
 * runtime + sockets are suspended in the background, so resume is a natural
 * retry point). Renders nothing.
 *
 * After a batch flush that actually changed server state, it reconciles the
 * mailbox (refreshMail → refetch), so once queued ops land the UI converges to
 * server truth and the now-redundant pending overlay drops away. Flush always
 * runs before the refresh, so the refetch sees the synced state.
 *
 * Conflict policy (where the pieces live):
 *   - Server-wins on hard conflicts: an op the server rejects (e.g. updating a
 *     message deleted on another device) is dropped by flushOutbox, not retried.
 *   - Last-local-write-wins for flags while offline: the pending overlay
 *     (applyOps) shows the local intent until it syncs or is dropped.
 *   - Both the outbox flush here and the realtime path (useMailRealtime →
 *     refreshMail) drive revalidation, so server changes and queued local
 *     changes both reconcile on reconnect.
 *
 * Must live inside NetworkProvider (connectivity), ClerkAuthProvider (org id),
 * and MailProvider (refreshMail). flushMailOutbox guards against overlapping
 * runs, so firing from several triggers at once is safe.
 */

import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useNetworkStatus } from '@/contexts/NetworkContext';
import { useMail } from '@/contexts/MailContext';
import { flushMailOutbox } from '@/lib/offline/flush';
import { shouldReconcileAfterFlush } from '@/lib/offline/outbox';

export function OutboxFlusher() {
  const { organizationId, user } = useClerkAuth();
  const orgId = organizationId ?? 'no-org';
  const { isOnline } = useNetworkStatus();
  const { refreshMail } = useMail();
  const wasOnlineRef = useRef(isOnline);

  // Flush, then reconcile the mailbox if anything synced (or was dropped as a
  // server-wins conflict) so the UI converges to server truth.
  const flushThenReconcile = useCallback(async () => {
    const result = await flushMailOutbox(orgId);
    if (shouldReconcileAfterFlush(result)) refreshMail();
  }, [orgId, refreshMail]);

  // Flush on mount and whenever the active org changes (only when signed in).
  useEffect(() => {
    if (user) flushThenReconcile();
  }, [user, flushThenReconcile]);

  // Flush on the offline→online transition.
  useEffect(() => {
    if (user && isOnline && !wasOnlineRef.current) flushThenReconcile();
    wasOnlineRef.current = isOnline;
  }, [isOnline, user, flushThenReconcile]);

  // Flush when the app returns to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && user) flushThenReconcile();
    });
    return () => sub.remove();
  }, [user, flushThenReconcile]);

  return null;
}
