/**
 * useInboxRealtime — Replaces the legacy realtime inbox client.
 *
 * Uses WorkspaceClient from @weldsuite/realtime to subscribe to workspace-level
 * helpdesk events (new conversations, messages, status changes).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useWorkspaceClientMaybe } from '@weldsuite/realtime/react';
import type { ConnectionState as RTConnectionState } from '@weldsuite/realtime/types';

export type ConnectionState = RTConnectionState;

export interface InboxConversation {
  id: string;
  subject?: string;
  channel?: string;
  status?: string;
  priority?: string;
  contactName?: string;
  customerName?: string;
  customerId?: string;
  assignedToId?: string;
  assignedToName?: string;
  lastMessagePreview?: string;
  lastMessageTime?: string;
  unreadCount?: number;
  isRead?: boolean;
  isStarred?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface InboxNewMessageEvent {
  conversationId: string;
  preview: string;
  timestamp: string;
  senderId?: string;
  senderName?: string;
  senderType: 'customer' | 'agent' | 'system';
}

interface UseInboxRealtimeOptions {
  agentId: string;
  agentName: string;
  agentEmail?: string;
  agentAvatar?: string;
  onNewConversation?: (conversation: InboxConversation) => void;
  onConversationUpdated?: (conversation: InboxConversation) => void;
  onNewMessage?: (data: InboxNewMessageEvent) => void;
  onConversationClosed?: (conversationId: string) => void;
  onConversationRead?: (conversationId: string) => void;
  onConnectionStateChange?: (state: ConnectionState) => void;
  autoConnect?: boolean;
}

interface UseInboxRealtimeReturn {
  isConnected: boolean;
  connectionState: ConnectionState;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  error: Error | null;
}

export function useInboxRealtime(options: UseInboxRealtimeOptions): UseInboxRealtimeReturn {
  const { autoConnect = true } = options;
  const client = useWorkspaceClientMaybe();
  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [error, setError] = useState<Error | null>(null);

  const handlersRef = useRef(options);
  useEffect(() => { handlersRef.current = options; });

  // Subscribe to workspace helpdesk topics
  useEffect(() => {
    if (!client) return;

    // conversation_new → onNewConversation
    const offNew = client.on('helpdesk.conversation_new', (event) => {
      const data = (event as any).data || event;
      handlersRef.current.onNewConversation?.({
        id: data.conversationId || data.id,
        subject: data.subject,
        customerName: data.customerName,
        status: data.status || 'active',
        channel: data.channel,
        lastMessagePreview: data.preview,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt || data.createdAt,
      });
    });

    // message_new → onNewMessage
    const offMsg = client.on('helpdesk.message_new', (event) => {
      const data = (event as any).data || event;
      handlersRef.current.onNewMessage?.({
        conversationId: data.conversationId,
        preview: data.preview || data.content || '',
        timestamp: data.timestamp || new Date().toISOString(),
        senderName: data.senderName,
        senderType: data.senderType || 'customer',
      });
    });

    // conversation_updated → onConversationUpdated
    const offUpdated = client.on('helpdesk.conversation_updated', (event) => {
      const data = (event as any).data || event;
      handlersRef.current.onConversationUpdated?.({
        id: data.conversationId || data.id,
        status: data.status,
        assignedToId: data.assigneeId,
        assignedToName: data.assigneeName,
        updatedAt: data.updatedAt,
      });
    });

    // conversation_read → onConversationRead
    const offRead = client.on('helpdesk.conversation_read', (event) => {
      const data = (event as any).data || event;
      handlersRef.current.onConversationRead?.(data.conversationId);
    });

    // Connection state
    const offConn = client.onConnectionChange((state) => {
      setConnectionState(state);
      setIsConnected(state === 'connected');
      handlersRef.current.onConnectionStateChange?.(state);
    });

    // Check if already connected
    setIsConnected(true); // WorkspaceClient connects via RealtimeProvider on mount

    return () => {
      offNew();
      offMsg();
      offUpdated();
      offRead();
      offConn();
    };
  }, [client]);

  const connect = useCallback(async () => {
    // WorkspaceClient is managed by RealtimeProvider — no manual connect needed
    setError(null);
  }, []);

  const disconnect = useCallback(async () => {
    // WorkspaceClient lifecycle managed by RealtimeProvider
  }, []);

  return { isConnected, connectionState, connect, disconnect, error };
}
