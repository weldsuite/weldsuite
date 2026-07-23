/**
 * Message List Component
 * Displays all messages with typing indicator and scroll behavior
 * Matches the platform's exact Intercom-style design
 */

import { Fragment, useEffect, useRef } from 'react';
import type { Message } from '@/lib/api/types';
import { MessageBubble } from './message-bubble';
import { ChoicesBubble } from './choices-bubble';
import { InputFormBubble } from './input-form-bubble';
import { CsatSurveyBubble } from './csat-survey-bubble';
import { TypingIndicator } from './typing-indicator';

interface MessageListProps {
  messages: Message[];
  isTyping?: boolean;
  typingAgent?: { name?: string; avatar?: string; isBot?: boolean } | null;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  // New messages divider
  lastSeenMessageId?: string | null;
  // Interactive workflow step callbacks
  onChoiceSelect?: (messageId: string, optionId: string, value: string) => void;
  onInputSubmit?: (messageId: string, data: Record<string, string>) => void;
  onCsatSubmit?: (messageId: string, rating: number, feedback?: string) => void;
  // Theme
  themeSettings?: {
    chatBackgroundColor?: string;
    userBubbleColor?: string;
    userBubbleTextColor?: string;
    agentBubbleColor?: string;
    agentBubbleTextColor?: string;
  };
}

export function MessageList({
  messages,
  isTyping = false,
  typingAgent,
  messagesEndRef,
  lastSeenMessageId,
  onChoiceSelect,
  onInputSubmit,
  onCsatSubmit,
  themeSettings,
}: MessageListProps) {
  // Check if a message is part of a group (same sender, within 2 minutes)
  const isGroupedWithPrevious = (index: number): boolean => {
    if (index === 0) return false;
    const currentMsg = messages[index];
    const prevMsg = messages[index - 1];

    // Must be same sender
    if (currentMsg?.sender !== prevMsg?.sender) return false;

    // Must be within 2 minutes (120000ms)
    const currentTime = new Date(currentMsg?.timestamp ?? 0).getTime();
    const prevTime = new Date(prevMsg?.timestamp ?? 0).getTime();
    return (currentTime - prevTime) < 120000;
  };

  // Scroll to bottom on mount
  const hasMounted = useRef(false);
  useEffect(() => {
    if (!hasMounted.current && messages.length > 0) {
      hasMounted.current = true;
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [messages, messagesEndRef]);

  // Find the last agent message index (excluding system messages)
  const lastAgentMessageIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.sender !== 'user' && !msg.id.startsWith('system-') && !msg.metadata?.systemEvent) return i;
    }
    return -1;
  })();

  // Find the index after which to show the "new messages" divider
  // Only show before the first non-customer message after the last seen message
  const newMessagesDividerIndex = (() => {
    if (!lastSeenMessageId) return -1;
    const idx = messages.findIndex(m => m.id === lastSeenMessageId);
    if (idx === -1 || idx >= messages.length - 1) return -1;
    // Check if there are any non-user messages after the last seen message
    const hasNonUserMessages = messages.slice(idx + 1).some(m => m.sender !== 'user');
    if (!hasNonUserMessages) return -1;
    // Find the index right before the first non-user message after last seen
    for (let i = idx + 1; i < messages.length; i++) {
      if (messages[i].sender !== 'user') return i - 1;
    }
    return -1;
  })();

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4 widget-scrollbar" style={themeSettings?.chatBackgroundColor ? { backgroundColor: themeSettings.chatBackgroundColor } : undefined}>
        {messages.map((message, index) => {
          const metadata = message.metadata;
          const interactiveType = metadata?.interactiveType as string | undefined;

          // Show "new messages" divider after the last seen message
          const showDivider = index === newMessagesDividerIndex + 1 && newMessagesDividerIndex >= 0;

          const divider = showDivider ? (
            <div key="new-messages-divider" className="flex items-center gap-3 my-3">
              <div className="flex-1 h-px bg-blue-400" />
              <span className="text-xs font-medium text-blue-500 whitespace-nowrap">New messages</span>
              <div className="flex-1 h-px bg-blue-400" />
            </div>
          ) : null;

          // Render choices bubble for send_choices workflow step
          if (interactiveType === 'choices' && onChoiceSelect) {
            return (
              <Fragment key={message.id}>
                {divider}
                <div className="flex justify-start mb-2">
                  <ChoicesBubble
                    messageId={message.id}
                    content={message.content}
                    options={(metadata?.options as any[]) || []}
                    selectedOptionId={metadata?.selectedOptionId as string | undefined}
                    onSelect={onChoiceSelect}
                  />
                </div>
  
              </Fragment>
            );
          }

          // Render input form bubble for collect_input workflow step
          if (interactiveType === 'collect_input' && onInputSubmit) {
            return (
              <Fragment key={message.id}>
                {divider}
                <div className="flex justify-start mb-2">
                  <InputFormBubble
                    messageId={message.id}
                    content={message.content}
                    fields={(metadata?.fields as any[]) || []}
                    submittedData={metadata?.submittedData as Record<string, string> | undefined}
                    onSubmit={onInputSubmit}
                  />
                </div>
  
              </Fragment>
            );
          }

          // Render CSAT survey bubble for trigger_csat workflow step
          if (interactiveType === 'csat_survey' && onCsatSubmit) {
            return (
              <Fragment key={message.id}>
                {divider}
                <div className="flex justify-start mb-2">
                  <CsatSurveyBubble
                    messageId={message.id}
                    content={message.content}
                    submittedRating={metadata?.submittedRating as number | undefined}
                    submittedFeedback={metadata?.submittedFeedback as string | undefined}
                    onSubmit={onCsatSubmit}
                  />
                </div>

              </Fragment>
            );
          }

          // Render system event messages (e.g. "Agent joined") as centered text
          const isSystemEvent = message.id.startsWith('system-') || message.metadata?.systemEvent === true;
          if (isSystemEvent) {
            return (
              <Fragment key={message.id}>
                {divider}
                <div className="flex justify-center my-5">
                  <span className="text-xs text-gray-400 bg-gray-100 px-3 py-1 rounded-lg font-medium">
                    {message.content}
                  </span>
                </div>
  
              </Fragment>
            );
          }

          return (
            <Fragment key={message.id}>
              {divider}
              <MessageBubble
                message={message}
                isGrouped={isGroupedWithPrevious(index)}
                isFirstMessage={index === 0}
                isLastAgentMessage={index === lastAgentMessageIndex}
                themeSettings={themeSettings}
              />

            </Fragment>
          );
        })}

        {/* Typing indicator */}
        {isTyping && (
          <TypingIndicator
            agentBubbleColor={themeSettings?.agentBubbleColor}
            agentName={typingAgent?.name}
            agentAvatar={typingAgent?.avatar}
            isBot={typingAgent?.isBot}
          />
        )}

        {/* Scroll anchor */}
        <div ref={messagesEndRef} />
      </div>
    </>
  );
}
