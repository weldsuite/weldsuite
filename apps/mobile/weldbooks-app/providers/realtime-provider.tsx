import React from 'react';
import { RealtimeProvider as BaseProvider } from '@weldsuite/realtime/react';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';

const REALTIME_URL = process.env.EXPO_PUBLIC_REALTIME_URL || 'ws://localhost:8790';

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const { getToken } = useClerkAuth();

  return (
    <BaseProvider
      url={`${REALTIME_URL}/ws`}
      getToken={async () => (await getToken()) || ''}
    >
      {children}
    </BaseProvider>
  );
}
