/**
 * useSocialRealtime — workspace-hub social events for weldsocial-app.
 *
 * No QueryClient yet (lists use useAsyncData). Mirrors weldbooks-app's
 * useBooksRealtime pattern: subscribe to hub entity topics and call
 * onInvalidate(surface) so open screens can reload.
 *
 * Full useRealtimeSync trails in Phase 8 once Social adopts TanStack Query.
 */

import { useEffect, useRef } from 'react';
import { useWorkspaceClientMaybe } from '@weldsuite/realtime/react';
import type { WorkspaceEvent } from '@weldsuite/realtime/types';
import {
  SOCIAL_HUB_TOPICS,
  dispatchSocialRealtimeEvent,
  type SocialRealtimeHandlers,
  type SocialRealtimeSurface,
} from './social-realtime-dispatch';

export type { SocialRealtimeSurface, SocialRealtimeHandlers };
export { SOCIAL_HUB_TOPICS, dispatchSocialRealtimeEvent };

interface UseSocialRealtimeOptions extends SocialRealtimeHandlers {
  /** When false, skip subscription (e.g. signed-out). Default true. */
  enabled?: boolean;
}

export function useSocialRealtime(options: UseSocialRealtimeOptions): void {
  const { enabled = true } = options;
  const client = useWorkspaceClientMaybe();
  const handlersRef = useRef<SocialRealtimeHandlers>(options);
  useEffect(() => {
    handlersRef.current = options;
  });

  useEffect(() => {
    if (!client || !enabled) return;

    const offs = SOCIAL_HUB_TOPICS.map((topic) =>
      client.on(topic, (event: WorkspaceEvent) => {
        dispatchSocialRealtimeEvent(
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
