/**
 * useRealtimeQuerySync
 *
 * Subscribes to the local `dataEvents` emitter (which receives @weldsuite/realtime events via
 * the bridge in data-events.ts) and invalidates the corresponding TanStack
 * Query caches so the UI updates in real-time.
 *
 * - Uses `dataEvents` rather than direct realtime subscriptions — the bridge
 *   already maps entity types and filters out own events.
 * - Debounces rapid events (300ms) so bulk mutations cause a single invalidation.
 * - Only refetches active (mounted) queries via `invalidateQueries`.
 * - On reconnection (disconnected/suspended → connected), invalidates all
 *   queries to catch up on events missed while offline.
 */

import { useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { dataEvents, type DataEventType } from '@/lib/events/data-events';
import { usePlatformEvents } from '@/contexts/platform-events-context';

// Inlined to avoid dragging the per-module query hook files into the shell
// bundle. Shape must stay in lockstep with hooks/queries/use-*-queries.ts.
const projectKeys = { all: ['projects'] as const };
const taskKeys = { all: ['task'] as const };
const companyKeys = { all: ['companies'] as const };
const personKeys = { all: ['people'] as const };
const leadKeys = { all: ['crm', 'leads'] as const };
const opportunityKeys = { all: ['crm', 'opportunities'] as const };
const pipelineKeys = { all: ['crm', 'pipelines'] as const };
const commerceProductKeys = { all: ['commerce', 'products'] as const };
const accountingKeys = { all: ['accounting'] as const };
const helpdeskKeys = { all: ['helpdesk'] as const };
const notificationKeys = { all: ['notifications'] as const };
const weldmeetKeys = { all: ['weldmeet'] as const };
const calendarKeys = { all: ['calendar'] as const };

/**
 * Maps each DataEventType to the query key(s) that should be invalidated.
 */
const EVENT_TO_QUERY_KEYS: Record<DataEventType, readonly (readonly unknown[])[]> = {
  'projects:changed': [projectKeys.all],
  'tasks:changed': [taskKeys.all],
  'people:changed': [personKeys.all],
  'companies:changed': [companyKeys.all],
  'leads:changed': [leadKeys.all],
  'opportunities:changed': [opportunityKeys.all, pipelineKeys.all],
  'products:changed': [commerceProductKeys.all],
  'inventory:changed': [commerceProductKeys.all],
  'invoices:changed': [accountingKeys.all],
  'bills:changed': [accountingKeys.all],
  'payments:changed': [accountingKeys.all],
  'tickets:changed': [helpdeskKeys.all],
  'notifications:changed': [notificationKeys.all],
  'meetings:changed': [weldmeetKeys.all],
  'calendar_events:changed': [calendarKeys.all],
};

const DEBOUNCE_MS = 300;

export function useRealtimeQuerySync(): void {
  const queryClient = useQueryClient();
  const { connectionState } = usePlatformEvents();
  const prevConnectionState = useRef(connectionState);
  const pendingInvalidations = useRef<Set<DataEventType>>(new Set());
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushInvalidations = useCallback(() => {
    const pending = pendingInvalidations.current;
    if (pending.size === 0) return;

    // Collect all unique query keys to invalidate
    const keysToInvalidate = new Set<readonly unknown[]>();
    for (const eventType of pending) {
      const keys = EVENT_TO_QUERY_KEYS[eventType];
      if (keys) {
        for (const key of keys) {
          keysToInvalidate.add(key);
        }
      }
    }

    pending.clear();

    for (const queryKey of keysToInvalidate) {
      queryClient.invalidateQueries({ queryKey: queryKey as unknown[] });
    }
  }, [queryClient]);

  const scheduleInvalidation = useCallback(
    (eventType: DataEventType) => {
      pendingInvalidations.current.add(eventType);

      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
      debounceTimer.current = setTimeout(flushInvalidations, DEBOUNCE_MS);
    },
    [flushInvalidations],
  );

  // Subscribe to all data event types
  useEffect(() => {
    const unsubscribes: (() => void)[] = [];

    const eventTypes = Object.keys(EVENT_TO_QUERY_KEYS) as DataEventType[];
    for (const eventType of eventTypes) {
      const unsub = dataEvents.on(eventType, () => {
        scheduleInvalidation(eventType);
      });
      unsubscribes.push(unsub);
    }

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
      for (const unsub of unsubscribes) {
        unsub();
      }
    };
  }, [scheduleInvalidation]);

  // On reconnection, invalidate everything to catch up on missed events
  useEffect(() => {
    const prev = prevConnectionState.current;
    prevConnectionState.current = connectionState;

    if (
      connectionState === 'connected' &&
      (prev === 'disconnected' || prev === 'suspended')
    ) {
      queryClient.invalidateQueries();
    }
  }, [connectionState, queryClient]);
}
