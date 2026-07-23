/**
 * WeldChat Typing Hooks — @weldsuite/realtime
 *
 * Uses RoomClient typing for typing indicators.
 */

import { useEffect, useCallback, useState } from 'react';
import type { RoomClient } from '@weldsuite/realtime/client';
import type { TypingUser } from '@weldsuite/realtime/types';

export { type TypingUser };

export function useTypingPublisher(client: RoomClient | null) {
  const onKeystroke = useCallback(() => {
    client?.startTyping();
  }, [client]);

  const onSend = useCallback(() => {
    client?.stopTyping();
  }, [client]);

  return { onKeystroke, onSend };
}

export function useTypingSubscriber(client: RoomClient | null): TypingUser[] {
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);

  useEffect(() => {
    if (!client) return;

    // onTyping fires immediately with current state and on every change
    const unsub = client.onTyping(setTypingUsers);

    return () => {
      unsub();
      setTypingUsers([]);
    };
  }, [client]);

  return typingUsers;
}
