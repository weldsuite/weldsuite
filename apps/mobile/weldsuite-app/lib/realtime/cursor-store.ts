/**
 * Persistent storage for the WorkspaceClient's last-seen `eventId` cursor.
 *
 * Mobile implementation backs onto AsyncStorage, scoped per-workspace so
 * org switches (or logout) cleanly restart the replay window. Mirrors
 * `apps/web/platform/lib/realtime/cursor-store.ts` — same key shape.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CursorStore } from '@weldsuite/realtime';

const KEY_PREFIX = 'weldsuite.realtime.cursor.';

export function createAsyncStorageCursorStore(workspaceId: string): CursorStore {
  const key = `${KEY_PREFIX}${workspaceId}`;
  return {
    get: async () => {
      try {
        return await AsyncStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set: async (eventId: string) => {
      try {
        await AsyncStorage.setItem(key, eventId);
      } catch {
        // Quota / device-locked — fail silently; in-memory cursor still works.
      }
    },
    clear: async () => {
      try {
        await AsyncStorage.removeItem(key);
      } catch {
        // ignore
      }
    },
  };
}
