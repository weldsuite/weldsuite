import { RealtimeSyncBridge as SharedBridge } from '@weldsuite/mobile-realtime';
import { useAuthSession } from '@weldsuite/mobile-ui/contexts/AuthContext';
import { weldflowSyncMap } from '@/lib/sync-map';

/**
 * Bridges WorkspaceHub entity topics → TanStack Query invalidation for
 * WeldFlow mobile caches (projects, tasks, my-tasks, labels).
 */
export function RealtimeSyncBridge() {
  const { user } = useAuthSession();
  return (
    <SharedBridge
      syncMap={weldflowSyncMap}
      currentUserId={user?.id || ''}
    />
  );
}
