/**
 * Persistent storage for the WorkspaceClient's last-seen `eventId` cursor.
 *
 * Web implementation backs onto `localStorage`, scoped by workspaceId so
 * switching workspaces (or logging out) cleanly starts the cursor over.
 *
 * Mirror lives at apps/mobile/weldsuite-app/lib/realtime/cursor-store.ts and
 * backs onto AsyncStorage with the same key shape.
 */

import type { CursorStore } from '@weldsuite/realtime';

const KEY_PREFIX = 'weldsuite.realtime.cursor.';

export function createBrowserCursorStore(workspaceId: string): CursorStore {
  const key = `${KEY_PREFIX}${workspaceId}`;
  return {
    get: () => {
      if (typeof window === 'undefined') return null;
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (eventId: string) => {
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(key, eventId);
      } catch {
        // Storage quota / private mode — fail silently; in-memory cursor still works.
      }
    },
    clear: () => {
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.removeItem(key);
      } catch {
        // ignore
      }
    },
  };
}
