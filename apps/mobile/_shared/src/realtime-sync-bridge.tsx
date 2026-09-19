import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useRealtimeSync,
  type EntitySyncMap,
} from '@weldsuite/realtime/react';
import { seedSyncMapKeys } from './seed-sync-map-keys';

export interface RealtimeSyncBridgeProps {
  syncMap: EntitySyncMap;
  currentUserId: string;
  /** Seed invalidate prefixes so non-TanStack listeners can observe them. Default true. */
  seedKeys?: boolean;
}

/**
 * Bridges WorkspaceHub entity topics → TanStack Query invalidation.
 * Mount inside QueryClientProvider + RealtimeProvider.
 */
export function RealtimeSyncBridge({
  syncMap,
  currentUserId,
  seedKeys = true,
}: RealtimeSyncBridgeProps) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!seedKeys) return;
    seedSyncMapKeys(queryClient, syncMap);
  }, [queryClient, syncMap, seedKeys]);

  useRealtimeSync({
    queryClient,
    syncMap,
    currentUserId,
  });

  return null;
}
