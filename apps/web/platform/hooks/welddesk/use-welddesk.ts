/**
 * useWeldDesk — Main composition hook for WeldDesk conversations.
 *
 * Provides a clean DX for both agent and customer roles:
 *   const { messages, sendMessage, typing, events, ... } = useWeldDesk({ conversationId, ... });
 *
 * Internally composes:
 *   - useWeldDeskMessages (TanStack Query + optimistic mutations)
 *   - useWeldDeskRealtime (@weldsuite/realtime WebSocket room subscription)
 *   - useWeldDeskTyping (typing indicators via RoomClient)
 *   - useWeldDeskPresence (presence tracking via RoomClient)
 *   - useWeldDeskConversation (TanStack Query for metadata)
 */

import { useState, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type {
  WeldDeskMessage,
  WeldDeskEvent,
  WeldDeskTypingState,
  WeldDeskPresenceMember,
  WeldDeskConnectionState,
  SendMessageParams,
} from './types';
import { useWeldDeskMessages } from './use-welddesk-messages';
import { useWeldDeskRealtime } from './use-welddesk-realtime';
import { useWeldDeskTyping } from './use-welddesk-typing';
import { useWeldDeskPresence } from './use-welddesk-presence';
import { useWeldDeskConversation } from './use-welddesk-conversation';
import { weldDeskKeys } from './keys';
import * as api from './api';
import type { WeldDeskConversation, ConversationUpdate } from './api';

// --------------------------------------------------------------------------
// Options & Return types
// --------------------------------------------------------------------------

export interface UseWeldDeskOptions {
  conversationId: string;
  role: 'agent' | 'customer';
  userId: string;
  userName?: string;
  userAvatar?: string;
  workspaceId?: string;
  enableTyping?: boolean;
  enablePresence?: boolean;
}

export interface UseWeldDeskReturn {
  // Messages
  messages: WeldDeskMessage[];
  isLoadingMessages: boolean;

  // Send
  sendMessage: (params: SendMessageParams) => Promise<WeldDeskMessage>;
  sendNote: (params: SendMessageParams) => Promise<WeldDeskMessage>;
  isSending: boolean;

  // Block responses
  respondToBlock: (messageId: string, actionId: string, value: unknown) => Promise<void>;

  // Conversation
  conversation: WeldDeskConversation | null;
  isLoadingConversation: boolean;
  updateConversation: (fields: Partial<ConversationUpdate>) => Promise<void>;
  closeConversation: (reason?: string) => Promise<void>;
  reopenConversation: () => Promise<void>;

  // Typing
  typing: WeldDeskTypingState;
  startTyping: () => void;
  stopTyping: () => void;

  // Presence
  presence: WeldDeskPresenceMember[];

  // Events
  events: WeldDeskEvent[];
  isLoadingEvents: boolean;

  // Connection
  isConnected: boolean;
  connectionState: WeldDeskConnectionState;
}

// --------------------------------------------------------------------------
// Hook
// --------------------------------------------------------------------------

export function useWeldDesk(options: UseWeldDeskOptions): UseWeldDeskReturn {
  const {
    conversationId,
    role,
    userId,
    userName,
    enableTyping = true,
    enablePresence = true,
  } = options;

  // app-api client, threaded into `./api` + useWeldDeskMessages /
  // useWeldDeskConversation. W5b ported the conversation-messages and events
  // surface (`GET|POST /conversations/:id/messages`, `GET /:id/events`,
  // `PATCH /:id/messages/:messageId/respond`), so this whole composition now
  // runs on app-api.
  const { getClient } = useAppApiClient();

  // Events accumulator (last 100 events in local state from real-time)
  const [realtimeEvents, setRealtimeEvents] = useState<WeldDeskEvent[]>([]);
  const addEvent = useCallback((event: WeldDeskEvent) => {
    setRealtimeEvents((prev) => [...prev.slice(-99), event]);
  }, []);

  // 1. Messages (TanStack Query + mutations)
  const {
    messages,
    isLoadingMessages,
    sendMutation,
    mergeMessage,
    updateMessageInCache,
  } = useWeldDeskMessages({
    conversationId,
    role,
    userId,
    userName,
    getClient,
  });

  // 2. Conversation metadata
  const {
    conversation,
    isLoadingConversation,
    updateConversation,
    closeConversation,
    reopenConversation,
    patchConversation,
    invalidateConversation,
  } = useWeldDeskConversation({
    conversationId,
    getClient,
  });

  // 3. Events from DB
  const eventsQuery = useQuery({
    queryKey: weldDeskKeys.events(conversationId),
    queryFn: async () => {
      const client = await getClient();
      return api.fetchEvents(client, conversationId);
    },
    staleTime: 60_000,
    enabled: !!conversationId,
  });

  // 4. Real-time subscription
  const { isConnected, connectionState, clientRef } = useWeldDeskRealtime({
    conversationId,
    role,
    onMessage: mergeMessage,
    onEvent: (event) => {
      addEvent(event);
      // Update conversation cache based on event type
      if (event.eventType === 'conversation_closed' || event.eventType === 'conversation.closed') {
        patchConversation({ status: 'closed' });
      } else if (event.eventType === 'conversation_reopened' || event.eventType === 'conversation.reopened') {
        patchConversation({ status: 'active' });
      } else if (
        event.eventType === 'agent_assigned' ||
        event.eventType === 'assignment.agent_assigned'
      ) {
        invalidateConversation();
      }
    },
    enabled: !!conversationId,
  });

  // 5. Typing
  const { typing, startTyping, stopTyping } = useWeldDeskTyping({
    conversationId,
    client: clientRef.current,
    agentName: userName,
    enabled: enableTyping && !!conversationId,
  });

  // 6. Presence
  const { presence } = useWeldDeskPresence({
    conversationId,
    client: clientRef.current,
    role,
    userId,
    userName,
    enabled: enablePresence && !!conversationId,
  });

  // --------------------------------------------------------------------------
  // Public methods
  // --------------------------------------------------------------------------

  const sendMessage = useCallback(
    async (params: SendMessageParams) => {
      return sendMutation.mutateAsync(params);
    },
    [sendMutation],
  );

  const sendNote = useCallback(
    async (params: SendMessageParams) => {
      if (role !== 'agent') throw new Error('Only agents can send notes');
      return sendMutation.mutateAsync({ ...params, isInternal: true });
    },
    [role, sendMutation],
  );

  const respondToBlock = useCallback(
    async (messageId: string, actionId: string, value: unknown) => {
      const client = await getClient();
      await api.respondToBlock(client, conversationId, messageId, actionId, value);

      // Optimistically update the message in cache
      updateMessageInCache(messageId, {
        blockResponses: {
          ...(messages.find((m) => m.id === messageId)?.blockResponses || {}),
          [actionId]: {
            actionId,
            type: 'button',
            value: value as { selectedIds: string[]; selectedValues: string[] },
            respondedAt: new Date().toISOString(),
            respondedBy: userId,
          },
        },
      });
    },
    [getClient, conversationId, updateMessageInCache, messages, userId],
  );

  // Merge DB events + real-time events (memoized to avoid unnecessary re-renders)
  const dbEvents = eventsQuery.data;
  const allEvents = useMemo(() => [
    ...(dbEvents ?? []),
    ...realtimeEvents.filter(
      (rt) => !(dbEvents ?? []).some((db) => db.id === rt.id),
    ),
  ], [dbEvents, realtimeEvents]);

  return {
    messages,
    isLoadingMessages,
    sendMessage,
    sendNote,
    isSending: sendMutation.isPending,
    respondToBlock,
    conversation,
    isLoadingConversation,
    updateConversation,
    closeConversation,
    reopenConversation,
    typing,
    startTyping,
    stopTyping,
    presence,
    events: allEvents,
    isLoadingEvents: eventsQuery.isLoading,
    isConnected,
    connectionState,
  };
}
