import { RealtimeSyncBridge as SharedBridge } from '@weldsuite/mobile-realtime';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { weldstashSyncMap } from '@/lib/sync-map';

/**
 * Bridges WorkspaceHub entity topics → TanStack Query invalidation for the
 * WMS mobile caches (products, stock, pick lists, warehouses).
 */
export function RealtimeSyncBridge() {
  const { user } = useClerkAuth();
  return (
    <SharedBridge
      syncMap={weldstashSyncMap}
      currentUserId={user?.id || ''}
      seedKeys={false}
    />
  );
}
