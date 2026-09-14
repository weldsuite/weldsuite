/**
 * User-level chat event subscription for sidebar refresh.
 * Listens for new channels, new DMs, and unread updates on the user's personal
 * topic (`chat.user.<userId>`), plus in-app notification creates
 * (`notification.<userId>`) so the Activity tab / badge update when a DM or
 * mention lands even if the chat.user fan-out is delayed.
 *
 * Uses the SHARED WorkspaceClient owned by <RealtimeProvider> (via useTopic) —
 * NOT a second standalone connection. CallContext subscribes to the same topic
 * on the same socket, so the whole app holds a single WorkspaceHub connection
 * with cursor-based replay on reconnect.
 */

import { useRef } from 'react';
import { useUser } from '@clerk/expo';
import { useTopic } from '@weldsuite/realtime/react';

export function useChatUserEvents(onUpdate: () => void) {
  const { user } = useUser();
  const userId = user?.id;
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  // Any event on the personal chat topic (channel_new, dm_new, unread, …)
  // triggers a sidebar / activity refresh.
  useTopic(userId ? `chat.user.${userId}` : '', () => onUpdateRef.current());

  // In-app notification creates (from createAndDeliverNotification) — needed so
  // Activity updates when the chat.user event is missed or the user is only
  // watching the notification stream.
  useTopic(userId ? `notification.${userId}` : '', (event) => {
    if (event.event === 'created') onUpdateRef.current();
  });
}
