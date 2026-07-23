import { useEffect, useState } from 'react';
import type { RoomClient } from '../client/room-client';
import type { PresenceMember } from '../types';

/**
 * Track presence members in a room.
 * Optionally enter presence with initial data.
 *
 * Usage:
 *   const { members } = useRoomPresence(roomClient, { name: 'John', role: 'agent' });
 */
export function useRoomPresence(
  client: RoomClient | null,
  enterData?: Record<string, unknown>,
): { members: PresenceMember[] } {
  const [members, setMembers] = useState<PresenceMember[]>([]);

  useEffect(() => {
    if (!client) return;

    if (enterData) {
      client.enterPresence(enterData);
    }

    const unsub = client.onPresence(setMembers);

    return () => {
      unsub();
      if (enterData) {
        client.leavePresence();
      }
    };
  }, [client]);

  return { members };
}
