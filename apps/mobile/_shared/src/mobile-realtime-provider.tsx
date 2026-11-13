import React from 'react';
import { RealtimeProvider as BaseProvider } from '@weldsuite/realtime/react';
import { useAuthSession } from '@weldsuite/mobile-ui/contexts/AuthContext';
import { realtimeUrl } from '@weldsuite/mobile-platform/api';

/**
 * Simple session-token RealtimeProvider for Expo shells, on the server the
 * app runs against (`getMobileRuntime().realtimeUrl`).
 * Mail/Chat keep their richer cursor + foreground reconnect variants.
 */
export function MobileRealtimeProvider({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { getToken } = useAuthSession();

  return (
    <BaseProvider
      url={`${realtimeUrl()}/ws`}
      getToken={async () => (await getToken()) || ''}
    >
      {children}
    </BaseProvider>
  );
}
