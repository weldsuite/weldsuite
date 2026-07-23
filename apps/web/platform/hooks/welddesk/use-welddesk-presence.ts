/**
 * useWeldDeskPresence — Conversation presence tracking via RoomClient.
 *
 * Tracks who is viewing a conversation (agents and customers).
 */

import { useState, useEffect } from 'react';
import type { RoomClient } from '@weldsuite/realtime/client';
import type { PresenceMember } from '@weldsuite/realtime/types';
import type { WeldDeskPresenceMember } from './types';

interface UseWeldDeskPresenceOptions {
  conversationId: string;
  client: RoomClient | null;
  role: 'agent' | 'customer';
  userId: string;
  userName?: string;
  enabled: boolean;
}

export function useWeldDeskPresence({
  client,
  role,
  userId,
  userName,
  enabled,
}: UseWeldDeskPresenceOptions): {
  presence: WeldDeskPresenceMember[];
} {
  const [presence, setPresence] = useState<WeldDeskPresenceMember[]>([]);

  useEffect(() => {
    if (!client || !enabled) return;

    const unsub = client.onPresence((members: PresenceMember[]) => {
      setPresence(
        members.map((m) => ({
          userId: m.userId,
          userName: m.userName,
          userType: (m.data?.role as 'agent' | 'customer') || (m.data?.type as 'agent' | 'customer') || 'agent',
          isOnline: true,
          data: m.data,
        })),
      );
    });

    // Enter presence if connected
    if (client.isConnected) {
      client.enterPresence({ role, type: role, userId, userName });
    }

    const unsubConnection = client.onConnectionChange((state) => {
      if (state === 'connected') {
        client.enterPresence({ role, type: role, userId, userName });
      }
    });

    return () => {
      unsub();
      unsubConnection();
      setPresence([]);
    };
  }, [client, enabled, role, userId, userName]);

  return { presence };
}
