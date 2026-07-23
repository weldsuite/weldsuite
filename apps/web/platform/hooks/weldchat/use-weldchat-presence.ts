/**
 * WeldChat Presence Hook — @weldsuite/realtime
 *
 * Uses RoomClient presence for tracking who is online in a channel.
 */

import { useState, useEffect } from 'react';
import type { RoomClient } from '@weldsuite/realtime/client';
import type { PresenceMember } from '@weldsuite/realtime/types';

interface PresenceData {
  userId: string;
  userName?: string;
  avatar?: string;
  status: 'online' | 'away' | 'dnd' | 'offline';
}

/**
 * Track presence for a specific chat channel using the RoomClient.
 * Enters presence on connect, leaves on disconnect.
 */
export function useWeldChatPresence(client: RoomClient | null) {
  const [members, setMembers] = useState<PresenceMember[]>([]);

  useEffect(() => {
    if (!client) return;

    // Subscribe to presence changes (fires immediately with current state)
    const unsub = client.onPresence(setMembers);

    // Enter presence when connected
    if (client.isConnected) {
      client.enterPresence({ status: 'online' });
    }

    const unsubConnection = client.onConnectionChange((state) => {
      if (state === 'connected') {
        client.enterPresence({ status: 'online' });
      }
    });

    return () => {
      unsub();
      unsubConnection();
      setMembers([]);
    };
  }, [client]);

  const isOnline = (userId: string) => {
    return members.some((m) => m.userId === userId);
  };

  return { members, isOnline };
}
