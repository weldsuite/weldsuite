/**
 * useMailEntityRealtime — workspace-hub mail entity events for weldmail-app.
 *
 * No QueryClient yet (lists use MailContext). Mirrors weldsocial-app's
 * useSocialRealtime pattern: subscribe to hub entity topics and call
 * onInvalidate(surface) so open screens can reload.
 *
 * Personal `mail.{userId}` / mail:new stays on useMailRealtime.
 * Full useRealtimeSync trails in Phase 8 once Mail adopts TanStack Query.
 */

import { useEffect, useRef } from 'react';
import { useWorkspaceClientMaybe } from '@weldsuite/realtime/react';
import type { WorkspaceEvent } from '@weldsuite/realtime/types';
import {
  MAIL_ENTITY_HUB_TOPICS,
  dispatchMailEntityRealtimeEvent,
  type MailEntityRealtimeHandlers,
  type MailEntityRealtimeSurface,
} from './mail-entity-realtime-dispatch';

export type { MailEntityRealtimeSurface, MailEntityRealtimeHandlers };
export { MAIL_ENTITY_HUB_TOPICS, dispatchMailEntityRealtimeEvent };

interface UseMailEntityRealtimeOptions extends MailEntityRealtimeHandlers {
  /** When false, skip subscription (e.g. signed-out). Default true. */
  enabled?: boolean;
}

export function useMailEntityRealtime(options: UseMailEntityRealtimeOptions): void {
  const { enabled = true } = options;
  const client = useWorkspaceClientMaybe();
  const handlersRef = useRef<MailEntityRealtimeHandlers>(options);
  useEffect(() => {
    handlersRef.current = options;
  });

  useEffect(() => {
    if (!client || !enabled) return;

    const offs = MAIL_ENTITY_HUB_TOPICS.map((topic) =>
      client.on(topic, (event: WorkspaceEvent) => {
        dispatchMailEntityRealtimeEvent(
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
