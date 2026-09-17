import { useQueryClient } from '@tanstack/react-query';
import { useRealtimeSync } from '@weldsuite/realtime/react';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { weldstashSyncMap } from '@/lib/sync-map';

/**
 * Bridges WorkspaceHub entity topics → TanStack Query invalidation for the
 * WMS mobile caches (products, stock, pick lists, warehouses).
 */
export function RealtimeSyncBridge() {
  const queryClient = useQueryClient();
  const { user } = useClerkAuth();
  useRealtimeSync({
    queryClient,
    syncMap: weldstashSyncMap,
    currentUserId: user?.id || '',
  });
  return null;
}
