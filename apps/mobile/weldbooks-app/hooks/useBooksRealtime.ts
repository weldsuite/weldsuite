/**
 * useBooksRealtime — workspace-hub accounting events for weldbooks-app.
 *
 * No QueryClient yet (lists use usePagedList). Mirrors welddesk-app's
 * useInboxRealtime pattern: subscribe to hub entity topics and call
 * onInvalidate(surface) so open screens can reload.
 *
 * Full useRealtimeSync trails in Phase 8 once Books adopts TanStack Query.
 */

import { useEffect, useRef } from 'react';
import { useWorkspaceClientMaybe } from '@weldsuite/realtime/react';
import type { WorkspaceEvent } from '@weldsuite/realtime/types';
import {
  BOOKS_HUB_TOPICS,
  dispatchBooksRealtimeEvent,
  type BooksRealtimeHandlers,
  type BooksRealtimeSurface,
} from './books-realtime-dispatch';

export type { BooksRealtimeSurface, BooksRealtimeHandlers };
export { BOOKS_HUB_TOPICS, dispatchBooksRealtimeEvent };

interface UseBooksRealtimeOptions extends BooksRealtimeHandlers {
  /** When false, skip subscription (e.g. signed-out). Default true. */
  enabled?: boolean;
}

export function useBooksRealtime(options: UseBooksRealtimeOptions): void {
  const { enabled = true } = options;
  const client = useWorkspaceClientMaybe();
  const handlersRef = useRef<BooksRealtimeHandlers>(options);
  useEffect(() => {
    handlersRef.current = options;
  });

  useEffect(() => {
    if (!client || !enabled) return;

    const offs = BOOKS_HUB_TOPICS.map((topic) =>
      client.on(topic, (event: WorkspaceEvent) => {
        dispatchBooksRealtimeEvent(
          event.topic || topic,
          event.event,
          handlersRef.current,
        );
      }),
    );

    return () => {
      for (const off of offs) off();
    };
  }, [client, enabled]);
}
