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
import { useAuth } from '@/lib/auth';
import { RoomClient } from '@weldsuite/realtime/client';
import { realtimeSocketUrl } from '@/lib/api/realtime-url';


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
    const url = channelId ? realtimeSocketUrl(`/ws/chat/${channelId}`) : '';
    // An empty URL means realtime is off for this deployment.
    if (!url) return;

    const rc = new RoomClient({
      url,
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
