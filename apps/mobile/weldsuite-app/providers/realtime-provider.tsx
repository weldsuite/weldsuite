/**
 * RealtimeProvider for the mobile app.
 *
 * Wraps @weldsuite/realtime's RealtimeProvider with Clerk auth and
 * the realtime WebSocket URL from env. Backs the replay cursor onto
 * AsyncStorage so cold launches can replay events missed while the app
 * was backgrounded or offline.
 */

import React, { useMemo } from 'react';
import { RealtimeProvider as BaseProvider } from '@weldsuite/realtime/react';
import { useClerkAuth } from '@/contexts/ClerkAuthContext';
import { createAsyncStorageCursorStore } from '@/lib/realtime/cursor-store';

const REALTIME_URL =
  process.env.EXPO_PUBLIC_REALTIME_URL || 'ws://localhost:8790';

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const { getToken, organizationId } = useClerkAuth();

  // Cursor store is scoped per-org; switching orgs starts a clean replay window.
  const cursorStore = useMemo(
    () => createAsyncStorageCursorStore(organizationId || 'no-org'),
    [organizationId],
  );

  return (
    <BaseProvider
      url={`${REALTIME_URL}/ws`}
      getToken={async () => (await getToken()) || ''}
      cursorStore={cursorStore}
    >
      {children}
    </BaseProvider>
  );
}
