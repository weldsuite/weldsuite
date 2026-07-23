/**
 * useHelpdeskRealtime — Replaces the legacy realtime client.
 *
 * Uses RoomClient from @weldsuite/realtime to connect to the ConversationRoom
 * Durable Object. Same interface as legacy client so consumers need minimal changes.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AppState } from 'react-native';
import { useClerkAuth } from '@/contexts/ClerkAuthContext';
import { RoomClient } from '@weldsuite/realtime/client';
import type { RoomEvent, ConnectionState as RTConnectionState } from '@weldsuite/realtime/types';

const REALTIME_URL =
  process.env.EXPO_PUBLIC_REALTIME_URL || 'ws://localhost:8790';

// Re-export compatible types so consumers don't need to change imports
export type ConnectionState = RTConnectionState;

export interface RealtimeMessage {
  id: string;
  conversationId: string;
  content: string;
  sender: 'customer' | 'agent' | 'system';
  senderId?: string;
  senderName?: string;
  senderAvatar?: string;
  timestamp: string;
  isRead?: boolean;
  attachments?: Array<{ id: string; name: string; url: string; type: string; size: number }>;
}

export interface TypingIndicator {
  conversationId: string;
  isTyping: boolean;
  userId: string;
  userName?: string;
  userType: 'customer' | 'agent';
}

export interface AgentAssigned {
  conversationId: string;
  agentId: string;
  agentName: string;
  assignedAt: string;
}

export interface ConversationClosed {
  conversationId: string;
  closedAt: string;
  status: string;
}

export interface PresenceMember {
  userId: string;
  userName?: string;
  data?: Record<string, unknown>;
}

interface UseHelpdeskRealtimeOptions {
  conversationId: string;
  agentId: string;
  agentName: string;
  agentEmail?: string;
  agentAvatar?: string;
  onMessage?: (message: RealtimeMessage) => void;
  onTyping?: (indicator: TypingIndicator) => void;
  onAgentAssigned?: (agent: AgentAssigned) => void;
  onConversationClosed?: (closed: ConversationClosed) => void;
  onConversationEscalated?: (data: Record<string, unknown>) => void;
  onPresenceChange?: (member: PresenceMember, action: 'enter' | 'leave' | 'update') => void;
  onConnectionStateChange?: (state: ConnectionState) => void;
  autoConnect?: boolean;
}

interface UseHelpdeskRealtimeReturn {
  isConnected: boolean;
  connectionState: ConnectionState;
  sendMessage: (content: string) => Promise<void>;
  sendTypingIndicator: (isTyping: boolean) => void;
  getPresenceMembers: () => Promise<PresenceMember[]>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  error: Error | null;
}

export function useHelpdeskRealtime(options: UseHelpdeskRealtimeOptions): UseHelpdeskRealtimeReturn {
  const {
    conversationId,
    agentId,
    agentName,
    agentAvatar,
    autoConnect = true,
  } = options;

  const { getToken } = useClerkAuth();
  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [error, setError] = useState<Error | null>(null);

  const clientRef = useRef<RoomClient | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);

  // Keep handlers in refs to avoid re-subscribing
  const handlersRef = useRef(options);
  useEffect(() => { handlersRef.current = options; });

  const connect = useCallback(async () => {
    try {
      setError(null);

      const token = await getToken();
      if (!token) throw new Error('Not authenticated');

      const client = new RoomClient({
        url: `${REALTIME_URL}/ws/conversation/${conversationId}`,
        getToken: async () => (await getToken()) || '',
      });
      clientRef.current = client;

      // Subscribe to messages
      client.on('message', (event: Extract<RoomEvent, { type: 'message' }>) => {
        handlersRef.current.onMessage?.({
          id: event.id,
          conversationId,
          content: event.content,
          sender: (event.senderType as 'customer' | 'agent' | 'system') || 'agent',
          senderId: event.senderId,
          senderName: event.senderName,
          timestamp: new Date(event.ts).toISOString(),
          attachments: event.attachments?.map((a) => ({
            id: a.id, name: a.name, url: a.url, type: a.type, size: a.size,
          })),
        });
      });

      // Subscribe to system events
      client.on('system', (event: Extract<RoomEvent, { type: 'system' }>) => {
        const data = (event.data || {}) as Record<string, unknown>;
        if (event.event === 'agent_assigned' || event.event === 'conversation_assigned') {
          handlersRef.current.onAgentAssigned?.({
            conversationId,
            agentId: String(data.agentId || ''),
            agentName: String(data.agentName || ''),
            assignedAt: String(data.assignedAt || new Date().toISOString()),
          });
        } else if (event.event === 'conversation_closed' || event.event === 'conversation_resolved') {
          handlersRef.current.onConversationClosed?.({
            conversationId,
            closedAt: String(data.closedAt || new Date().toISOString()),
            status: event.event === 'conversation_resolved' ? 'resolved' : 'closed',
          });
        } else if (event.event === 'conversation_escalated') {
          handlersRef.current.onConversationEscalated?.(data);
        }
      });

      // Typing indicators
      client.onTyping((users) => {
        for (const user of users) {
          handlersRef.current.onTyping?.({
            conversationId,
            isTyping: true,
            userId: user.userId,
            userName: user.userName,
            userType: 'customer',
          });
        }
        if (users.length === 0) {
          handlersRef.current.onTyping?.({
            conversationId,
            isTyping: false,
            userId: '',
            userName: '',
            userType: 'customer',
          });
        }
      });

      // Presence
      client.onPresence((members) => {
        for (const m of members) {
          handlersRef.current.onPresenceChange?.(
            { userId: m.userId, userName: m.userName, data: m.data },
            'enter',
          );
        }
      });

      // Connection state
      client.onConnectionChange((state) => {
        setConnectionState(state);
        setIsConnected(state === 'connected');
        handlersRef.current.onConnectionStateChange?.(state);
      });

      await client.connect();
      client.enterPresence({ role: 'agent', name: agentName, avatar: agentAvatar });
      setIsConnected(true);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Connection failed'));
      console.error('[useHelpdeskRealtime] Connection error:', err);
    }
  }, [conversationId, agentId, agentName, agentAvatar, getToken]);

  const disconnect = useCallback(async () => {
    clientRef.current?.disconnect();
    clientRef.current = null;
    setIsConnected(false);
  }, []);

  // Auto-connect + cleanup
  useEffect(() => {
    if (autoConnect && conversationId) {
      connect();
    }
    return () => {
      clientRef.current?.disconnect();
      clientRef.current = null;
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Handle AppState changes (background/foreground)
  useEffect(() => {
    const appStateRef = { current: AppState.currentState };
    const subscription = AppState.addEventListener('change', async (nextAppState) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextAppState;

      if (prevState === 'active' && nextAppState !== 'active') {
        clientRef.current?.disconnect();
        setIsConnected(false);
      }
      if (prevState !== 'active' && nextAppState === 'active' && conversationId) {
        connect();
      }
    });
    return () => subscription.remove();
  }, [conversationId, connect]);

  // Send message via WebSocket
  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || !clientRef.current) return;
    clientRef.current.sendMessage(content);
  }, []);

  // Typing indicator with debounce
  const sendTypingIndicator = useCallback((isTyping: boolean) => {
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    if (isTypingRef.current === isTyping && !isTyping) return;

    isTypingRef.current = isTyping;
    if (isTyping) {
      clientRef.current?.startTyping();
      typingTimeoutRef.current = setTimeout(() => {
        isTypingRef.current = false;
        clientRef.current?.stopTyping();
      }, 2000);
    } else {
      clientRef.current?.stopTyping();
    }
  }, []);

  const getPresenceMembers = useCallback(async (): Promise<PresenceMember[]> => {
    return clientRef.current?.getPresence?.() || [];
  }, []);

  return {
    isConnected,
    connectionState,
    sendMessage,
    sendTypingIndicator,
    getPresenceMembers,
    connect,
    disconnect,
    error,
  };
}
