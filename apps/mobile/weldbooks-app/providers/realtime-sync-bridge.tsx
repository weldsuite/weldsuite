import { RealtimeSyncBridge as SharedBridge } from '@weldsuite/mobile-realtime';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { weldbooksSyncMap } from '@/lib/sync-map';

/**
 * Bridges WorkspaceHub accounting topics → TanStack Query invalidation.
 * Seeded keys let imperative screens observe invalidations via
 * useQueryKeyInvalidation / useBooksRealtime.
 */
export function RealtimeSyncBridge() {
  const { user } = useClerkAuth();
  return (
    <SharedBridge
      syncMap={weldbooksSyncMap}
      currentUserId={user?.id || ''}
    />
  );
}
