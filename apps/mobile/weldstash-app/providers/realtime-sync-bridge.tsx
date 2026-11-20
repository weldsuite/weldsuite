import { RealtimeSyncBridge as SharedBridge } from '@weldsuite/mobile-realtime';
import { useAuthSession } from '@weldsuite/mobile-ui/contexts/AuthContext';
import { weldstashSyncMap } from '@/lib/sync-map';

/**
 * Bridges WorkspaceHub entity topics → TanStack Query invalidation for the
 * WMS mobile caches (products, stock, pick lists, warehouses).
 */
export function RealtimeSyncBridge() {
  const { user } = useAuthSession();
  return (
    <SharedBridge
      syncMap={weldstashSyncMap}
      currentUserId={user?.id || ''}
      seedKeys={false}
    />
  );
}
