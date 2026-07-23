import { useEffect, useRef } from 'react';
import { useWorkspaceClientMaybe } from './provider';
import type { WorkspaceEvent } from '../types';

/**
 * Subscribe to all events on a workspace topic.
 *
 * Subscribing to "project" will receive events for "project",
 * "project.proj_123", etc.
 *
 * Usage:
 *   useTopic('project', () => {
 *     queryClient.invalidateQueries({ queryKey: ['projects'] });
 *   });
 */
export function useTopic<T = unknown>(
  topic: string,
  handler: (event: WorkspaceEvent<T>) => void,
): void {
  const client = useWorkspaceClientMaybe();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!client) return;
    return client.on<T>(topic, (event) => handlerRef.current(event));
  }, [client, topic]);
}
