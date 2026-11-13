import React from 'react';
import { RealtimeProvider as BaseProvider } from '@weldsuite/realtime/react';
import { useAuthSession } from '@weldsuite/mobile-ui/contexts/AuthContext';
import { realtimeUrl } from '@weldsuite/mobile-platform/api';

export function RealtimeProvider({ children }: Readonly<{ children: React.ReactNode }>) {
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
