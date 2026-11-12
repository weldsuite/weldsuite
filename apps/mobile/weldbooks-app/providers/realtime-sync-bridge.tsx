import { RealtimeSyncBridge as SharedBridge } from '@weldsuite/mobile-realtime';
import { useAuthSession } from '@weldsuite/mobile-ui/contexts/AuthContext';
import { weldbooksSyncMap } from '@/lib/sync-map';

/**
 * Bridges WorkspaceHub accounting topics → TanStack Query invalidation.
 * Seeded keys let imperative screens observe invalidations via
 * useQueryKeyInvalidation / useBooksRealtime.
 */
export function RealtimeSyncBridge() {
  const { user } = useAuthSession();
  return (
    <SharedBridge
      syncMap={weldbooksSyncMap}
      currentUserId={user?.id || ''}
    />
  );
}
