
import { useState, useRef, useEffect } from 'react';
import {
  ArrowLeft,
  X,
  ArrowUp,
  UserCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { useConversation, type ConversationMessage } from './use-conversation';
import { detectEscalation } from '@/lib/ai/escalation-detector';
import { detectTicketSuggestion } from '@/lib/ai/ticket-suggestion-detector';

// Temporarily disabled emoji picker due to missing dependency
// const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false });
import { ZapietHomeView } from './zapiet-home-view';
import { MessagesView } from './messages-view';
import { StatusView } from './status-view';
import { FAQView } from './faq-view';
import { ChangelogView } from './changelog-view';
import { NewsView } from './news-view';
import { AppointmentsView } from './appointments-view';
import { AnnouncementsView } from './announcements-view';
import { EventsView } from './events-view';
import { ParcelTrackingView } from './parcel-tracking-view';

interface Message {
  id: string;
  content: string;
  sender: 'user' | 'agent';
  timestamp: Date;
}

// Convert conversation message to display message
function toDisplayMessage(msg: { id?: string; role: string; content: string; createdAt?: Date }): Message {
  return {
    id: msg.id || Date.now().toString(),
    content: msg.content,
    sender: msg.role === 'user' ? 'user' : 'agent',
    timestamp: msg.createdAt || new Date(),
  };
}

interface WidgetThemeSettings {
  primaryColor: string;
  backgroundColor: string;
  textColor: string;
  buttonColor: string;
  buttonTextColor: string;
  borderRadius: string;
  fontSize: string;
  launcherColor: string;
  headerColor: string;
  accentColor: string;
  companyLogoUrl?: string;
  // Chat interface colors
  chatBackgroundColor?: string;
  userBubbleColor?: string;
  userBubbleTextColor?: string;
  agentBubbleColor?: string;
  agentBubbleTextColor?: string;
}

interface ExactIntercomWidgetProps {
  defaultOpen?: boolean;
  enabledPages?: string[];
  themeSettings?: WidgetThemeSettings;
  disableBackNavigation?: boolean;
  enableAi?: boolean;
  hideEscalationButton?: boolean;
  hideCloseButton?: boolean;
  disableLauncherButton?: boolean;
  customerEmail?: string;
  customerName?: string;
  onEscalationRequested?: (reason: string) => void;
  onTicketCreationRequested?: (data: { conversationId: string; messages: ConversationMessage[] }) => void;
  // Preview mode props - for testing draft settings before saving
  previewSystemInstructions?: string;
  previewKnowledgePermissions?: Record<string, boolean>;
  previewWelcomeMessage?: string;
  allowHumanEscalation?: boolean;
  showBranding?: boolean;
}

export function ExactIntercomWidget({
  defaultOpen = false,
  enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'news', 'appointments', 'announcements', 'events', 'parcel-tracking'],
  themeSettings,
  disableBackNavigation = false,
  enableAi = false,
  hideEscalationButton = false,
  hideCloseButton = false,
  disableLauncherButton = false,
  customerEmail,
  customerName,
  onEscalationRequested,
  onTicketCreationRequested,
  previewSystemInstructions,
  previewKnowledgePermissions,
  previewWelcomeMessage,
  allowHumanEscalation = true,
}: ExactIntercomWidgetProps = {}) {
  const startingPage = themeSettings?.startingPage || 'home';

  // AI Conversation Hook - only use if AI is enabled
  const sessionId = typeof window !== 'undefined' ? `session-${Date.now()}` : 'session-default';
  const aiConversation = useConversation({
    sessionId,
    customerEmail,
    customerName,
    autoCreate: false, // Don't auto-create, wait for first message
    // Pass preview config for testing draft settings
    previewConfig: previewSystemInstructions ? {
      systemInstructions: previewSystemInstructions,
      knowledgePermissions: previewKnowledgePermissions,
    } : undefined,
  });

  const [isOpen, setIsOpen] = useState(disableBackNavigation ? defaultOpen : false);
  const [showEscalationSuggestion, setShowEscalationSuggestion] = useState(false);
  const [escalationReason, setEscalationReason] = useState('');
  const [showTicketSuggestion, setShowTicketSuggestion] = useState(false);
  const [showZapietView, setShowZapietView] = useState(defaultOpen && !disableBackNavigation && startingPage === 'home');
  const [showMessagesView, setShowMessagesView] = useState(defaultOpen && !disableBackNavigation && startingPage === 'messages');
  const [showStatusView, setShowStatusView] = useState(defaultOpen && !disableBackNavigation && startingPage === 'status');
  const [showFAQView, setShowFAQView] = useState(defaultOpen && !disableBackNavigation && startingPage === 'help');
  const [showChangelogView, setShowChangelogView] = useState(defaultOpen && !disableBackNavigation && startingPage === 'changelog');
  const [showNewsView, setShowNewsView] = useState(defaultOpen && !disableBackNavigation && startingPage === 'news');
  const [showAppointmentsView, setShowAppointmentsView] = useState(defaultOpen && !disableBackNavigation && startingPage === 'appointments');
  const [showAnnouncementsView, setShowAnnouncementsView] = useState(defaultOpen && !disableBackNavigation && startingPage === 'announcements');
  const [showEventsView, setShowEventsView] = useState(defaultOpen && !disableBackNavigation && startingPage === 'events');
  const [showParcelTrackingView, setShowParcelTrackingView] = useState(defaultOpen && !disableBackNavigation && startingPage === 'parcel-tracking');

  // Convert AI conversation messages to display format, with initial greeting
  const welcomeText = previewWelcomeMessage?.trim();
  const initialGreeting: Message | null = welcomeText ? {
    id: 'greeting-1',
    content: welcomeText,
    sender: 'agent',
    timestamp: new Date(),
  } : null;

  // Use AI messages if AI is enabled, otherwise use greeting (if set)
  const messages: Message[] = enableAi && aiConversation.messages.length > 0
    ? aiConversation.messages.map(toDisplayMessage)
    : initialGreeting ? [initialGreeting] : [];

  const [inputValue, setInputValue] = useState('');
  // Use isLoading from AI conversation for typing indicator
  const isTyping = enableAi ? aiConversation.isSendingMessage : false;
  const [, setIsFocused] = useState(false);
  const [isMultiLine, setIsMultiLine] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Sync textarea height when switching between single/multi-line modes
  useEffect(() => {
    if (inputRef.current) {
      if (!isMultiLine) {
        inputRef.current.style.height = '20px';
        inputRef.current.style.overflowY = 'hidden';
      }
    }
  }, [isMultiLine]);

  const handleSend = async () => {
    if (!inputValue.trim()) return;

    const userMessageContent = inputValue;
    setInputValue('');
    setIsMultiLine(false);

    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = '22px';
      inputRef.current.style.overflowY = 'hidden';
    }

    // Scroll to bottom after sending message
    setTimeout(() => scrollToBottom(), 100);

    // Check if user is requesting human help
    const userEscalation = detectEscalation(userMessageContent, 'user');
    if (userEscalation.shouldEscalate && allowHumanEscalation) {
      setEscalationReason(userEscalation.reason || 'Customer requested human assistance');
      setShowEscalationSuggestion(true);
      // Still send the message to the AI for context
    }

    // If AI is enabled, send to AI SDK (streaming)
    if (enableAi) {
      try {
        // sendMessage now handles adding the user message and streaming the response
        await aiConversation.sendMessage(userMessageContent);

        // After response completes, check the last assistant message for escalation/ticket markers
        // Note: We check in a timeout to allow the state to update
        setTimeout(() => {
          const lastMessage = aiConversation.messages[aiConversation.messages.length - 1];
          if (lastMessage && lastMessage.role === 'assistant') {
            // Check for escalation markers
            const aiEscalation = detectEscalation(lastMessage.content, 'assistant');
            if (aiEscalation.shouldEscalate && allowHumanEscalation) {
              setEscalationReason(aiEscalation.reason || 'AI determined it cannot help');
              setShowEscalationSuggestion(true);
            }

            // Check for ticket creation suggestion
            const ticketSuggestion = detectTicketSuggestion(lastMessage.content, 'assistant');
            if (ticketSuggestion.shouldCreateTicket) {
              setShowTicketSuggestion(true);
            }
          }
        }, 500);
      } catch (error) {
        console.error('Error sending message:', error);
        // Error handling is done by the hook via aiConversation.error
        if (allowHumanEscalation) {
          setShowEscalationSuggestion(true);
          setEscalationReason('Connection error - would you like to speak with a human agent?');
        }
      }
    } else {
      // Fallback to mock response if AI is disabled - add messages manually
      // For non-AI mode, we still need to display something
      // Since messages is now derived from aiConversation, we'd need different handling
      // For now, if AI is disabled, just show the escalation option
      if (allowHumanEscalation) {
        setShowEscalationSuggestion(true);
        setEscalationReason('AI assistant is not enabled. Would you like to speak with a human agent?');
      }
    }
  };

  const openChatView = () => {
    // Close all views and open chat
    setShowZapietView(false);
    setShowMessagesView(false);
    setShowStatusView(false);
    setShowFAQView(false);
    setShowChangelogView(false);
    setShowNewsView(false);
    setShowAppointmentsView(false);
    setShowAnnouncementsView(false);
    setShowEventsView(false);
    setShowParcelTrackingView(false);
    setIsOpen(true);
  };

  return (
    <>
      {/* Launcher Button - Always visible like Intercom */}
      <Button
        variant="ghost"
        onClick={() => {
          if (disableLauncherButton) return;
          if (showZapietView || showMessagesView || showStatusView || showFAQView || showChangelogView || showNewsView || showAppointmentsView || showAnnouncementsView || showEventsView || showParcelTrackingView) {
            setShowZapietView(false);
            setShowMessagesView(false);
            setShowStatusView(false);
            setShowFAQView(false);
            setShowChangelogView(false);
            setShowNewsView(false);
            setShowAppointmentsView(false);
            setShowAnnouncementsView(false);
            setShowEventsView(false);
            setShowParcelTrackingView(false);
          } else {
            // Open the starting page based on settings
            if (startingPage === 'home') setShowZapietView(true);
            else if (startingPage === 'messages') setShowMessagesView(true);
            else if (startingPage === 'help') setShowFAQView(true);
            else if (startingPage === 'status') setShowStatusView(true);
            else if (startingPage === 'changelog') setShowChangelogView(true);
            else if (startingPage === 'news') setShowNewsView(true);
            else if (startingPage === 'appointments') setShowAppointmentsView(true);
            else if (startingPage === 'announcements') setShowAnnouncementsView(true);
            else if (startingPage === 'events') setShowEventsView(true);
            else if (startingPage === 'parcel-tracking') setShowParcelTrackingView(true);
            else setIsOpen(!isOpen);
          }
        }}
        className={`fixed bottom-5 right-5 w-[60px] h-[60px] shadow-lg hover:shadow-xl transition-shadow duration-200 flex items-center justify-center z-[999998] ${disableLauncherButton ? 'cursor-default' : ''}`}
        style={{
          backgroundColor: themeSettings?.launcherColor || '#3B82F6',
          borderRadius: '50%'
        }}
      >
        <img
          src="/assets/images/welddesk/launcher-icon.png"
          alt="Chat"
          width={24}
          height={24}
          style={{ width: 24, height: 'auto', marginTop: 1 }}
        />
      </Button>

      {/* Messages View */}
      {showMessagesView && (
        <MessagesView
          onClose={() => setShowMessagesView(false)}
          onOpenChat={openChatView}
          onNavigateHome={() => {
            setShowMessagesView(false);
            setShowZapietView(true);
          }}
          onNavigateStatus={() => {
            setShowMessagesView(false);
            setShowStatusView(true);
          }}
          onNavigateFAQ={() => {
            setShowMessagesView(false);
            setShowFAQView(true);
          }}
          onNavigateChangelog={() => {
            setShowMessagesView(false);
            setShowChangelogView(true);
          }}
          onNavigateNews={() => {
            setShowMessagesView(false);
            setShowNewsView(true);
          }}
          onNavigateAppointments={() => {
            setShowMessagesView(false);
            setShowAppointmentsView(true);
          }}
          onNavigateAnnouncements={() => {
            setShowMessagesView(false);
            setShowAnnouncementsView(true);
          }}
          onNavigateEvents={() => {
            setShowMessagesView(false);
            setShowEventsView(true);
          }}
          onNavigateParcelTracking={() => {
            setShowMessagesView(false);
            setShowParcelTrackingView(true);
          }}
          enabledPages={enabledPages}
          themeSettings={themeSettings}
          hideCloseButton={hideCloseButton}
        />
      )}

      {/* Status View */}
      {showStatusView && (
        <StatusView
          onClose={() => setShowStatusView(false)}
          onNavigateHome={() => {
            setShowStatusView(false);
            setShowZapietView(true);
          }}
          onNavigateMessages={() => {
            setShowStatusView(false);
            setShowMessagesView(true);
          }}
          onNavigateFAQ={() => {
            setShowStatusView(false);
            setShowFAQView(true);
          }}
          onNavigateChangelog={() => {
            setShowStatusView(false);
            setShowChangelogView(true);
          }}
          onNavigateNews={() => {
            setShowStatusView(false);
            setShowNewsView(true);
          }}
          onNavigateAppointments={() => {
            setShowStatusView(false);
            setShowAppointmentsView(true);
          }}
          onNavigateAnnouncements={() => {
            setShowStatusView(false);
            setShowAnnouncementsView(true);
          }}
          onNavigateEvents={() => {
            setShowStatusView(false);
            setShowEventsView(true);
          }}
          onNavigateParcelTracking={() => {
            setShowStatusView(false);
            setShowParcelTrackingView(true);
          }}
          enabledPages={enabledPages}
        />
      )}

      {/* FAQ View */}
      {showFAQView && (
        <FAQView
          onClose={() => setShowFAQView(false)}
          onNavigateHome={() => {
            setShowFAQView(false);
            setShowZapietView(true);
          }}
          onNavigateMessages={() => {
            setShowFAQView(false);
            setShowMessagesView(true);
          }}
          onNavigateStatus={() => {
            setShowFAQView(false);
            setShowStatusView(true);
          }}
          onNavigateChangelog={() => {
            setShowFAQView(false);
            setShowChangelogView(true);
          }}
          onNavigateNews={() => {
            setShowFAQView(false);
            setShowNewsView(true);
          }}
          onNavigateAppointments={() => {
            setShowFAQView(false);
            setShowAppointmentsView(true);
          }}
          onNavigateAnnouncements={() => {
            setShowFAQView(false);
            setShowAnnouncementsView(true);
          }}
          onNavigateEvents={() => {
            setShowFAQView(false);
            setShowEventsView(true);
          }}
          onNavigateParcelTracking={() => {
            setShowFAQView(false);
            setShowParcelTrackingView(true);
          }}
          enabledPages={enabledPages}
        />
      )}

      {/* Changelog View */}
      {showChangelogView && (
        <ChangelogView
          onClose={() => setShowChangelogView(false)}
          onNavigateHome={() => {
            setShowChangelogView(false);
            setShowZapietView(true);
          }}
          onNavigateMessages={() => {
            setShowChangelogView(false);
            setShowMessagesView(true);
          }}
          onNavigateStatus={() => {
            setShowChangelogView(false);
            setShowStatusView(true);
          }}
          onNavigateFAQ={() => {
            setShowChangelogView(false);
            setShowFAQView(true);
          }}
          onNavigateNews={() => {
            setShowChangelogView(false);
            setShowNewsView(true);
          }}
          onNavigateAppointments={() => {
            setShowChangelogView(false);
            setShowAppointmentsView(true);
          }}
          onNavigateAnnouncements={() => {
            setShowChangelogView(false);
            setShowAnnouncementsView(true);
          }}
          onNavigateEvents={() => {
            setShowChangelogView(false);
            setShowEventsView(true);
          }}
          onNavigateParcelTracking={() => {
            setShowChangelogView(false);
            setShowParcelTrackingView(true);
          }}
          enabledPages={enabledPages}
        />
      )}

      {/* News View */}
      {showNewsView && (
        <NewsView
          onClose={() => setShowNewsView(false)}
          onNavigateHome={() => {
            setShowNewsView(false);
            setShowZapietView(true);
          }}
          onNavigateMessages={() => {
            setShowNewsView(false);
            setShowMessagesView(true);
          }}
          onNavigateStatus={() => {
            setShowNewsView(false);
            setShowStatusView(true);
          }}
          onNavigateFAQ={() => {
            setShowNewsView(false);
            setShowFAQView(true);
          }}
          onNavigateChangelog={() => {
            setShowNewsView(false);
            setShowChangelogView(true);
          }}
          onNavigateAppointments={() => {
            setShowNewsView(false);
            setShowAppointmentsView(true);
          }}
          onNavigateAnnouncements={() => {
            setShowNewsView(false);
            setShowAnnouncementsView(true);
          }}
          onNavigateEvents={() => {
            setShowNewsView(false);
            setShowEventsView(true);
          }}
          onNavigateParcelTracking={() => {
            setShowNewsView(false);
            setShowParcelTrackingView(true);
          }}
          enabledPages={enabledPages}
        />
      )}

      {/* Appointments View */}
      {showAppointmentsView && (
        <AppointmentsView
          onClose={() => setShowAppointmentsView(false)}
          onNavigateHome={() => {
            setShowAppointmentsView(false);
            setShowZapietView(true);
          }}
          onNavigateMessages={() => {
            setShowAppointmentsView(false);
            setShowMessagesView(true);
          }}
          onNavigateStatus={() => {
            setShowAppointmentsView(false);
            setShowStatusView(true);
          }}
          onNavigateFAQ={() => {
            setShowAppointmentsView(false);
            setShowFAQView(true);
          }}
          onNavigateChangelog={() => {
            setShowAppointmentsView(false);
            setShowChangelogView(true);
          }}
          onNavigateNews={() => {
            setShowAppointmentsView(false);
            setShowNewsView(true);
          }}
          onNavigateAnnouncements={() => {
            setShowAppointmentsView(false);
            setShowAnnouncementsView(true);
          }}
          onNavigateEvents={() => {
            setShowAppointmentsView(false);
            setShowEventsView(true);
          }}
          onNavigateParcelTracking={() => {
            setShowAppointmentsView(false);
            setShowParcelTrackingView(true);
          }}
          enabledPages={enabledPages}
        />
      )}

      {/* Announcements View */}
      {showAnnouncementsView && (
        <AnnouncementsView
          onClose={() => setShowAnnouncementsView(false)}
          onNavigateHome={() => {
            setShowAnnouncementsView(false);
            setShowZapietView(true);
          }}
          onNavigateMessages={() => {
            setShowAnnouncementsView(false);
            setShowMessagesView(true);
          }}
          onNavigateStatus={() => {
            setShowAnnouncementsView(false);
            setShowStatusView(true);
          }}
          onNavigateFAQ={() => {
            setShowAnnouncementsView(false);
            setShowFAQView(true);
          }}
          onNavigateChangelog={() => {
            setShowAnnouncementsView(false);
            setShowChangelogView(true);
          }}
          onNavigateNews={() => {
            setShowAnnouncementsView(false);
            setShowNewsView(true);
          }}
          onNavigateAppointments={() => {
            setShowAnnouncementsView(false);
            setShowAppointmentsView(true);
          }}
          onNavigateEvents={() => {
            setShowAnnouncementsView(false);
            setShowEventsView(true);
          }}
          onNavigateParcelTracking={() => {
            setShowAnnouncementsView(false);
            setShowParcelTrackingView(true);
          }}
          enabledPages={enabledPages}
        />
      )}

      {/* Events View */}
      {showEventsView && (
        <EventsView
          onClose={() => setShowEventsView(false)}
          onNavigateHome={() => {
            setShowEventsView(false);
            setShowZapietView(true);
          }}
          onNavigateMessages={() => {
            setShowEventsView(false);
            setShowMessagesView(true);
          }}
          onNavigateStatus={() => {
            setShowEventsView(false);
            setShowStatusView(true);
          }}
          onNavigateFAQ={() => {
            setShowEventsView(false);
            setShowFAQView(true);
          }}
          onNavigateChangelog={() => {
            setShowEventsView(false);
            setShowChangelogView(true);
          }}
          onNavigateNews={() => {
            setShowEventsView(false);
            setShowNewsView(true);
          }}
          onNavigateAppointments={() => {
            setShowEventsView(false);
            setShowAppointmentsView(true);
          }}
          onNavigateAnnouncements={() => {
            setShowEventsView(false);
            setShowAnnouncementsView(true);
          }}
          onNavigateParcelTracking={() => {
            setShowEventsView(false);
            setShowParcelTrackingView(true);
          }}
          enabledPages={enabledPages}
        />
      )}

      {/* Parcel Tracking View */}
      {showParcelTrackingView && (
        <ParcelTrackingView
          onClose={() => setShowParcelTrackingView(false)}
          onNavigateHome={() => {
            setShowParcelTrackingView(false);
            setShowZapietView(true);
          }}
          onNavigateMessages={() => {
            setShowParcelTrackingView(false);
            setShowMessagesView(true);
          }}
          onNavigateStatus={() => {
            setShowParcelTrackingView(false);
            setShowStatusView(true);
          }}
          onNavigateFAQ={() => {
            setShowParcelTrackingView(false);
            setShowFAQView(true);
          }}
          onNavigateChangelog={() => {
            setShowParcelTrackingView(false);
            setShowChangelogView(true);
          }}
          onNavigateNews={() => {
            setShowParcelTrackingView(false);
            setShowNewsView(true);
          }}
          onNavigateAppointments={() => {
            setShowParcelTrackingView(false);
            setShowAppointmentsView(true);
          }}
          onNavigateAnnouncements={() => {
            setShowParcelTrackingView(false);
            setShowAnnouncementsView(true);
          }}
          onNavigateEvents={() => {
            setShowParcelTrackingView(false);
            setShowEventsView(true);
          }}
          enabledPages={enabledPages}
          companyLogoUrl={themeSettings?.companyLogoUrl}
        />
      )}

      {/* Zapiet Home View */}
      {showZapietView && !showMessagesView && !showStatusView && !showFAQView && !showChangelogView && !showNewsView && !showAppointmentsView && !showAnnouncementsView && !showEventsView && !showParcelTrackingView && (
        <ZapietHomeView
          onClose={() => setShowZapietView(false)}
          onBack={() => {
            setShowZapietView(false);
            setIsOpen(true);
          }}
          onOpenChat={openChatView}
          onOpenMessages={() => {
            setShowZapietView(false);
            setShowMessagesView(true);
          }}
          onOpenStatus={() => {
            setShowZapietView(false);
            setShowStatusView(true);
          }}
          onOpenFAQ={() => {
            setShowZapietView(false);
            setShowFAQView(true);
          }}
          onOpenChangelog={() => {
            setShowZapietView(false);
            setShowChangelogView(true);
          }}
          onOpenNews={() => {
            setShowZapietView(false);
            setShowNewsView(true);
          }}
          onOpenAppointments={() => {
            setShowZapietView(false);
            setShowAppointmentsView(true);
          }}
          onOpenAnnouncements={() => {
            setShowZapietView(false);
            setShowAnnouncementsView(true);
          }}
          onOpenEvents={() => {
            setShowZapietView(false);
            setShowEventsView(true);
          }}
          onOpenParcelTracking={() => {
            setShowZapietView(false);
            setShowParcelTrackingView(true);
          }}
          enabledPages={enabledPages}
        />
      )}

      {/* Chat Widget - Positioned above the launcher button */}
      {isOpen && !showZapietView && !showMessagesView && !showStatusView && !showFAQView && !showChangelogView && !showNewsView && !showAppointmentsView && !showAnnouncementsView && !showEventsView && !showParcelTrackingView && (
        <div
          className="fixed bottom-[90px] right-5 shadow-2xl flex flex-col z-[999999] overflow-hidden"
          style={{
            width: '400px',
            height: 'min(680px, 88vh)',
            boxShadow: '0 4px 24px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08)',
            maxWidth: 'calc(100vw - 40px)',
            backgroundColor: themeSettings?.backgroundColor || '#FFFFFF',
            borderRadius: themeSettings?.borderRadius || '16px',
            fontSize: themeSettings?.fontSize || undefined,
          }}
        >
          {/* Header Bar - shadcn/ui style */}
          <div className="flex items-center px-3 border-b border-gray-200 dark:border-border" style={{ height: '54px', backgroundColor: themeSettings?.headerColor || undefined }}>
            {/* Left side - Back arrow */}
            <div className="flex-1">
              <Button
                variant="ghost"
                onClick={() => {
                  if (!disableBackNavigation) {
                    setIsOpen(false);
                    setShowMessagesView(true);
                  }
                }}
                disabled={disableBackNavigation}
                className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 hover:bg-accent hover:text-accent-foreground h-7 w-7"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </div>

            {/* Center - Avatar and Name */}
            <div className="flex items-center gap-2">
              <img src="/assets/images/weldagent/avatar.png" alt="WeldAgent" className="flex-shrink-0" style={{ width: 24, height: 'auto' }} />
              <span className="font-medium text-sm text-gray-900 dark:text-foreground">WeldAgent</span>
            </div>

            {/* Right side - Talk to Human + Close buttons */}
            <div className="flex-1 flex justify-end gap-1">
              {/* Talk to a Human button - always visible when AI is enabled and not hidden */}
              {enableAi && !hideEscalationButton && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setShowEscalationSuggestion(true);
                    setEscalationReason('Customer requested to speak with a human agent');
                  }}
                  className="inline-flex items-center gap-1 justify-center rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring hover:bg-accent hover:text-accent-foreground px-2 h-7 border border-gray-300 dark:border-border text-gray-700 dark:text-muted-foreground"
                  title="Talk to a human agent"
                >
                  <UserCircle className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Talk to Human</span>
                </Button>
              )}

              <Button
                variant="ghost"
                onClick={() => !hideCloseButton && setIsOpen(false)}
                className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 hover:bg-accent hover:text-accent-foreground h-7 w-7"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>


          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 widget-scrollbar" style={{ backgroundColor: themeSettings?.chatBackgroundColor || undefined }}>
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "flex",
                  message.sender === 'user' ? 'justify-end' : 'justify-start'
                )}
              >
                <div
                  className="max-w-[85%] px-4 py-3 rounded-2xl"
                  style={{
                    backgroundColor: message.sender === 'user'
                      ? (themeSettings?.userBubbleColor || '#000000')
                      : (themeSettings?.agentBubbleColor || '#F5F5F5'),
                    color: message.sender === 'user'
                      ? (themeSettings?.userBubbleTextColor || '#FFFFFF')
                      : (themeSettings?.agentBubbleTextColor || '#000000'),
                    borderBottomLeftRadius: message.sender === 'agent' ? '4px' : '16px',
                    borderBottomRightRadius: message.sender === 'user' ? '4px' : '16px',
                  }}
                >
                  <p className="text-sm whitespace-pre-wrap leading-relaxed break-words">
                    {message.content}
                  </p>
                </div>
              </div>
            ))}

            {/* Typing indicator */}
            {isTyping && (
              <div className="flex justify-start">
                <div className="px-4 py-4 rounded-2xl" style={{ backgroundColor: themeSettings?.agentBubbleColor || '#F5F5F5', borderBottomLeftRadius: '4px' }}>
                  <div className="flex space-x-1">
                    <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" />
                    <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }} />
                    <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
                  </div>
                </div>
              </div>
            )}

            {/* Escalation Suggestion */}
            {showEscalationSuggestion && (
              <div className="flex flex-col gap-1.5 items-start max-w-[85%]">
                <div className="bg-gray-100 dark:bg-secondary text-[13px] text-gray-900 dark:text-foreground px-3.5 py-2.5 rounded-2xl" style={{ borderBottomLeftRadius: '4px' }}>
                  {escalationReason}
                </div>
                <div className="flex gap-1.5 mt-px">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (onEscalationRequested) {
                        onEscalationRequested(escalationReason);
                      }
                      aiConversation.addSystemMessage('Your request has been forwarded to our support team. A human agent will assist you shortly.');
                      setShowEscalationSuggestion(false);
                    }}
                    className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                  >
                    Connect to human
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setShowEscalationSuggestion(false)}
                    className="px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-muted-foreground border border-gray-200 dark:border-border rounded-lg hover:bg-gray-50 dark:hover:bg-secondary transition-colors"
                  >
                    Continue with AI
                  </Button>
                </div>
              </div>
            )}

            {/* Ticket Creation Suggestion */}
            {showTicketSuggestion && (
              <div className="flex justify-start">
                <div className="max-w-[85%] bg-amber-50 dark:bg-background/30 border border-amber-200 dark:border-border px-4 py-3 rounded-2xl" style={{ borderBottomLeftRadius: '4px' }}>
                  <p className="text-sm text-amber-900 dark:text-foreground font-medium mb-2">
                    Create a support ticket?
                  </p>
                  <p className="text-xs text-amber-700 dark:text-muted-foreground mb-3">
                    This will create a ticket so our team can investigate and follow up with you.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        if (onTicketCreationRequested) {
                          onTicketCreationRequested({
                            conversationId: aiConversation.conversationId,
                            messages: aiConversation.messages,
                          });
                        }
                        setShowTicketSuggestion(false);
                      }}
                      className="px-3 py-1.5 bg-amber-600 dark:bg-secondary text-white text-xs font-medium rounded-lg hover:bg-amber-700 dark:hover:bg-accent transition-colors"
                    >
                      Create ticket
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setShowTicketSuggestion(false)}
                      className="px-3 py-1.5 bg-white dark:bg-background text-gray-700 dark:text-muted-foreground text-xs font-medium rounded-lg border border-gray-300 dark:border-border hover:bg-gray-50 dark:hover:bg-background/50 transition-colors"
                    >
                      Not now
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* Scroll anchor */}
            <div ref={messagesEndRef} />
          </div>

          {/* Input Bar - Clean minimal design */}
          <div className="px-4 pb-[18px] pt-2">
            <div
              className={cn(
                "bg-white dark:bg-background border border-gray-200 dark:border-border transition-all duration-150",
                isMultiLine
                  ? "flex flex-col rounded-[16px] px-4 pt-3 pb-2.5"
                  : "flex items-center gap-3 rounded-full pl-4 pr-2.5 py-2.5"
              )}
            >
              <textarea
                ref={inputRef}
                value={inputValue}
                onChange={(e) => {
                  const newValue = e.target.value;
                  setInputValue(newValue);

                  // If value is empty or very short, switch back to single line
                  if (!newValue || newValue.length === 0) {
                    setIsMultiLine(false);
                    if (inputRef.current) {
                      inputRef.current.style.height = '20px';
                      inputRef.current.style.overflowY = 'hidden';
                    }
                  }
                }}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="Type a message..."
                rows={1}
                className={cn(
                  "outline-none bg-transparent text-[14px] text-gray-900 dark:text-foreground placeholder:text-gray-400 dark:placeholder:text-gray-500 resize-none",
                  isMultiLine ? "w-full input-scrollbar-subtle" : "flex-1"
                )}
                style={isMultiLine ? {
                  lineHeight: '22px',
                  minHeight: '44px',
                  maxHeight: '100px',
                  overflowY: 'auto',
                } : {
                  lineHeight: '20px',
                  height: '20px',
                  overflowY: 'hidden',
                }}
                onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  const hasNewline = target.value.includes('\n');

                  // Temporarily measure the natural height
                  target.style.height = 'auto';
                  const naturalHeight = target.scrollHeight;

                  if (isMultiLine) {
                    // Check if we should switch back to single line
                    if (naturalHeight <= 28 && !hasNewline) {
                      setIsMultiLine(false);
                      target.style.height = '20px';
                      target.style.overflowY = 'hidden';
                    } else {
                      // Stay in multi-line mode
                      target.style.height = Math.min(naturalHeight, 100) + 'px';
                      target.style.overflowY = naturalHeight > 100 ? 'auto' : 'hidden';
                    }
                  } else {
                    // Check if we should switch to multi-line
                    if (naturalHeight > 28 || hasNewline) {
                      setIsMultiLine(true);
                      target.style.height = Math.min(naturalHeight, 100) + 'px';
                      target.style.overflowY = naturalHeight > 100 ? 'auto' : 'hidden';
                    } else {
                      // Stay in single line mode
                      target.style.height = '20px';
                    }
                  }
                }}
              />

              {/* Send button - position changes based on layout */}
              {isMultiLine ? (
                <div className="flex justify-end mt-2">
                  <Button
                    variant="ghost"
                    onClick={handleSend}
                    aria-label="Send message"
                    disabled={!inputValue.trim()}
                    className={cn(
                      "w-[30px] h-[30px] rounded-full flex items-center justify-center transition-all duration-150 flex-shrink-0",
                      !inputValue.trim() && 'bg-[#E5E5E5] cursor-default',
                      inputValue.trim() && !themeSettings?.buttonColor && 'bg-black cursor-pointer',
                      inputValue.trim() && themeSettings?.buttonColor && 'cursor-pointer'
                    )}
                    style={inputValue.trim() ? {
                      backgroundColor: themeSettings?.buttonColor || undefined,
                    } : undefined}
                  >
                    <ArrowUp
                      size={18}
                      strokeWidth={2}
                      style={inputValue.trim() ? { color: themeSettings?.buttonTextColor || '#FFFFFF' } : undefined}
                      className={inputValue.trim() ? (themeSettings?.buttonTextColor ? '' : 'text-white') : 'text-gray-400'}
                    />
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  onClick={handleSend}
                  aria-label="Send message"
                  disabled={!inputValue.trim()}
                  className={cn(
                    "w-[30px] h-[30px] rounded-full flex items-center justify-center transition-all duration-150 flex-shrink-0",
                    !inputValue.trim() && 'bg-[#E5E5E5] cursor-default',
                    inputValue.trim() && !themeSettings?.buttonColor && 'bg-black cursor-pointer',
                    inputValue.trim() && themeSettings?.buttonColor && 'cursor-pointer'
                  )}
                  style={inputValue.trim() ? {
                    backgroundColor: themeSettings?.buttonColor || undefined,
                  } : undefined}
                >
                  <ArrowUp
                    size={18}
                    strokeWidth={2}
                    style={inputValue.trim() ? { color: themeSettings?.buttonTextColor || '#FFFFFF' } : undefined}
                    className={inputValue.trim() ? (themeSettings?.buttonTextColor ? '' : 'text-white') : 'text-gray-400'}
                  />
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Custom scrollbar styles */}
      <style>{`
        .widget-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .widget-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .widget-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(0, 0, 0, 0.05);
          border-radius: 3px;
        }
        .widget-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(0, 0, 0, 0.1);
        }
        .widget-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: rgba(0, 0, 0, 0.05) transparent;
        }
        :global(.dark) .widget-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
        }
        :global(.dark) .widget-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }

        .input-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .input-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .input-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(0, 0, 0, 0.05);
          border-radius: 3px;
        }
        .input-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(0, 0, 0, 0.1);
        }
        .input-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: rgba(0, 0, 0, 0.05) transparent;
        }
        :global(.dark) .input-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
        }
        :global(.dark) .input-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }

        .input-scrollbar-subtle::-webkit-scrollbar {
          width: 4px;
        }
        .input-scrollbar-subtle::-webkit-scrollbar-track {
          background: transparent;
        }
        .input-scrollbar-subtle::-webkit-scrollbar-thumb {
          background: rgba(0, 0, 0, 0.08);
          border-radius: 2px;
        }
        .input-scrollbar-subtle::-webkit-scrollbar-thumb:hover {
          background: rgba(0, 0, 0, 0.15);
        }
        .input-scrollbar-subtle {
          scrollbar-width: thin;
          scrollbar-color: rgba(0, 0, 0, 0.08) transparent;
        }
        :global(.dark) .input-scrollbar-subtle::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.08);
        }
        :global(.dark) .input-scrollbar-subtle::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.15);
        }
      `}</style>
    </>
  );
}