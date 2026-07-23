/**
 * ChatView — The main chat experience.
 *
 * Architecture:
 *   1. Welcome flow renders client-side until customer engages
 *   2. On first interaction → create conversation → connect RoomClient
 *   3. All subsequent messages arrive via RoomClient WebSocket (no SSE, no polling)
 *   4. On reopen → load history from DB + connect RoomClient
 */

import { useState, useCallback, useEffect } from 'react';
import { useConversation } from '@/hooks/use-conversation';
import { useWelcomeFlow } from '@/hooks/use-welcome-flow';
import { useWidgetConfig } from '@/providers/widget-config-provider';
import { useCustomer } from '@/providers/customer-provider';
import { WidgetShell } from './widget-shell';
import { useMessagesScroll } from '@/hooks/use-messages-scroll';

interface ChatViewProps {
  initialConversationId?: string | null;
  realtimeUrl?: string;
  onBack: () => void;
  onClose?: () => void;
  onConversationCreated?: (id: string) => void;
}

export function ChatView({
  initialConversationId,
  realtimeUrl,
  onBack,
  onConversationCreated,
  onClose,
}: ChatViewProps) {
  const config = useWidgetConfig();
  const customer = useCustomer();
  const [inputValue, setInputValue] = useState('');
  const { messagesEndRef, scrollToBottom } = useMessagesScroll();

  const {
    conversationId,
    messages,
    isLoading,
    isClosed,
    isCreating,
    typing,
    startTyping,
    stopTyping,
    send,
    respondToChoice,
    respondToInput,
    respondToCsat,
    createConversation,
    assignedAgent,
    streamingMessage,
    triggerWorkflow,
  } = useConversation(initialConversationId || null, {
    widgetId: config.widgetId,
    customerId: customer.customerId,
    customerName: customer.name || customer.visitorName,
    customerEmail: customer.email || undefined,
    realtimeUrl,
    onConversationCreated,
  });

  // Welcome flow — renders bot messages client-side until conversation exists
  const { welcomeMessages, isShowingWelcome, isWelcomeTyping, resetWelcome, updateWelcomeMessage } =
    useWelcomeFlow({
      workflow: config.welcomeWorkflow,
      isOpen: true,
      hasConversation: !!conversationId,
      botAgent: config.botAgent,
    });

  // Simple display logic:
  // - No conversation → show client-side welcome preview
  // - Conversation exists → show real messages (loaded from creation response or DB)
  const displayMessages = conversationId ? messages : welcomeMessages;

  // Typing indicator
  const hasStreamingMessage = displayMessages.some(
    (m) => (m.metadata as Record<string, unknown>)?.isStreaming,
  );
  const isTyping = !hasStreamingMessage && (typing.isTyping || isWelcomeTyping || isCreating);
  const botAgentForShell = config.botAgent
    ? { name: config.botAgent.name, avatar: config.botAgent.avatarUrl }
    : undefined;

  // Scroll on new messages
  useEffect(() => {
    setTimeout(() => scrollToBottom(), 50);
  }, [displayMessages.length, scrollToBottom]);

  // ==========================================================================
  // Handlers
  // ==========================================================================

  const handleSend = useCallback(async () => {
    if (!inputValue.trim()) return;
    const content = inputValue;
    setInputValue('');
    stopTyping();

    await send(content);
    setTimeout(() => scrollToBottom(), 100);
  }, [inputValue, send, stopTyping, scrollToBottom]);

  const handleInputChange = useCallback((value: string) => {
    setInputValue(value);
    if (value.trim()) {
      startTyping();
    } else {
      stopTyping();
    }
  }, [startTyping, stopTyping]);

  const handleChoiceSelect = useCallback(async (
    messageId: string,
    optionId: string,
    value: string,
  ) => {
    // Welcome preview choice — create conversation first
    if (!conversationId && messageId.startsWith('welcome-wf-')) {
      const newConvId = await createConversation();
      if (!newConvId) return;
      resetWelcome();
      // Trigger created workflow — bot responses arrive via RoomClient
      await triggerWorkflow('created');
      return;
    }

    await respondToChoice(messageId, optionId, value);
    setTimeout(() => scrollToBottom(), 100);
  }, [conversationId, createConversation, resetWelcome, respondToChoice, triggerWorkflow, scrollToBottom]);

  const handleInputSubmit = useCallback(async (
    messageId: string,
    data: Record<string, string>,
  ) => {
    // Welcome preview form — create conversation with customer data
    if (!conversationId && messageId.startsWith('welcome-wf-')) {
      if (data.email) customer.setEmail(data.email);
      if (data.name) customer.setName(data.name);

      // Mark the form as submitted in the local welcome message (unlocks the input box)
      const msg = welcomeMessages.find(m => m.id === messageId);
      if (msg) {
        updateWelcomeMessage(messageId, {
          metadata: { ...(msg.metadata || {}), submittedData: data, respondedAt: new Date().toISOString() },
        });
      }

      // Persist bot messages with submitted data in metadata
      const formStepId = (welcomeMessages.find(wm => wm.id === messageId)?.metadata as Record<string, unknown>)?.workflowStepId;
      const botMessages = welcomeMessages
        .filter(m => m.sender === 'agent')
        .map((m) => {
          const meta = (m.metadata || {}) as Record<string, unknown>;
          const isFormStep = meta.interactiveType === 'collect_input' && meta.workflowStepId === formStepId;
          return {
            content: m.content,
            sender: 'agent' as const,
            senderName: m.senderName,
            metadata: isFormStep
              ? { ...meta, submittedData: data, respondedAt: new Date().toISOString() }
              : meta,
          };
        });

      const newConvId = await createConversation({
        welcomeMessages: botMessages,
        customerEmail: data.email || customer.email || undefined,
        customerName: data.name || customer.name || undefined,
      });

      // Trigger conversation_created workflow — bot/AI responses arrive via RoomClient
      if (newConvId) {
        triggerWorkflow('created', undefined, newConvId);
      }
      // Don't resetWelcome() — welcome messages stay visible
      return;
    }

    await respondToInput(messageId, data);
    setTimeout(() => scrollToBottom(), 100);
  }, [conversationId, createConversation, customer, welcomeMessages, respondToInput, scrollToBottom]);

  const handleCsatSubmit = useCallback(async (
    messageId: string,
    rating: number,
    feedback?: string,
  ) => {
    await respondToCsat(messageId, rating, feedback);
  }, [respondToCsat]);

  // ==========================================================================
  // Render
  // ==========================================================================

  return (
    <WidgetShell
      messages={displayMessages}
      isTyping={isTyping}
      typingAgent={typing.agent}
      isLoadingMessages={isLoading}
      messagesEndRef={messagesEndRef}
      inputValue={inputValue}
      onInputChange={handleInputChange}
      onSend={handleSend}
      connectionState={conversationId ? 'connected' : 'disconnected'}
      assignedAgent={assignedAgent}
      botAgent={botAgentForShell}
      disableBackNavigation={config.disableBackNavigation}
      parentOrigin={config.parentOrigin}
      onBack={onBack}
      onClose={onClose}
      isConversationClosed={isClosed}
      onChoiceSelect={handleChoiceSelect}
      onInputSubmit={handleInputSubmit}
      onCsatSubmit={handleCsatSubmit}
      replyTimeText={config.replyTimeText}
      isWithinOfficeHours={config.isWithinOfficeHours}
      showBranding={config.showBranding}
      themeSettings={config.themeSettings}
    />
  );
}
