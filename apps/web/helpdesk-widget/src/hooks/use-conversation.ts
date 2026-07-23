/**
 * useConversation — Core conversation hook for the helpdesk widget.
 *
 * Architecture (DB-first):
 *   Neon DB is the single source of truth for all messages.
 *   Messages are loaded from DB on open, and incrementally refetched when:
 *   1. A "refetch" hint arrives via RoomClient WebSocket
 *   2. Fallback poll every 10 seconds (catches missed hints)
 *
 *   Customer messages are still added optimistically for instant feedback,
 *   then confirmed with the real DB ID.
 *
 *   The RoomClient WebSocket is used ONLY for:
 *   - Refetch hints (lightweight "new data available" signals)
 *   - Typing indicators
 *   NOT for message content delivery.
 *
 * Composes: useMessages + RoomClient hints + DB polling.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useMessages } from './use-messages';
import { platformApi } from '@/lib/api/client';
import { RoomClient } from '@weldsuite/realtime/client';
import type { RoomEvent } from '@weldsuite/realtime/types';
import {
  addConversationId,
  getMostRecentConversationId,
  setLastSeenMessageId,
} from '@/lib/utils/conversation-storage';
import { getOrCreateVisitorId, getOrCreateVisitorName } from '@/lib/utils/customer-storage';
import { playMessageReceivedSound, playMessageSentSound } from '@/lib/utils/notification-sound';
import { fetchConversationMessages } from '@/lib/api/conversations';
import type { Message, MessageAttachment } from '@/lib/api/types';

const DEFAULT_REALTIME_URL = import.meta.env.VITE_WIDGET_REALTIME_URL || '';

// ============================================================================
// Types
// ============================================================================

interface UseConversationOptions {
  widgetId: string;
  customerId?: string | null;
  customerName?: string;
  customerEmail?: string;
  realtimeUrl?: string;
  onConversationCreated?: (conversationId: string) => void;
  onUnreadCountChange?: (count: number) => void;
}

interface TypingState {
  isTyping: boolean;
  agent?: { name: string; avatar?: string; isBot: boolean } | null;
}

interface ConversationReturn {
  conversationId: string | null;
  messages: Message[];
  isLoading: boolean;
  isConnected: boolean;
  isClosed: boolean;
  isCreating: boolean;
  typing: TypingState;
  startTyping: () => void;
  stopTyping: () => void;
  send: (content: string, attachments?: Array<{ file: File; name: string }>) => Promise<void>;
  respondToChoice: (messageId: string, optionId: string, value: string) => Promise<void>;
  respondToInput: (messageId: string, data: Record<string, string>) => Promise<void>;
  respondToCsat: (messageId: string, rating: number, feedback?: string) => Promise<void>;
  createConversation: (opts?: {
    initialMessage?: string;
    welcomeMessages?: unknown[];
    customerEmail?: string;
    customerName?: string;
  }) => Promise<string | null>;
  setConversationId: (id: string | null) => void;
  streamingMessage: { id: string; content: string; agentName: string } | null;
  assignedAgent: { id: string; name: string; avatar?: string } | null;
  unreadCount: number;
  resetUnreadCount: () => void;
  triggerWorkflow: (trigger: string, data?: Record<string, unknown>, explicitConvId?: string) => Promise<void>;
}

// ============================================================================
// Hook
// ============================================================================

export function useConversation(
  initialConversationId: string | null,
  options: UseConversationOptions,
): ConversationReturn {
  const {
    widgetId,
    customerId,
    customerName,
    customerEmail,
    realtimeUrl = DEFAULT_REALTIME_URL,
    onConversationCreated,
    onUnreadCountChange,
  } = options;

  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const [isClosed, setIsClosed] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [assignedAgent, setAssignedAgent] = useState<ConversationReturn['assignedAgent']>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [streamingMessage, setStreamingMessage] = useState<ConversationReturn['streamingMessage']>(null);

  // Typing state
  const [isAgentTyping, setIsAgentTyping] = useState(false);
  const [typingAgent, setTypingAgent] = useState<TypingState['agent']>(null);

  // Prevent duplicate creation
  const creatingRef = useRef(false);
  // Skip DB load when messages were already loaded from creation response
  const hasLoadedFromCreateRef = useRef(false);

  // Track active RoomClient instance
  const clientRef = useRef<RoomClient | null>(null);

  // Messages
  const {
    messages,
    addMessage,
    addOptimistic,
    confirmMessage,
    removeMessage,
    markFailed,
    updateMessage,
    setStreaming,
    appendContent,
    finalizeStreaming,
    loadMessages,
    clearMessages,
  } = useMessages();

  // ==========================================================================
  // Incremental DB refetch — called on WS hint or fallback poll
  // ==========================================================================

  const lastFetchTimestampRef = useRef<string | null>(null);
  const refetchInProgressRef = useRef(false);

  const refetchMessages = useCallback(async () => {
    if (!conversationId || refetchInProgressRef.current) return;
    refetchInProgressRef.current = true;

    try {
      const after = lastFetchTimestampRef.current;
      const result = await fetchConversationMessages(
        conversationId,
        widgetId,
        after || undefined,
      );

      if (result?.success && result.messages && result.messages.length > 0) {
        let newAgentMessages = 0;

        for (const m of result.messages) {
          // Skip customer messages — already added optimistically
          if (m.sender === 'user') continue;
          addMessage(m);
          newAgentMessages++;
        }

        // Update cursor to latest message timestamp
        const latest = result.messages[result.messages.length - 1];
        if (latest?.timestamp) {
          lastFetchTimestampRef.current = new Date(latest.timestamp).toISOString();
        }

        // Update unread count and notify parent SDK (launcher badge)
        if (newAgentMessages > 0) {
          setUnreadCount((prev) => {
            const next = prev + newAgentMessages;
            try {
              window.parent?.postMessage({ type: 'weld:unread-count', count: next }, '*');
            } catch { /* cross-origin or not embedded */ }
            return next;
          });
          playMessageReceivedSound();
        }
      }
    } catch {
      // Silently fail — next poll will retry
    } finally {
      refetchInProgressRef.current = false;
    }
  }, [conversationId, widgetId, addMessage]);

  // ==========================================================================
  // RoomClient — refetch hints + typing indicators only
  // ==========================================================================

  useEffect(() => {
    if (!conversationId || !realtimeUrl) return;

    const visitorId = customerId || getOrCreateVisitorId();
    const visitorName = customerName || getOrCreateVisitorName() || 'Customer';
    const wsUrl = `${realtimeUrl}/ws/conversation/${conversationId}?customerId=${encodeURIComponent(visitorId)}&customerName=${encodeURIComponent(visitorName)}`;

    const client = new RoomClient({
      url: wsUrl,
      getToken: async () => platformApi.getRealtimeToken(visitorId, conversationId),
    });
    clientRef.current = client;

    // On any message/system/refetch event from the room → refetch from DB
    const offMessage = client.on('message', () => {
      refetchMessages();
    });

    const offSystem = client.on('system', (event: Extract<RoomEvent, { type: 'system' }>) => {
      const systemEvent = event.event;

      // Update local UI state for immediate feedback
      if (systemEvent === 'conversation_resolved' || systemEvent === 'conversation_closed') {
        setIsClosed(true);
      }

      // Refetch to get any system messages persisted to DB
      refetchMessages();
    });

    // Typing indicators (keep as-is — not DB-backed)
    const offTyping = client.onTyping((users) => {
      if (users.length > 0) {
        const user = users[0];
        setIsAgentTyping(true);
        setTypingAgent({ name: user.userName || 'Agent', isBot: false });
      } else {
        setIsAgentTyping(false);
        setTypingAgent(null);
      }
    });

    // AI streaming tokens (optional UX enhancement — DB message replaces on refetch)
    const offAiToken = client.on('ai:token', (event: Extract<RoomEvent, { type: 'ai:token' }>) => {
      const streamId = `streaming-${event.messageId}`;

      if (!messages.find((m) => m.id === streamId)) {
        addMessage({
          id: streamId,
          conversationId: conversationId!,
          content: '',
          sender: 'agent',
          senderName: 'AI Agent',
          timestamp: new Date(),
          metadata: { isStreaming: true, streamMessageId: event.messageId },
        });
        setIsAgentTyping(false);
        setTypingAgent(null);
      }

      setStreaming(streamId, event.token);
      setStreamingMessage({ id: event.messageId, content: event.token, agentName: 'AI Agent' });
    });

    const offAiComplete = client.on('ai:complete', (event: Extract<RoomEvent, { type: 'ai:complete' }>) => {
      // Finalize streaming phantom, then refetch the real DB message
      const streamId = `streaming-${event.messageId}`;
      finalizeStreaming(streamId, event.messageId, event.content);
      setStreamingMessage(null);
      refetchMessages();
    });

    const offConnection = client.onConnectionChange((state) => {
      setIsConnected(state === 'connected');
      // On reconnect, refetch to catch any messages missed during disconnect
      if (state === 'connected') {
        refetchMessages();
      }
    });

    client.connect().catch((err) => {
      console.error('[useConversation] RoomClient connection failed:', err);
    });

    // Fallback poll every 10s — catches any missed WS hints
    const pollInterval = setInterval(() => {
      refetchMessages();
    }, 10_000);

    return () => {
      offMessage();
      offSystem();
      offTyping();
      offAiToken();
      offAiComplete();
      offConnection();
      clearInterval(pollInterval);
      client.disconnect();
      clientRef.current = null;
      setIsConnected(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only reconnect when conversation or URL changes
  }, [conversationId, realtimeUrl]);

  // ==========================================================================
  // Load messages from DB (full load on open/reopen, sets cursor for incremental)
  // ==========================================================================

  useEffect(() => {
    if (!conversationId) {
      clearMessages();
      lastFetchTimestampRef.current = null;
      return;
    }

    // Skip DB load if messages were already loaded from the creation response
    if (hasLoadedFromCreateRef.current) {
      hasLoadedFromCreateRef.current = false;
      return;
    }

    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      try {
        const result = await fetchConversationMessages(conversationId, widgetId);
        if (!cancelled && result?.success && result.messages) {
          loadMessages(result.messages);

          // Set cursor to the latest message for incremental fetching
          if (result.messages.length > 0) {
            const latest = result.messages[result.messages.length - 1];
            if (latest?.timestamp) {
              lastFetchTimestampRef.current = new Date(latest.timestamp).toISOString();
            }
          }
        }
      } catch {
        // Silently fail — fallback poll will retry
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    load();

    return () => { cancelled = true; };
  }, [conversationId, widgetId, loadMessages, clearMessages]);

  // ==========================================================================
  // Create conversation
  // ==========================================================================

  const createConversation = useCallback(async (opts?: {
    initialMessage?: string;
    welcomeMessages?: unknown[];
    customerEmail?: string;
    customerName?: string;
  }): Promise<string | null> => {
    if (creatingRef.current || conversationId) return conversationId;
    creatingRef.current = true;
    setIsCreating(true);

    try {
      const visitorId = getOrCreateVisitorId();
      const result = await platformApi.createConversation({
        widgetId,
        customerName: opts?.customerName || customerName || getOrCreateVisitorName(),
        customerEmail: opts?.customerEmail || customerEmail || undefined,
        visitorId,
        initialMessage: opts?.initialMessage,
        welcomeMessages: opts?.welcomeMessages as never,
        website: typeof window !== 'undefined' ? window.location.href : undefined,
      });

      if (result.success && result.conversation) {
        const newId = result.conversation.id;

        // Load persisted welcome messages from creation response immediately.
        // This replaces the client-side welcome previews with real DB-backed messages.
        if (result.messages && result.messages.length > 0) {
          const msgs: Message[] = result.messages.map((m: any) => ({
            id: m.id,
            conversationId: m.conversationId || newId,
            content: m.content || '',
            sender: m.authorType === 'customer' ? 'user' as const : 'agent' as const,
            senderName: m.authorName,
            timestamp: new Date(m.createdAt),
            metadata: m.metadata,
          }));
          loadMessages(msgs);
          hasLoadedFromCreateRef.current = true;
        }

        addConversationId(widgetId, newId);

        // RoomClient will connect automatically when conversationId changes
        // (the subscription effect handles connection lifecycle)

        setConversationId(newId);
        onConversationCreated?.(newId);
        return newId;
      }
      return null;
    } catch (err) {
      console.error('[useConversation] Failed to create conversation:', err);
      return null;
    } finally {
      setIsCreating(false);
      creatingRef.current = false;
    }
  }, [conversationId, widgetId, customerName, customerEmail, onConversationCreated, loadMessages]);

  // ==========================================================================
  // Typing indicators (published via RoomClient WebSocket)
  // ==========================================================================

  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startTyping = useCallback(() => {
    if (!clientRef.current) return;

    clientRef.current.startTyping();

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      // Typing auto-stops (RoomClient uses heartbeat, absence = stopped)
      typingTimeoutRef.current = null;
    }, 5000);
  }, []);

  const stopTyping = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.stopTyping();
    }
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
  }, []);

  // ==========================================================================
  // Trigger workflow (fire-and-forget)
  // ==========================================================================

  const triggerWorkflow = useCallback(async (trigger: string, data?: Record<string, unknown>, explicitConvId?: string) => {
    const convId = explicitConvId || conversationId;
    if (!convId) return;

    try {
      await platformApi.triggerWorkflow(convId, trigger, data, (event, eventData) => {
        if (event === 'step:ai_typing') {
          setStreamingMessage({
            id: String(eventData.messageId || ''),
            content: '',
            agentName: String(eventData.agentName || 'AI'),
          });
        } else if (event === 'step:ai_token') {
          setStreamingMessage((prev) => prev ? { ...prev, content: String(eventData.content || '') } : null);
        } else if (event === 'step:ai_complete') {
          setStreamingMessage(null);
          // AI message is persisted to DB — refetch will pick it up
          refetchMessages();
        } else if (event === 'done') {
          refetchMessages();
        }
      });
    } catch (err) {
      console.error('[useConversation] Failed to trigger workflow:', err);
    }
  }, [conversationId, refetchMessages]);

  // ==========================================================================
  // Send message
  // ==========================================================================

  const send = useCallback(async (content: string, attachments?: Array<{ file: File; name: string }>) => {
    if (!content.trim() && (!attachments || attachments.length === 0)) return;

    // Create conversation if needed
    let activeConvId = conversationId;
    if (!activeConvId) {
      activeConvId = await createConversation();
      if (!activeConvId) return;
    }

    // Upload attachments
    let uploadedAttachments: MessageAttachment[] | undefined;
    if (attachments && attachments.length > 0) {
      uploadedAttachments = [];
      for (const att of attachments) {
        const result = await platformApi.uploadAttachment(att.file, activeConvId);
        if (result.success && result.attachment) {
          uploadedAttachments.push(result.attachment);
        }
      }
    }

    // Optimistic message
    const tempId = `temp-${Date.now()}`;
    const authorName = customerName || getOrCreateVisitorName();
    addOptimistic({
      id: tempId,
      conversationId: activeConvId,
      content,
      sender: 'user',
      senderName: authorName,
      timestamp: new Date(),
      attachments: uploadedAttachments?.map((a) => ({
        id: a.id,
        name: a.fileName,
        url: a.url,
        mimeType: a.mimeType,
        fileSize: a.fileSize,
      })),
    });
    playMessageSentSound();

    try {
      const result = await platformApi.sendMessage(activeConvId, {
        content,
        authorName,
        authorEmail: customerEmail,
        attachments: uploadedAttachments,
      });

      if (result.success && result.message) {
        // Replace optimistic with real
        confirmMessage(tempId, {
          id: result.message.id,
          conversationId: activeConvId,
          content: result.message.content,
          sender: 'user',
          senderName: result.message.authorName,
          timestamp: new Date(result.message.createdAt),
        });

        // Trigger message-received workflow (fire-and-forget)
        // Bot responses will be persisted to DB by the workflow worker,
        // then picked up via refetch hint or fallback poll
        triggerWorkflow('message_received', {
          messageContent: content,
          customerName: authorName,
          customerEmail,
        }, activeConvId);
      } else {
        markFailed(tempId);
      }
    } catch {
      markFailed(tempId);
    }
  }, [conversationId, createConversation, customerName, customerEmail, addOptimistic, confirmMessage, markFailed, triggerWorkflow]);

  // ==========================================================================
  // Interactive responses (choices, forms, CSAT)
  // ==========================================================================

  const respondToChoice = useCallback(async (messageId: string, optionId: string, value: string) => {
    const msg = messages.find((m) => m.id === messageId);
    const options = (msg?.metadata?.options as Array<{ id: string; label: string; value: string }>) || [];
    const selected = options.find((o) => o.id === optionId);

    // Mark choice as selected
    updateMessage(messageId, {
      metadata: {
        ...(msg?.metadata || {}),
        selectedOptionId: optionId,
        respondedAt: new Date().toISOString(),
      },
    });

    // Show customer's choice as a visible message
    if (selected) {
      addMessage({
        id: `choice-${Date.now()}`,
        conversationId: conversationId || '',
        content: selected.label,
        sender: 'user',
        senderName: customerName || 'Customer',
        timestamp: new Date(),
      });
    }

    try {
      await platformApi.respondToMessage(messageId, { type: 'choice', optionId, value });

      // Resume workflow — bot response will be persisted to DB, picked up via refetch
      const executionId = msg?.metadata?.workflowExecutionId as string | undefined;
      if (executionId && conversationId) {
        triggerWorkflow('resume', {
          executionId,
          stepId: msg?.metadata?.workflowStepId as string || messageId,
          selectedValue: value,
        });
      }
    } catch (err) {
      console.error('[useConversation] Failed to respond to choice:', err);
    }
  }, [messages, conversationId, customerName, updateMessage, addMessage, triggerWorkflow]);

  const respondToInput = useCallback(async (messageId: string, data: Record<string, string>) => {
    const msg = messages.find((m) => m.id === messageId);

    // Mark form as submitted
    updateMessage(messageId, {
      metadata: {
        ...(msg?.metadata || {}),
        submittedData: data,
        respondedAt: new Date().toISOString(),
      },
    });

    try {
      await platformApi.respondToMessage(messageId, { type: 'input', data });

      // Resume workflow
      const executionId = msg?.metadata?.workflowExecutionId as string | undefined;
      if (executionId && conversationId) {
        triggerWorkflow('resume', {
          executionId,
          stepId: msg?.metadata?.workflowStepId as string || messageId,
          submittedData: data,
        });
      }
    } catch (err) {
      console.error('[useConversation] Failed to respond to input:', err);
    }
  }, [messages, conversationId, updateMessage, triggerWorkflow]);

  const respondToCsat = useCallback(async (messageId: string, rating: number, feedback?: string) => {
    updateMessage(messageId, {
      metadata: {
        ...(messages.find(m => m.id === messageId)?.metadata || {}),
        submittedRating: rating,
        submittedFeedback: feedback,
        respondedAt: new Date().toISOString(),
      },
    });

    try {
      await platformApi.respondToMessage(messageId, { type: 'csat', rating, feedback });
    } catch (err) {
      console.error('[useConversation] Failed to respond to CSAT:', err);
    }
  }, [messages, updateMessage]);

  // ==========================================================================
  // Return
  // ==========================================================================

  return {
    conversationId,
    messages,
    isLoading,
    isConnected,
    isClosed,
    isCreating,
    typing: { isTyping: isAgentTyping, agent: typingAgent },
    startTyping,
    stopTyping,
    send,
    respondToChoice,
    respondToInput,
    respondToCsat,
    createConversation,
    setConversationId,
    streamingMessage,
    assignedAgent,
    unreadCount,
    resetUnreadCount: useCallback(() => {
      setUnreadCount(0);
      try {
        window.parent?.postMessage({ type: 'weld:unread-count', count: 0 }, '*');
      } catch { /* cross-origin or not embedded */ }
    }, []),
    triggerWorkflow,
  };
}
