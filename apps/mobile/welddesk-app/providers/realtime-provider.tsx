import React from 'react';
import { RealtimeProvider as BaseProvider } from '@weldsuite/realtime/react';
import { useAuthSession } from '@weldsuite/mobile-ui/contexts/AuthContext';
import { useWorkspaceForRequests } from '@weldsuite/mobile-platform/auth';
import { realtimeUrl } from '@weldsuite/mobile-platform/api';

/**
 * The workspace hub socket (`<server>/ws`). On WeldID (membership mode) the
 * token names no workspace, so the socket names the active one
 * (`?workspace=`); a workspace switch reconnects.
 */
export function RealtimeProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const { getToken } = useAuthSession();
  const workspace = useWorkspaceForRequests();

  return (
    <BaseProvider
      url={`${realtimeUrl()}/ws`}
      getToken={async () => (await getToken()) || ''}
      workspace={workspace}
    >
      {children}
    </BaseProvider>
  );
}
