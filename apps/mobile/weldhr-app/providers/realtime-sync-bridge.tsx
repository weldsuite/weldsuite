import { RealtimeSyncBridge as SharedBridge } from '@weldsuite/mobile-realtime';
import { useAuthSession } from '@weldsuite/mobile-ui/contexts/AuthContext';
import { appSyncMap } from '@/lib/sync-map';

export function RealtimeSyncBridge() {
  const { user } = useAuthSession();
  return (
    <SharedBridge
      syncMap={appSyncMap}
      currentUserId={user?.id || ''}
    />
  );
}
