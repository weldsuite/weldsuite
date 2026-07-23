/**
 * useWeldDeskTyping — Typing indicators via RoomClient.
 *
 * Subscribes: RoomClient.onTyping() (receives from both widget and platform)
 * Publishes: RoomClient.startTyping() / stopTyping()
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { RoomClient } from '@weldsuite/realtime/client';
import type { WeldDeskTypingState, WeldDeskTypingUser } from './types';

interface UseWeldDeskTypingOptions {
  conversationId: string;
  client: RoomClient | null;
  agentName?: string;
  enabled: boolean;
}

export function useWeldDeskTyping({
  conversationId,
  client,
  agentName,
  enabled,
}: UseWeldDeskTypingOptions): {
  typing: WeldDeskTypingState;
  startTyping: () => void;
  stopTyping: () => void;
} {
  const [typingUsers, setTypingUsers] = useState<WeldDeskTypingUser[]>([]);
  const clientRef = useRef(client);
  clientRef.current = client;

  useEffect(() => {
    if (!client || !enabled) return;

    const unsub = client.onTyping((users) => {
      setTypingUsers(
        users.map((u) => ({
          userId: u.userId,
          userName: u.userName || u.userId,
          userType: u.userId.startsWith('customer:') ? 'customer' as const : 'agent' as const,
        })),
      );
    });

    return () => {
      unsub();
      setTypingUsers([]);
    };
  }, [client, enabled]);

  const startTyping = useCallback(() => {
    clientRef.current?.startTyping();
  }, []);

  const stopTyping = useCallback(() => {
    clientRef.current?.stopTyping();
  }, []);

  return {
    typing: {
      isTyping: typingUsers.length > 0,
      typingUsers,
    },
    startTyping,
    stopTyping,
  };
}
