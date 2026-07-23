import { useEffect, useRef, useCallback } from 'react';
import { useWorkspaceClientMaybe } from './provider';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal interface covering the QueryClient methods we need.
 * Compatible with TanStack Query v5 QueryClient — consumers pass their own
 * instance so @weldsuite/realtime doesn't take a runtime dependency on it.
 */
export interface QueryClientLike {
  invalidateQueries(filters?: { queryKey?: readonly unknown[] }): Promise<void>;
  setQueryData(queryKey: readonly unknown[], updater: unknown): void;
  removeQueries(filters?: { queryKey?: readonly unknown[] }): void;
}

/**
 * Describes how a single entity type maps to the TanStack Query cache.
 *
 * The bridge uses this to decide what cache operations to perform when
 * a realtime event arrives for this entity type.
 */
export interface EntitySyncConfig {
  /** Query keys to invalidate on any CRUD event (lists, stats, aggregates). */
  invalidate: readonly (readonly unknown[])[];

  /**
   * On 'updated' events: merge the full entity into the detail cache.
   * Called immediately (not debounced) so the UI reflects the change instantly.
   * If not provided, falls back to invalidation only.
   */
  updateDetail?: (qc: QueryClientLike, entityId: string, data: unknown) => void;

  /**
   * On 'deleted' / 'archived' events: remove the entity from caches.
   * Called immediately (not debounced).
   * If not provided, falls back to invalidation only.
   */
  remove?: (qc: QueryClientLike, entityId: string) => void;
}

/**
 * Maps entity topic names (e.g. "project", "task", "contact") to their
 * cache sync configuration. Each app provides its own map.
 */
export type EntitySyncMap = Record<string, EntitySyncConfig>;

export interface RealtimeSyncConfig {
  /** TanStack Query QueryClient instance — pass useQueryClient() from your component. */
  queryClient: QueryClientLike;
  /** Entity-to-cache mapping for this app. */
  syncMap: EntitySyncMap;
  /** Current user's ID — events from this user are skipped (mutation already updated cache). */
  currentUserId: string;
  /** Debounce interval in ms for batching list invalidations. Default: 200. */
  debounceMs?: number;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Subscribes to @weldsuite/realtime entity topics and automatically syncs
 * the TanStack Query cache when other users mutate data.
 *
 * - `created` → debounced list invalidation
 * - `updated` → immediate setQueryData on detail cache + debounced list invalidation
 * - `deleted` / `archived` → immediate cache removal + debounced list invalidation
 * - Own-user events are skipped (the mutation's onSuccess already handled it)
 * - On reconnection, all queries are invalidated to catch up on missed events
 *
 * Usage (platform):
 * ```tsx
 * function RealtimeSyncBridge() {
 *   const queryClient = useQueryClient();
 *   const { userId } = useAuth();
 *   useRealtimeSync({
 *     queryClient,
 *     syncMap: platformSyncMap,
 *     currentUserId: userId!,
 *   });
 *   return null;
 * }
 * ```
 */
export function useRealtimeSync(config: RealtimeSyncConfig): void {
  const { queryClient, syncMap, currentUserId, debounceMs = 200 } = config;
  const client = useWorkspaceClientMaybe();

  // Refs for stable access in callbacks without re-subscribing
  const syncMapRef = useRef(syncMap);
  syncMapRef.current = syncMap;
  const userIdRef = useRef(currentUserId);
  userIdRef.current = currentUserId;

  // ---- Debounced invalidation ----

  const pendingKeys = useRef(new Set<readonly unknown[]>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    const keys = pendingKeys.current;
    if (keys.size === 0) return;
    const batch = Array.from(keys);
    keys.clear();
    for (const queryKey of batch) {
      queryClient.invalidateQueries({ queryKey: queryKey as unknown[] });
    }
  }, [queryClient]);

  const scheduleInvalidation = useCallback(
    (keys: readonly (readonly unknown[])[]) => {
      for (const key of keys) {
        pendingKeys.current.add(key);
      }
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, debounceMs);
    },
    [flush, debounceMs],
  );

  // ---- Topic subscriptions ----

  useEffect(() => {
    if (!client) return;

    const unsubscribes: (() => void)[] = [];
    const map = syncMapRef.current;

    for (const [topic, entityConfig] of Object.entries(map)) {
      const unsub = client.on(topic, (event) => {
        // Skip own events — mutation's onSuccess already updated cache
        if (event.userId === userIdRef.current) return;

        const entityId = (event.data as Record<string, unknown>)?.id as string | undefined;

        switch (event.event) {
          case 'created':
            scheduleInvalidation(entityConfig.invalidate);
            break;

          case 'updated':
            if (entityConfig.updateDetail && entityId) {
              entityConfig.updateDetail(queryClient, entityId, event.data);
            }
            scheduleInvalidation(entityConfig.invalidate);
            break;

          case 'replaced':
            // Treat as updated — emitted by some routes that fully replace
            // an entity rather than patching it.
            if (entityConfig.updateDetail && entityId) {
              entityConfig.updateDetail(queryClient, entityId, event.data);
            }
            scheduleInvalidation(entityConfig.invalidate);
            break;

          case 'deleted':
          case 'archived':
            if (entityConfig.remove && entityId) {
              entityConfig.remove(queryClient, entityId);
            }
            scheduleInvalidation(entityConfig.invalidate);
            break;

          default:
            // Custom / derived actions (won, lost, stage_changed, converted,
            // qualified, completed, shipped, delivered, approved, rejected,
            // cancelled, placed, unarchived, …) still mutate the entity, so
            // they must at least invalidate the lists. Without this they would
            // silently fall through and the UI would not refresh.
            scheduleInvalidation(entityConfig.invalidate);
            break;
        }
      });
      unsubscribes.push(unsub);
    }

    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      for (const unsub of unsubscribes) {
        unsub();
      }
    };
  }, [client, queryClient, scheduleInvalidation]);

  // ---- Reconnection ----
  //
  // The WorkspaceClient sends its last-seen `eventId` cursor on (re)subscribe,
  // and the server replays missed events from its event log. If the cursor is
  // older than the retention window, the server sends `resync_required` for
  // the affected topics and we fall back to invalidating those query keys.
  //
  // As a defence-in-depth fallback, on a reconnect WITHOUT a cursor we still
  // do the legacy "invalidate everything" sweep — this only fires on the very
  // first reconnect of a brand new tab.

  const hadConnection = useRef(false);

  useEffect(() => {
    if (!client) return;

    return client.onConnectionChange((state) => {
      if (state === 'connected') {
        if (hadConnection.current && !client.cursor) {
          queryClient.invalidateQueries();
        }
        hadConnection.current = true;
      }
    });
  }, [client, queryClient]);

  // ---- Resync required (cursor expired) — narrow invalidation by topic ----

  useEffect(() => {
    if (!client) return;

    return client.onResyncRequired((topics) => {
      const map = syncMapRef.current;
      for (const topic of topics) {
        const entry = map[topic];
        if (!entry) continue;
        for (const key of entry.invalidate) {
          queryClient.invalidateQueries({ queryKey: key as unknown[] });
        }
      }
    });
  }, [client, queryClient]);
}
