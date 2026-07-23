/**
 * Widget Shell Component
 * Main chat interface that combines header, messages, and input
 */

import { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils/cn';
import type { Message } from '@/lib/api/types';
import { WidgetHeader } from './widget-header';
import { MessageList } from './message-list';
import { MessageInput, type Attachment } from './message-input';
import { TicketBanner } from './ticket-banner';
import { useMobileDetection, useViewportHeight } from '@/hooks';

/**
 * Footer shown when conversation is closed
 */
function ConversationClosedFooter() {
  return (
    <div className="px-4 py-4 border-t border-gray-100">
      <p className="text-sm text-gray-400 text-center">
        This conversation has ended
      </p>
    </div>
  );
}

interface WidgetShellProps {
  // Messages
  messages: Message[];
  isTyping?: boolean;
  typingAgent?: { name?: string; avatar?: string; isBot?: boolean } | null;
  isLoadingMessages?: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  lastSeenMessageId?: string | null;

  // Input
  inputValue: string;
  onInputChange: (value: string) => void;
  onSend: (attachments?: Attachment[]) => void;

  // Header
  connectionState?: string;
  assignedAgent?: { id: string; name: string; avatar?: string } | null;
  botAgent?: { name: string; avatar?: string | null };
  disableBackNavigation?: boolean;
  parentOrigin?: string;
  onBack?: () => void;
  onHistory?: () => void;
  onClose?: () => void;

  // Conversation closed
  isConversationClosed?: boolean;

  // Interactive workflow steps
  onChoiceSelect?: (messageId: string, optionId: string, value: string) => void;
  onInputSubmit?: (messageId: string, data: Record<string, string>) => void;
  onCsatSubmit?: (messageId: string, rating: number, feedback?: string) => void;

  // Availability
  replyTimeText?: string;
  isWithinOfficeHours?: boolean;

  // Branding
  showBranding?: boolean;

  // Linked ticket banner
  linkedTicket?: {
    ticketId: string;
    ticketNumber: string;
    ticketSubject: string;
    ticketStatus: string;
  } | null;
  onTicketBannerClick?: () => void;

  // Style
  isClosing?: boolean;
  isEntering?: boolean;
  shouldAnimate?: boolean;
  className?: string;

  // Theme
  themeSettings?: {
    backgroundColor?: string;
    headerColor?: string;
    borderRadius?: string;
    fontSize?: string;
    buttonColor?: string;
    buttonTextColor?: string;
    chatBackgroundColor?: string;
    userBubbleColor?: string;
    userBubbleTextColor?: string;
    agentBubbleColor?: string;
    agentBubbleTextColor?: string;
  };
}

export function WidgetShell({
  messages,
  isTyping,
  typingAgent,
  isLoadingMessages,
  messagesEndRef,
  lastSeenMessageId,
  inputValue,
  onInputChange,
  onSend,
  connectionState,
  assignedAgent,
  botAgent,
  disableBackNavigation,
  parentOrigin,
  onBack,
  onHistory,
  onClose,
  isConversationClosed,
  onChoiceSelect,
  onInputSubmit,
  onCsatSubmit,
  replyTimeText,
  isWithinOfficeHours,
  showBranding,
  linkedTicket,
  onTicketBannerClick,
  isClosing,
  isEntering,
  shouldAnimate = true,
  className,
  themeSettings,
}: WidgetShellProps) {
  // Lock animation decision to mount time so re-renders don't replay it
  const mountAnimateRef = useRef(shouldAnimate);

  // Detect pending interactive input forms (e.g. collect_customer_info)
  // Disables the message input until the form is submitted
  const hasPendingInput = messages.some((msg) => {
    const meta = msg.metadata;
    return (
      meta?.interactiveType === 'collect_input' &&
      !meta?.submittedData
    );
  });

  // Detect if we're embedded in an iframe (SDK mode)
  const [isEmbedded, setIsEmbedded] = useState(false);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [initialHeight, setInitialHeight] = useState<number | null>(null);
  const isMobile = useMobileDetection();
  const viewport = useViewportHeight();

  useEffect(() => {
    try {
      setIsEmbedded(window.self !== window.top);
    } catch {
      // Cross-origin iframe - we're definitely embedded
      setIsEmbedded(true);
    }
  }, []);

  // Track keyboard visibility to prevent layout shifts
  useEffect(() => {
    if (!isMobile) return;

    // Store initial height when component mounts
    if (initialHeight === null && viewport.height > 0) {
      setInitialHeight(viewport.height);
    }

    // Detect keyboard by comparing viewport height
    if (initialHeight && viewport.height < initialHeight * 0.75) {
      setIsKeyboardVisible(true);
    } else {
      setIsKeyboardVisible(false);
    }
  }, [viewport.height, initialHeight, isMobile]);

  // Determine if we should use full-screen mode
  // Full-screen when: embedded in iframe OR on mobile device
  const isFullScreen = isEmbedded || isMobile;

  // In embedded/mobile mode, fill the container (SDK handles border/shadow)
  // In standalone desktop mode, use fixed positioning with own border/shadow
  const containerStyles: React.CSSProperties = isFullScreen
    ? {
        // Embedded mode (mobile or desktop): fill entire iframe
        // SDK container handles border and shadow
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100%',
        height: '100%',
        // Prevent iOS rendering glitches during keyboard animation
        WebkitBackfaceVisibility: 'hidden',
        backfaceVisibility: 'hidden',
        transform: 'translateZ(0)',
      }
    : {
        // Desktop standalone: floating widget with own border/shadow
        width: '400px',
        height: 'min(680px, 88vh)',
        borderRadius: themeSettings?.borderRadius ? `${themeSettings.borderRadius}px` : '16px',
        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08)',
        border: '1px solid rgba(0, 0, 0, 0.1)',
        maxWidth: 'calc(100vw - 40px)',
      };

  return (
    <>
      {/* Full-screen backdrop to prevent seeing underlying page during keyboard animation */}
      {isMobile && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: '#ffffff',
            zIndex: -1,
          }}
        />
      )}
      <div
        className={cn(
          'flex flex-col overflow-hidden',
          !themeSettings?.backgroundColor && 'bg-white',
          // Remove border-radius on mobile for full-screen effect
          isMobile ? 'rounded-none' : (!themeSettings?.borderRadius && 'rounded-2xl'),
          // Only use fixed positioning in standalone desktop mode
          !isFullScreen && 'fixed bottom-[95px] right-5 shadow-2xl z-[999999]',
          mountAnimateRef.current && !isFullScreen && 'widget-animation',
          className
        )}
        style={{
          ...containerStyles,
          ...(themeSettings?.backgroundColor ? { backgroundColor: themeSettings.backgroundColor } : {}),
          ...(themeSettings?.fontSize ? { fontSize: `${themeSettings.fontSize}px` } : {}),
        }}
      >
      {/* Content area */}
      <div className={cn('flex flex-col flex-1 min-h-0', isEntering && 'view-enter')}>
        {/* Header */}
        <WidgetHeader
          connectionState={connectionState}
          assignedAgent={assignedAgent}
          botAgent={botAgent}
          disableBackNavigation={disableBackNavigation}
          parentOrigin={parentOrigin}
          onBack={onBack}
          onClose={onClose}
          headerColor={themeSettings?.headerColor}
          replyTimeText={replyTimeText}
          isWithinOfficeHours={isWithinOfficeHours}
        />
        {/* Linked ticket banner */}
        {linkedTicket && (
          <TicketBanner
            ticketNumber={linkedTicket.ticketNumber}
            ticketSubject={linkedTicket.ticketSubject}
            ticketStatus={linkedTicket.ticketStatus}
            onClick={onTicketBannerClick}
          />
        )}
        {/* Messages */}
        {isLoadingMessages ? (
          <div className="flex-1 px-4 pt-4 space-y-4 animate-pulse">
            {/* Agent message skeleton */}
            <div className="h-11 bg-gray-100 rounded-2xl w-40" style={{ borderBottomLeftRadius: '4px' }} />
            {/* User message skeleton */}
            <div className="flex justify-end">
              <div className="h-11 bg-gray-100 rounded-2xl w-32" style={{ borderBottomRightRadius: '4px' }} />
            </div>
            {/* Agent message skeleton */}
            <div className="h-11 bg-gray-100 rounded-2xl w-44" style={{ borderBottomLeftRadius: '4px' }} />
          </div>
        ) : (
          <MessageList
            messages={messages}
            isTyping={isTyping}
            typingAgent={typingAgent}
            messagesEndRef={messagesEndRef}
            lastSeenMessageId={lastSeenMessageId}
            onChoiceSelect={onChoiceSelect}
            onInputSubmit={onInputSubmit}
            onCsatSubmit={onCsatSubmit}
            themeSettings={themeSettings}
          />
        )}

        {/* Input or Closed State */}
        {isConversationClosed ? (
          <ConversationClosedFooter />
        ) : (
          <div className={showBranding !== false ? "-mb-2" : "pb-2"}>
            <MessageInput
              value={inputValue}
              onChange={onInputChange}
              onSend={onSend}
              disabled={hasPendingInput}
              placeholder={hasPendingInput ? 'Please fill in the form above first' : undefined}
              buttonColor={themeSettings?.buttonColor}
              buttonTextColor={themeSettings?.buttonTextColor}
            />
          </div>
        )}

        {/* WeldDesk Branding */}
        {showBranding !== false && (
          <div className="flex items-center justify-center py-2.5">
            <a
              href="https://welddesk.org"
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              <span className="inline-flex items-center gap-1">Running on <img src="/welddesk-logo.svg" alt="WeldDesk" className="h-3 ml-0.5 grayscale opacity-50 group-hover:grayscale-0 group-hover:opacity-100 transition-all" style={{ marginTop: '2px' }} /></span>
            </a>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
