/**
 * Meeting Chat Room — @weldsuite/realtime
 *
 * Creates a RoomClient for meeting chat using the ChatRoom DO
 * with room key `meet_{meetingId}` to avoid collision with WeldChat.
 */

import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { RoomClient } from '@weldsuite/realtime/client';

const REALTIME_BASE_URL =
  import.meta.env.VITE_REALTIME_URL?.replace(/\/ws\/?$/, '') || 'ws://localhost:8790';

if (!import.meta.env.VITE_REALTIME_URL) {
  console.warn(
    '[weldmeet-chat] HostChat: VITE_REALTIME_URL env var is not set — falling back to ws://localhost:8790. Host will not receive live guest messages in production.',
  );
}

export function useMeetingChatRoom(meetingId: string | null): {
  client: RoomClient | null;
  isConnected: boolean;
} {
  const [client, setClient] = useState<RoomClient | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  useEffect(() => {
    if (!meetingId) return;

    const wsUrl = `${REALTIME_BASE_URL}/ws/chat/meet_${meetingId}`;
    console.info(`[weldmeet-chat] HostChat connecting: url=${wsUrl}`);

    const rc = new RoomClient({
      url: wsUrl,
      getToken: async () => (await getTokenRef.current()) || '',
    });
    setClient(rc);

    const unsub = rc.onConnectionChange((state) => {
      if (state === 'connected') {
        console.info(`[weldmeet-chat] HostChat WebSocket connected: meetingId=${meetingId}`);
      } else if (state === 'reconnecting') {
        console.warn(`[weldmeet-chat] HostChat WebSocket reconnecting: meetingId=${meetingId}`);
      } else if (state === 'disconnected') {
        console.warn(`[weldmeet-chat] HostChat WebSocket disconnected: meetingId=${meetingId}`);
      }
      setIsConnected(state === 'connected');
    });

    rc.connect().catch((err) => {
      console.error(`[weldmeet-chat] HostChat connect failed: meetingId=${meetingId} url=${wsUrl}`, err);
    });

    return () => {
      unsub();
      rc.disconnect();
      setClient(null);
      setIsConnected(false);
    };
  }, [meetingId]);

  return { client, isConnected };
}
