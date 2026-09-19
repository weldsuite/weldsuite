import { RealtimeSyncBridge as SharedBridge } from '@weldsuite/mobile-realtime';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { appSyncMap } from '@/lib/sync-map';

export function RealtimeSyncBridge() {
  const { user } = useClerkAuth();
  return (
    <SharedBridge
      syncMap={appSyncMap}
      currentUserId={user?.id || ''}
    />
  );
}
