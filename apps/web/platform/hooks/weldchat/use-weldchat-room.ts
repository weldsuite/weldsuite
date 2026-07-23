/**
 * WeldChat Room Manager — @weldsuite/realtime
 *
 * Centralized room lifecycle hook. Creates a single RoomClient
 * per channel that is shared by messages, presence, and typing hooks.
 *
 * Handles React Strict Mode: each effect cycle creates a fresh client
 * so the cleanup fully tears down the previous connection. Uses a ref
 * for getToken to avoid re-running the effect when the Clerk token
 * function changes reference.
 */

import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { RoomClient } from '@weldsuite/realtime/client';

const REALTIME_BASE_URL =
  import.meta.env.VITE_REALTIME_URL?.replace(/\/ws\/?$/, '') || 'ws://localhost:8790';

export function useWeldChatRoom(channelId: string | null): {
  client: RoomClient | null;
  isConnected: boolean;
} {
  const [client, setClient] = useState<RoomClient | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  useEffect(() => {
    if (!channelId) return;

    const rc = new RoomClient({
      url: `${REALTIME_BASE_URL}/ws/chat/${channelId}`,
      getToken: async () => (await getTokenRef.current()) || '',
    });
    setClient(rc);

    const unsub = rc.onConnectionChange((state) => {
      setIsConnected(state === 'connected');
    });

    rc.connect().catch((err) => {
      console.error('[WeldChat:Room] Connect failed:', err);
    });

    return () => {
      unsub();
      rc.disconnect();
      setClient(null);
      setIsConnected(false);
    };
  }, [channelId]);

  return { client, isConnected };
}
