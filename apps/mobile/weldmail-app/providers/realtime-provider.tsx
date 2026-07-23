import React, { useEffect, useMemo } from 'react';
import { AppState } from 'react-native';
import { RealtimeProvider as BaseProvider, useWorkspaceClientMaybe } from '@weldsuite/realtime/react';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { createAsyncStorageCursorStore } from '@/lib/realtime/cursor-store';
import { RealtimeStatusBanner } from '@/components/RealtimeStatusBanner';

const REALTIME_URL = process.env.EXPO_PUBLIC_REALTIME_URL || 'ws://localhost:8790';

/**
 * Re-establish the workspace socket when the app returns to the foreground.
 * iOS/Android suspend the JS runtime + socket in the background, so the
 * connection is almost always stale on resume — `reconnect()` no-ops if the
 * socket is genuinely still OPEN, otherwise forces a fresh connect (cursor
 * replay backfills anything missed while away). Must live inside BaseProvider
 * to read the shared client; AppState is RN-only so it can't go in the shared
 * package (the web platform uses the same provider).
 */
function ForegroundReconnect() {
  const client = useWorkspaceClientMaybe();
  useEffect(() => {
    if (!client) return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') client.reconnect();
    });
    return () => sub.remove();
  }, [client]);
  return null;
}

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const { getToken, organizationId, user } = useClerkAuth();

  // Persist the last-seen eventId per workspace so reconnects replay missed
  // events (`since:` cursor) instead of dropping them. Scoped by org so an org
  // switch / logout restarts the replay window cleanly.
  const cursorStore = useMemo(
    () => createAsyncStorageCursorStore(organizationId || 'no-org'),
    [organizationId],
  );

  // Key the provider to the signed-in user so the underlying WorkspaceClient is
  // fully torn down (disconnect) and recreated whenever the user changes —
  // sign-out / sign-in / account switch. The auth tree is NOT unmounted on
  // sign-out (the route guard only navigates), so without this key the socket
  // would survive authenticated as the previous user.
  const clientKey = user?.id ?? 'signed-out';

  // Only connect when the user is signed in.
  if (!user) {
    return <>{children}</>;
  }

  return (
    <BaseProvider
      key={clientKey}
      url={`${REALTIME_URL}/ws`}
      getToken={async () => (await getToken()) || ''}
      cursorStore={cursorStore}
    >
      <ForegroundReconnect />
      <RealtimeStatusBanner />
      {children}
    </BaseProvider>
  );
}
