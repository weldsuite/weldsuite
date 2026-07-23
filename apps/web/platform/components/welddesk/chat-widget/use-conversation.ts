
import { useState, useCallback, useRef } from 'react';
import { nanoid } from 'nanoid';
import { useTranslations } from '@weldsuite/i18n/client';

export interface ConversationMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'human_agent';
  content: string;
  createdAt?: Date;
  isFromAi?: boolean;
}

export interface ConversationState {
  conversationId: string | null;
  messages: ConversationMessage[];
  status:
    | 'ai_active'
    | 'waiting_for_human'
    | 'transferred_to_human'
    | 'resolved'
    | 'converted_to_ticket';
  isLoading: boolean;
  error: string | null;
}

interface PreviewConfig {
  systemInstructions?: string;
  knowledgePermissions?: Record<string, boolean>;
}

export interface UseConversationOptions {
  sessionId: string;
  workspaceId?: string;
  customerEmail?: string;
  customerName?: string;
  autoCreate?: boolean;
  previewConfig?: PreviewConfig;
}

export interface AiResponse {
  messageId?: string;
  content: string;
  shouldEscalate?: boolean;
  escalationReason?: string;
  shouldCreateTicket?: boolean;
}

export function useConversation(options: UseConversationOptions) {
  const t = useTranslations();
  const [conversationId] = useState(() => options.sessionId || nanoid());
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [status, setStatus] = useState<ConversationState['status']>('ai_active');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Send a message. AI has been removed platform-wide — this used to stream
   * a response from `/api/helpdesk/weldagent/chat` (the chat-widget preview's
   * live AI backend). It no longer calls that endpoint (now 503); instead it
   * appends a local "AI is currently unavailable" reply so the widget preview
   * still renders a conversation instead of erroring against a dead route.
   */
  const sendMessage = useCallback(
    async (content: string): Promise<AiResponse | null> => {
      setError(null);
      setIsLoading(true);

      const userMsg: ConversationMessage = {
        id: nanoid(),
        role: 'user',
        content,
        createdAt: new Date(),
        isFromAi: false,
      };

      const assistantId = nanoid();
      const unavailableText = t('sweep.welddesk.chatWidgetConversation.aiUnavailable');
      const assistantMsg: ConversationMessage = {
        id: assistantId,
        role: 'assistant',
        content: unavailableText,
        createdAt: new Date(),
        isFromAi: true,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsLoading(false);

      return {
        messageId: assistantId,
        content: unavailableText,
        shouldEscalate: false,
        shouldCreateTicket: false,
      };
    },
    []
  );

  /**
   * Stop the current streaming response
   */
  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * Add a system message
   */
  const addSystemMessage = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: nanoid(),
        role: 'system' as const,
        content,
        createdAt: new Date(),
      },
    ]);
  }, []);

  /**
   * Update conversation status
   */
  const updateStatus = useCallback(
    (newStatus: ConversationState['status']) => {
      setStatus(newStatus);
    },
    []
  );

  /**
   * Clear error
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  /**
   * Reset conversation
   */
  const reset = useCallback(() => {
    setMessages([]);
    setStatus('ai_active');
    setError(null);
  }, []);

  const isSendingMessage = isLoading;

  return {
    // State
    conversationId,
    messages,
    status,
    isLoading,
    isSendingMessage,
    error,

    // Actions
    sendMessage,
    stop,
    addSystemMessage,
    updateStatus,
    clearError,
    reset,
  };
}
