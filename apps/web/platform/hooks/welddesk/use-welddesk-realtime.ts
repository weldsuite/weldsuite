/**
 * useWeldDeskRealtime — Subscribes to ConversationRoom DO via RoomClient.
 * Dispatches incoming messages and system events over @weldsuite/realtime WebSocket.
 */

import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { RoomClient } from '@weldsuite/realtime/client';
import type { RoomEvent } from '@weldsuite/realtime/types';
import type { WeldDeskMessage, WeldDeskEvent, WeldDeskConnectionState } from './types';

const REALTIME_BASE_URL =
  import.meta.env.VITE_REALTIME_URL?.replace(/\/ws\/?$/, '') || 'ws://localhost:8790';

interface UseWeldDeskRealtimeOptions {
  conversationId: string;
  role: 'agent' | 'customer';
  onMessage: (msg: WeldDeskMessage) => void;
  onEvent: (event: WeldDeskEvent) => void;
  enabled: boolean;
}

export function useWeldDeskRealtime({
  conversationId,
  role,
  onMessage,
  onEvent,
  enabled,
}: UseWeldDeskRealtimeOptions) {
  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<WeldDeskConnectionState>('disconnected');
  const clientRef = useRef<RoomClient | null>(null);
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  // Store callbacks in refs to avoid re-subscribing
  const onMessageRef = useRef(onMessage);
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onMessageRef.current = onMessage;
    onEventRef.current = onEvent;
  });

  useEffect(() => {
    if (!conversationId || !enabled) return;

    setConnectionState('connecting');

    const client = new RoomClient({
      url: `${REALTIME_BASE_URL}/ws/conversation/${conversationId}`,
      getToken: async () => (await getTokenRef.current()) || '',
    });
    clientRef.current = client;

    // Subscribe to messages
    const unsubMessage = client.on('message', (event) => {
      const msg: WeldDeskMessage = {
        id: event.id,
        conversationId,
        content: event.content,
        htmlContent: undefined,
        authorId: event.senderId,
        authorName: event.senderName,
        authorType: (event.senderType as 'agent' | 'customer' | 'system') || 'agent',
        type: 'message',
        isInternal: false,
        isPublic: true,
        isRead: false,
        attachments: event.attachments?.map((a) => ({
          id: a.id,
          fileName: a.name,
          fileSize: a.size,
          mimeType: a.type,
          url: a.url,
        })) ?? [],
        createdAt: new Date(event.ts).toISOString(),
      };
      onMessageRef.current(msg);
    });

    // Subscribe to system events
    const unsubSystem = client.on('system', (event) => {
      const systemEvent = event as Extract<RoomEvent, { type: 'system' }>;
      onEventRef.current({
        id: `evt-${Date.now()}`,
        conversationId,
        eventType: systemEvent.event,
        initiator: 'system',
        description: systemEvent.event,
        data: systemEvent.data as Record<string, unknown>,
        isPublic: false,
        createdAt: new Date(systemEvent.ts).toISOString(),
      });
    });

    const unsubConnection = client.onConnectionChange((state) => {
      setIsConnected(state === 'connected');
      setConnectionState(state as WeldDeskConnectionState);
    });

    client.connect().then(() => {
      client.enterPresence({ role, type: 'agent' });
    }).catch((err) => {
      console.error('[useWeldDeskRealtime] Connect failed:', err);
      setConnectionState('failed');
    });

    return () => {
      unsubMessage();
      unsubSystem();
      unsubConnection();
      client.disconnect();
      clientRef.current = null;
      setIsConnected(false);
      setConnectionState('disconnected');
    };
  }, [conversationId, enabled, role]);

  return { isConnected, connectionState, clientRef };
}
