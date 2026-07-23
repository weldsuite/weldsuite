/**
 * Helpdesk WebSocket Hook — @weldsuite/realtime
 *
 * Provides workspace-level helpdesk event subscriptions (new conversations,
 * agent assignments, escalations) via WorkspaceHub topic subscriptions.
 *
 * Per-conversation real-time (messages, typing, presence) is handled by
 * useWeldDesk → useWeldDeskRealtime which connects to the ConversationRoom DO.
 * This hook is for inbox list components that need workspace-wide notifications.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';
import { useTopic } from '@weldsuite/realtime/react';

interface UseHelpdeskWebSocketOptions {
  conversationId?: string;
  widgetId?: string;
  isAgent?: boolean;
  accessToken?: string;
  workspaceId?: string;
  onMessageReceived?: (message: Helpdesk.ConversationMessage) => void;
  onTypingIndicator?: (data: { userId: string; userName: string; isTyping: boolean }) => void;
  onConversationClosed?: (data: { closedBy: string; closedAt: string; reason: string }) => void;
  onAgentAssigned?: (data: { conversationId: string; agentId: string; agentName: string; agentAvatar?: string }) => void;
  onConversationHistory?: (messages: Helpdesk.ConversationMessage[]) => void;
  onNewConversation?: (conversation: Partial<Helpdesk.Conversation>) => void;
  onConversationUpdated?: (data: { conversationId: string; fields: Record<string, unknown> }) => void;
}

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export function useHelpdeskWebSocket({
  conversationId,
  onMessageReceived,
  onTypingIndicator,
  onConversationClosed,
  onAgentAssigned,
  onNewConversation,
  onConversationUpdated,
}: UseHelpdeskWebSocketOptions) {
  const { userId } = useAuth();
  const [connectionState] = useState<ConnectionState>('connected');

  // Store callbacks in refs to prevent stale closures
  const onNewConversationRef = useRef(onNewConversation);
  const onAgentAssignedRef = useRef(onAgentAssigned);
  const onConversationClosedRef = useRef(onConversationClosed);
  const onConversationUpdatedRef = useRef(onConversationUpdated);
  const onMessageReceivedRef = useRef(onMessageReceived);

  useEffect(() => {
    onNewConversationRef.current = onNewConversation;
    onAgentAssignedRef.current = onAgentAssigned;
    onConversationClosedRef.current = onConversationClosed;
    onConversationUpdatedRef.current = onConversationUpdated;
    onMessageReceivedRef.current = onMessageReceived;
  });

  // Subscribe to workspace-level helpdesk events
  const handleHelpdeskEvent = useCallback((event: { event: string; data: any }) => {
    switch (event.event) {
      case 'conversation_new': {
        const d = event.data;
        onNewConversationRef.current?.({
          id: d.conversationId || d.id,
          subject: d.subject || 'New conversation',
          status: 'active',
          priority: d.priority || 'normal',
          channel: d.channel || 'chat',
          createdAt: d.createdAt,
          isRead: false,
          preview: d.preview || d.lastMessagePreview,
          lastMessageAt: d.createdAt,
          customerName: d.customerName,
          customerEmail: d.customerEmail,
        });
        break;
      }
      case 'message_new': {
        // Workspace-level message notification (for sidebar badge)
        // Per-conversation messages are handled by useWeldDeskRealtime
        break;
      }
      case 'conversation_escalated': {
        // Escalation notification
        break;
      }
      case 'conversation_read': {
        // Customer read messages
        break;
      }
    }
  }, []);

  useTopic('helpdesk', handleHelpdeskEvent);

  // Subscribe to agent-specific inbox events
  const handleInboxEvent = useCallback((event: { event: string; data: any }) => {
    switch (event.event) {
      case 'conversation_new': {
        const d = event.data;
        onNewConversationRef.current?.({
          id: d.id,
          subject: d.subject,
          status: d.status || 'active',
          channel: d.channel || 'chat',
          createdAt: d.createdAt,
          customerName: d.customerName,
          customerEmail: d.customerEmail,
          preview: d.preview,
        });
        break;
      }
      case 'message_new': {
        // Agent inbox message notification
        break;
      }
      case 'conversation_updated': {
        const d = event.data;
        if (d.assigneeId) {
          onAgentAssignedRef.current?.({
            conversationId: d.id,
            agentId: d.assigneeId,
            agentName: d.assigneeName || '',
          });
        }
        onConversationUpdatedRef.current?.(d);
        break;
      }
      case 'conversation_closed': {
        onConversationClosedRef.current?.({
          closedBy: 'system',
          closedAt: new Date().toISOString(),
          reason: '',
        });
        break;
      }
    }
  }, []);

  useTopic(userId ? `inbox.${userId}` : '', handleInboxEvent);

  // Deprecated methods — messages go through server action, not WebSocket
  const sendMessage = useCallback(async () => {}, []);
  const sendTypingIndicator = useCallback(async () => {}, []);
  const closeConversation = useCallback(async () => {}, []);
  const publishClosedEvent = useCallback(async () => {}, []);
  const disconnect = useCallback(() => {}, []);

  return {
    isConnected: true, // WorkspaceHub is always connected via RealtimeProvider
    isConnecting: false,
    connectionState,
    error: null,
    sendMessage,
    sendTypingIndicator,
    closeConversation,
    publishClosedEvent,
    disconnect,
  };
}
