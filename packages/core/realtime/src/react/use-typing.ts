import { useCallback, useEffect, useState } from 'react';
import type { RoomClient } from '../client/room-client';
import type { TypingUser } from '../types';

/**
 * Track typing indicators in a room.
 *
 * Usage:
 *   const { typingUsers, startTyping, stopTyping } = useRoomTyping(roomClient);
 */
export function useRoomTyping(client: RoomClient | null): {
  typingUsers: TypingUser[];
  startTyping: () => void;
  stopTyping: () => void;
} {
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);

  useEffect(() => {
    if (!client) return;
    return client.onTyping(setTypingUsers);
  }, [client]);

  const startTyping = useCallback(() => client?.startTyping(), [client]);
  const stopTyping = useCallback(() => client?.stopTyping(), [client]);

  return { typingUsers, startTyping, stopTyping };
}
