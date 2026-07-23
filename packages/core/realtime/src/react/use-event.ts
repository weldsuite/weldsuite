import { useEffect, useRef } from 'react';
import { useWorkspaceClientMaybe } from './provider';
import type { WorkspaceEvent } from '../types';

/**
 * Subscribe to a specific event name on a workspace topic.
 *
 * Usage:
 *   useRealtimeEvent('contact', 'created', (data) => {
 *     toast(`New contact: ${data.name}`);
 *   });
 */
export function useRealtimeEvent<T = unknown>(
  topic: string,
  event: string,
  handler: (data: T, event: WorkspaceEvent<T>) => void,
): void {
  const client = useWorkspaceClientMaybe();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!client) return;
    return client.onEvent<T>(topic, event, (data, ev) => handlerRef.current(data, ev));
  }, [client, topic, event]);
}
