/**
 * useWelcomeFlow — Manages the welcome workflow preview.
 *
 * Renders bot greeting messages with staggered timing + typing indicators.
 * Stops at the first interactive step (collect_input, send_choices).
 * Conversation is only created when the customer responds.
 *
 * Timers are scheduled during render (guarded by ref) to avoid React
 * Strict Mode / useEffect cleanup killing them before they fire.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { Message, OpenWelcomeWorkflow } from '@/lib/api/types';

interface UseWelcomeFlowOptions {
  workflow: OpenWelcomeWorkflow | null | undefined;
  isOpen: boolean;
  hasConversation: boolean;
  botAgent?: { name: string; avatarUrl: string | null } | null;
}

interface UseWelcomeFlowReturn {
  welcomeMessages: Message[];
  isShowingWelcome: boolean;
  isWelcomeTyping: boolean;
  resetWelcome: () => void;
  updateWelcomeMessage: (messageId: string, updates: Partial<Message>) => void;
}

export function useWelcomeFlow({
  workflow,
  isOpen,
  hasConversation,
  botAgent,
}: UseWelcomeFlowOptions): UseWelcomeFlowReturn {
  const [welcomeMessages, setWelcomeMessages] = useState<Message[]>([]);
  const [isShowingWelcome, setIsShowingWelcome] = useState(false);
  const [isWelcomeTyping, setIsWelcomeTyping] = useState(false);
  const startedRef = useRef(false);

  const resetWelcome = useCallback(() => {
    setWelcomeMessages([]);
    setIsShowingWelcome(false);
    setIsWelcomeTyping(false);
    startedRef.current = false;
  }, []);

  const updateWelcomeMessage = useCallback((messageId: string, updates: Partial<Message>) => {
    setWelcomeMessages((prev) =>
      prev.map((m) => m.id === messageId ? { ...m, ...updates } : m),
    );
  }, []);

  // Schedule welcome messages during render (not in useEffect).
  // useEffect cleanup runs on every re-render in Strict Mode, killing
  // timers before the 500ms callback fires. Scheduling in render with
  // a ref guard ensures timers survive re-renders.
  if (
    !startedRef.current &&
    isOpen &&
    !hasConversation &&
    workflow?.parts?.length
  ) {
    startedRef.current = true;

    const botName = botAgent?.name || 'Bot';
    let cumulativeDelay = 0;

    for (const part of workflow.parts) {
      const delaySec = part.delaySeconds || 0;
      const delayMs = delaySec * 1000;
      cumulativeDelay += delayMs;

      const typingDelay = cumulativeDelay;
      const messageDelay = cumulativeDelay + Math.max(delayMs, 500);
      cumulativeDelay = messageDelay;

      const capturedPart = part;

      setTimeout(() => {
        setIsShowingWelcome(true);
        setIsWelcomeTyping(true);
      }, typingDelay);

      setTimeout(() => {
        setIsWelcomeTyping(false);
        setWelcomeMessages((prev) => {
          const interactiveType =
            capturedPart.type === 'send_choices'
              ? 'choices'
              : capturedPart.type === 'collect_input' || capturedPart.type === 'collect_customer_info'
                ? 'collect_input'
                : undefined;

          const msg: Message = {
            id: `welcome-wf-${capturedPart.stepId || Date.now()}-${prev.length}`,
            conversationId: '',
            content: capturedPart.message || '',
            sender: 'agent',
            senderName: botName,
            timestamp: new Date(),
            metadata: {
              isWelcomePreview: true,
              workflowStepId: capturedPart.stepId,
              ...(interactiveType
                ? {
                    interactiveType,
                    options: capturedPart.options,
                    fields: capturedPart.fields,
                  }
                : {}),
            },
          };
          return [...prev, msg];
        });
      }, messageDelay);

      // Stop after first interactive step
      if (
        part.type === 'send_choices' ||
        part.type === 'collect_input' ||
        part.type === 'collect_customer_info'
      ) {
        break;
      }
    }
  }

  return {
    welcomeMessages,
    isShowingWelcome: isShowingWelcome && !hasConversation,
    isWelcomeTyping,
    resetWelcome,
    updateWelcomeMessage,
  };
}
