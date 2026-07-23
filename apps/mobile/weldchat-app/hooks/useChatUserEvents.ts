/**
 * User-level chat event subscription for sidebar refresh.
 * Listens for new channels, new DMs, and unread updates on the user's personal
 * topic (`chat.user.<userId>`).
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

  // Any event on the personal topic (channel_new, dm_new, unread, …) triggers a
  // sidebar refresh. An empty topic (user not loaded yet) is a no-op in useTopic.
  useTopic(userId ? `chat.user.${userId}` : '', () => onUpdateRef.current());
}
