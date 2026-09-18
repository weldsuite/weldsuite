import { RealtimeSyncBridge as SharedBridge } from '@weldsuite/mobile-realtime';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { weldflowSyncMap } from '@/lib/sync-map';

/**
 * Bridges WorkspaceHub entity topics → TanStack Query invalidation for
 * WeldFlow mobile caches (projects, tasks, my-tasks, labels).
 */
export function RealtimeSyncBridge() {
  const { user } = useClerkAuth();
  return (
    <SharedBridge
      syncMap={weldflowSyncMap}
      currentUserId={user?.id || ''}
    />
  );
}
