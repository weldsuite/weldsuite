
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
import type { WidgetThemeSettings } from './widget-customization-panel';
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

// The widget shows at most one full-page view at a time. Each view maps to a
// `onNavigate*` prop name on the view components (a view never links to itself).
const NAVIGATE_PROP_BY_VIEW = {
  home: 'onNavigateHome',
  messages: 'onNavigateMessages',
  status: 'onNavigateStatus',
  faq: 'onNavigateFAQ',
  changelog: 'onNavigateChangelog',
  news: 'onNavigateNews',
  appointments: 'onNavigateAppointments',
  announcements: 'onNavigateAnnouncements',
  events: 'onNavigateEvents',
  'parcel-tracking': 'onNavigateParcelTracking',
} as const;

type WidgetView = keyof typeof NAVIGATE_PROP_BY_VIEW;
type NavigateHandlers = Partial<Record<(typeof NAVIGATE_PROP_BY_VIEW)[WidgetView], () => void>>;

const WIDGET_VIEWS = Object.keys(NAVIGATE_PROP_BY_VIEW) as WidgetView[];

// `themeSettings.startingPage` value -> view it opens
const STARTING_PAGE_VIEWS = new Map<string, WidgetView>([
  ['home', 'home'],
  ['messages', 'messages'],
  ['help', 'faq'],
  ['status', 'status'],
  ['changelog', 'changelog'],
  ['news', 'news'],
  ['appointments', 'appointments'],
  ['announcements', 'announcements'],
  ['events', 'events'],
  ['parcel-tracking', 'parcel-tracking'],
]);

function getInitialView(startingPage: string, defaultOpen: boolean, disableBackNavigation: boolean): WidgetView | null {
  if (!defaultOpen || disableBackNavigation) return null;
  return STARTING_PAGE_VIEWS.get(startingPage) ?? null;
}

function buildNavigateHandlers(current: WidgetView, goTo: (view: WidgetView) => void): NavigateHandlers {
  const handlers: NavigateHandlers = {};
  for (const view of WIDGET_VIEWS) {
    if (view !== current) handlers[NAVIGATE_PROP_BY_VIEW[view]] = () => goTo(view);
  }
  return handlers;
}

// Display messages: AI conversation when AI is enabled and has messages, otherwise the greeting (if set)
function buildDisplayMessages(enableAi: boolean, aiMessages: ConversationMessage[], welcomeMessage?: string): Message[] {
  if (enableAi && aiMessages.length > 0) return aiMessages.map((msg) => toDisplayMessage(msg));
  const welcomeText = welcomeMessage?.trim();
  if (!welcomeText) return [];
  return [{
    id: 'greeting-1',
    content: welcomeText,
    sender: 'agent',
    timestamp: new Date(),
  }];
}

function setTextareaHeight(textarea: HTMLTextAreaElement | null, height: string) {
  if (!textarea) return;
  textarea.style.height = height;
  textarea.style.overflowY = 'hidden';
}

function fitTextareaToContent(textarea: HTMLTextAreaElement, naturalHeight: number) {
  textarea.style.height = Math.min(naturalHeight, 100) + 'px';
  textarea.style.overflowY = naturalHeight > 100 ? 'auto' : 'hidden';
}

type WidgetChatOptions = Pick<
  ExactIntercomWidgetProps,
  | 'customerEmail'
  | 'customerName'
  | 'previewSystemInstructions'
  | 'previewKnowledgePermissions'
  | 'previewWelcomeMessage'
  | 'onEscalationRequested'
  | 'onTicketCreationRequested'
> & {
  enableAi: boolean;
  allowHumanEscalation: boolean;
};

// Chat state: AI conversation, composer input, escalation / ticket suggestions
function useWidgetChat({
  enableAi,
  allowHumanEscalation,
  customerEmail,
  customerName,
  previewSystemInstructions,
  previewKnowledgePermissions,
  previewWelcomeMessage,
  onEscalationRequested,
  onTicketCreationRequested,
}: WidgetChatOptions) {
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

  const [showEscalationSuggestion, setShowEscalationSuggestion] = useState(false);
  const [escalationReason, setEscalationReason] = useState('');
  const [showTicketSuggestion, setShowTicketSuggestion] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [isMultiLine, setIsMultiLine] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const messages = buildDisplayMessages(enableAi, aiConversation.messages, previewWelcomeMessage);
  // Use isLoading from AI conversation for typing indicator
  const isTyping = enableAi && aiConversation.isSendingMessage;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Sync textarea height when switching between single/multi-line modes
  useEffect(() => {
    if (!isMultiLine) setTextareaHeight(inputRef.current, '20px');
  }, [isMultiLine]);

  const suggestEscalation = (reason: string) => {
    setEscalationReason(reason);
    setShowEscalationSuggestion(true);
  };

  const suggestEscalationIfAllowed = (reason: string) => {
    if (allowHumanEscalation) suggestEscalation(reason);
  };

  // Check the last assistant message for escalation/ticket markers
  const inspectAssistantReply = (lastMessage: ConversationMessage | undefined) => {
    if (!lastMessage || lastMessage.role !== 'assistant') return;

    const aiEscalation = detectEscalation(lastMessage.content, 'assistant');
    if (aiEscalation.shouldEscalate) {
      suggestEscalationIfAllowed(aiEscalation.reason || 'AI determined it cannot help');
    }

    const ticketSuggestion = detectTicketSuggestion(lastMessage.content, 'assistant');
    if (ticketSuggestion.shouldCreateTicket) {
      setShowTicketSuggestion(true);
    }
  };

  const handleSend = async () => {
    if (!inputValue.trim()) return;

    const userMessageContent = inputValue;
    setInputValue('');
    setIsMultiLine(false);
    setTextareaHeight(inputRef.current, '22px');

    // Scroll to bottom after sending message
    setTimeout(() => scrollToBottom(), 100);

    // Check if user is requesting human help (the message is still sent to the AI for context)
    const userEscalation = detectEscalation(userMessageContent, 'user');
    if (userEscalation.shouldEscalate) {
      suggestEscalationIfAllowed(userEscalation.reason || 'Customer requested human assistance');
    }

    if (!enableAi) {
      // AI is disabled and there is no mock responder, so just offer the escalation option
      suggestEscalationIfAllowed('AI assistant is not enabled. Would you like to speak with a human agent?');
      return;
    }

    try {
      // sendMessage adds the user message and streams the response
      await aiConversation.sendMessage(userMessageContent);

      // Check in a timeout to allow the state to update
      setTimeout(() => {
        inspectAssistantReply(aiConversation.messages.at(-1));
      }, 500);
    } catch (error) {
      console.error('Error sending message:', error);
      // Error handling is done by the hook via aiConversation.error
      suggestEscalationIfAllowed('Connection error - would you like to speak with a human agent?');
    }
  };

  const handleInputChange = (newValue: string) => {
    setInputValue(newValue);

    // If value is empty, switch back to single line
    if (!newValue) {
      setIsMultiLine(false);
      setTextareaHeight(inputRef.current, '20px');
    }
  };

  const handleTextareaInput = (textarea: HTMLTextAreaElement) => {
    const hasNewline = textarea.value.includes('\n');

    // Temporarily measure the natural height
    textarea.style.height = 'auto';
    const naturalHeight = textarea.scrollHeight;
    const needsMultiLine = naturalHeight > 28 || hasNewline;

    if (needsMultiLine) {
      if (!isMultiLine) setIsMultiLine(true);
      fitTextareaToContent(textarea, naturalHeight);
      return;
    }
    if (isMultiLine) {
      setIsMultiLine(false);
      setTextareaHeight(textarea, '20px');
      return;
    }
    textarea.style.height = '20px';
  };

  const requestHuman = () => {
    suggestEscalation('Customer requested to speak with a human agent');
  };

  const connectToHuman = () => {
    onEscalationRequested?.(escalationReason);
    aiConversation.addSystemMessage('Your request has been forwarded to our support team. A human agent will assist you shortly.');
    setShowEscalationSuggestion(false);
  };

  const dismissEscalation = () => setShowEscalationSuggestion(false);

  const createTicket = () => {
    onTicketCreationRequested?.({
      conversationId: aiConversation.conversationId,
      messages: aiConversation.messages,
    });
    setShowTicketSuggestion(false);
  };

  const dismissTicket = () => setShowTicketSuggestion(false);

  return {
    messages,
    isTyping,
    inputValue,
    isMultiLine,
    inputRef,
    messagesEndRef,
    showEscalationSuggestion,
    escalationReason,
    showTicketSuggestion,
    handleSend,
    handleInputChange,
    handleTextareaInput,
    requestHuman,
    connectToHuman,
    dismissEscalation,
    createTicket,
    dismissTicket,
  };
}

type WidgetChat = ReturnType<typeof useWidgetChat>;

interface WidgetViewHostProps {
  view: WidgetView | null;
  enabledPages: string[];
  themeSettings?: WidgetThemeSettings;
  hideCloseButton: boolean;
  onClose: () => void;
  onNavigate: (view: WidgetView) => void;
  onOpenChat: () => void;
}

// Renders whichever full-page view is active
function WidgetViewHost({
  view,
  enabledPages,
  themeSettings,
  hideCloseButton,
  onClose,
  onNavigate,
  onOpenChat,
}: WidgetViewHostProps) {
  if (!view) return null;

  const common = { onClose, enabledPages, ...buildNavigateHandlers(view, onNavigate) };

  switch (view) {
    case 'messages':
      return <MessagesView {...common} onOpenChat={onOpenChat} themeSettings={themeSettings} hideCloseButton={hideCloseButton} />;
    case 'status':
      return <StatusView {...common} />;
    case 'faq':
      return <FAQView {...common} />;
    case 'changelog':
      return <ChangelogView {...common} />;
    case 'news':
      return <NewsView {...common} />;
    case 'appointments':
      return <AppointmentsView {...common} />;
    case 'announcements':
      return <AnnouncementsView {...common} />;
    case 'events':
      return <EventsView {...common} />;
    case 'parcel-tracking':
      return <ParcelTrackingView {...common} companyLogoUrl={themeSettings?.companyLogoUrl} />;
    case 'home':
      return (
        <ZapietHomeView
          onClose={onClose}
          onBack={onOpenChat}
          onOpenChat={onOpenChat}
          onOpenMessages={() => onNavigate('messages')}
          onOpenStatus={() => onNavigate('status')}
          onOpenFAQ={() => onNavigate('faq')}
          onOpenChangelog={() => onNavigate('changelog')}
          onOpenNews={() => onNavigate('news')}
          onOpenAppointments={() => onNavigate('appointments')}
          onOpenAnnouncements={() => onNavigate('announcements')}
          onOpenEvents={() => onNavigate('events')}
          onOpenParcelTracking={() => onNavigate('parcel-tracking')}
          enabledPages={enabledPages}
        />
      );
    default:
      return null;
  }
}

const HEADER_BUTTON_CLASS = 'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 hover:bg-accent hover:text-accent-foreground h-7 w-7';

interface ChatHeaderProps {
  themeSettings?: WidgetThemeSettings;
  disableBackNavigation: boolean;
  showTalkToHuman: boolean;
  onBack: () => void;
  onTalkToHuman: () => void;
  onClose: () => void;
}

function ChatHeader({ themeSettings, disableBackNavigation, showTalkToHuman, onBack, onTalkToHuman, onClose }: ChatHeaderProps) {
  return (
    <div className="flex items-center px-3 border-b border-gray-200 dark:border-border" style={{ height: '54px', backgroundColor: themeSettings?.headerColor || undefined }}>
      {/* Left side - Back arrow */}
      <div className="flex-1">
        <Button
          variant="ghost"
          onClick={onBack}
          disabled={disableBackNavigation}
          className={HEADER_BUTTON_CLASS}
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
        {showTalkToHuman && (
          <Button
            variant="ghost"
            onClick={onTalkToHuman}
            className="inline-flex items-center gap-1 justify-center rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring hover:bg-accent hover:text-accent-foreground px-2 h-7 border border-gray-300 dark:border-border text-gray-700 dark:text-muted-foreground"
            title="Talk to a human agent"
          >
            <UserCircle className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Talk to Human</span>
          </Button>
        )}

        <Button
          variant="ghost"
          onClick={onClose}
          className={HEADER_BUTTON_CLASS}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function getBubbleStyle(sender: Message['sender'], themeSettings?: WidgetThemeSettings): React.CSSProperties {
  const isUser = sender === 'user';
  return {
    backgroundColor: isUser
      ? (themeSettings?.userBubbleColor || '#000000')
      : (themeSettings?.agentBubbleColor || '#F5F5F5'),
    color: isUser
      ? (themeSettings?.userBubbleTextColor || '#FFFFFF')
      : (themeSettings?.agentBubbleTextColor || '#000000'),
    borderBottomLeftRadius: isUser ? '16px' : '4px',
    borderBottomRightRadius: isUser ? '4px' : '16px',
  };
}

function MessageBubble({ message, themeSettings }: { message: Message; themeSettings?: WidgetThemeSettings }) {
  return (
    <div
      className={cn(
        "flex",
        message.sender === 'user' ? 'justify-end' : 'justify-start'
      )}
    >
      <div
        className="max-w-[85%] px-4 py-3 rounded-2xl"
        style={getBubbleStyle(message.sender, themeSettings)}
      >
        <p className="text-sm whitespace-pre-wrap leading-relaxed break-words">
          {message.content}
        </p>
      </div>
    </div>
  );
}

function TypingIndicator({ themeSettings }: { themeSettings?: WidgetThemeSettings }) {
  return (
    <div className="flex justify-start">
      <div className="px-4 py-4 rounded-2xl" style={{ backgroundColor: themeSettings?.agentBubbleColor || '#F5F5F5', borderBottomLeftRadius: '4px' }}>
        <div className="flex space-x-1">
          <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" />
          <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }} />
          <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
        </div>
      </div>
    </div>
  );
}

interface EscalationSuggestionProps {
  reason: string;
  onConnect: () => void;
  onDismiss: () => void;
}

function EscalationSuggestion({ reason, onConnect, onDismiss }: EscalationSuggestionProps) {
  return (
    <div className="flex flex-col gap-1.5 items-start max-w-[85%]">
      <div className="bg-gray-100 dark:bg-secondary text-[13px] text-gray-900 dark:text-foreground px-3.5 py-2.5 rounded-2xl" style={{ borderBottomLeftRadius: '4px' }}>
        {reason}
      </div>
      <div className="flex gap-1.5 mt-px">
        <Button
          variant="ghost"
          onClick={onConnect}
          className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          Connect to human
        </Button>
        <Button
          variant="ghost"
          onClick={onDismiss}
          className="px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-muted-foreground border border-gray-200 dark:border-border rounded-lg hover:bg-gray-50 dark:hover:bg-secondary transition-colors"
        >
          Continue with AI
        </Button>
      </div>
    </div>
  );
}

function TicketSuggestion({ onCreate, onDismiss }: { onCreate: () => void; onDismiss: () => void }) {
  return (
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
            onClick={onCreate}
            className="px-3 py-1.5 bg-amber-600 dark:bg-secondary text-white text-xs font-medium rounded-lg hover:bg-amber-700 dark:hover:bg-accent transition-colors"
          >
            Create ticket
          </Button>
          <Button
            variant="ghost"
            onClick={onDismiss}
            className="px-3 py-1.5 bg-white dark:bg-background text-gray-700 dark:text-muted-foreground text-xs font-medium rounded-lg border border-gray-300 dark:border-border hover:bg-gray-50 dark:hover:bg-background/50 transition-colors"
          >
            Not now
          </Button>
        </div>
      </div>
    </div>
  );
}

function ChatMessages({ chat, themeSettings }: { chat: WidgetChat; themeSettings?: WidgetThemeSettings }) {
  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3 widget-scrollbar" style={{ backgroundColor: themeSettings?.chatBackgroundColor || undefined }}>
      {chat.messages.map((message) => (
        <MessageBubble key={message.id} message={message} themeSettings={themeSettings} />
      ))}

      {/* Typing indicator */}
      {chat.isTyping && <TypingIndicator themeSettings={themeSettings} />}

      {/* Escalation Suggestion */}
      {chat.showEscalationSuggestion && (
        <EscalationSuggestion
          reason={chat.escalationReason}
          onConnect={chat.connectToHuman}
          onDismiss={chat.dismissEscalation}
        />
      )}

      {/* Ticket Creation Suggestion */}
      {chat.showTicketSuggestion && (
        <TicketSuggestion onCreate={chat.createTicket} onDismiss={chat.dismissTicket} />
      )}

      {/* Scroll anchor */}
      <div ref={chat.messagesEndRef} />
    </div>
  );
}

function getSendButtonStateClass(hasText: boolean, buttonColor?: string): string {
  if (!hasText) return 'bg-[#E5E5E5] cursor-default';
  if (!buttonColor) return 'bg-black cursor-pointer';
  return 'cursor-pointer';
}

function getSendIconClass(hasText: boolean, buttonTextColor?: string): string {
  if (!hasText) return 'text-gray-400';
  return buttonTextColor ? '' : 'text-white';
}

interface SendButtonProps {
  hasText: boolean;
  buttonColor?: string;
  buttonTextColor?: string;
  onSend: () => void;
}

function SendButton({ hasText, buttonColor, buttonTextColor, onSend }: SendButtonProps) {
  return (
    <Button
      variant="ghost"
      onClick={onSend}
      aria-label="Send message"
      disabled={!hasText}
      className={cn(
        "w-[30px] h-[30px] rounded-full flex items-center justify-center transition-all duration-150 flex-shrink-0",
        getSendButtonStateClass(hasText, buttonColor)
      )}
      style={hasText ? {
        backgroundColor: buttonColor || undefined,
      } : undefined}
    >
      <ArrowUp
        size={18}
        strokeWidth={2}
        style={hasText ? { color: buttonTextColor || '#FFFFFF' } : undefined}
        className={getSendIconClass(hasText, buttonTextColor)}
      />
    </Button>
  );
}

const MULTI_LINE_TEXTAREA_STYLE: React.CSSProperties = {
  lineHeight: '22px',
  minHeight: '44px',
  maxHeight: '100px',
  overflowY: 'auto',
};

const SINGLE_LINE_TEXTAREA_STYLE: React.CSSProperties = {
  lineHeight: '20px',
  height: '20px',
  overflowY: 'hidden',
};

function ChatInputBar({ chat, themeSettings }: { chat: WidgetChat; themeSettings?: WidgetThemeSettings }) {
  const { inputValue, isMultiLine } = chat;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void chat.handleSend();
    }
  };

  // Send button position changes based on layout
  const sendButton = (
    <SendButton
      hasText={!!inputValue.trim()}
      buttonColor={themeSettings?.buttonColor}
      buttonTextColor={themeSettings?.buttonTextColor}
      onSend={chat.handleSend}
    />
  );

  return (
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
          ref={chat.inputRef}
          value={inputValue}
          onChange={(e) => chat.handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          rows={1}
          className={cn(
            "outline-none bg-transparent text-[14px] text-gray-900 dark:text-foreground placeholder:text-gray-400 dark:placeholder:text-gray-500 resize-none",
            isMultiLine ? "w-full input-scrollbar-subtle" : "flex-1"
          )}
          style={isMultiLine ? MULTI_LINE_TEXTAREA_STYLE : SINGLE_LINE_TEXTAREA_STYLE}
          onInput={(e) => chat.handleTextareaInput(e.target as HTMLTextAreaElement)}
        />

        {isMultiLine ? (
          <div className="flex justify-end mt-2">{sendButton}</div>
        ) : (
          sendButton
        )}
      </div>
    </div>
  );
}

function getChatWindowStyle(themeSettings?: WidgetThemeSettings): React.CSSProperties {
  return {
    width: '400px',
    height: 'min(680px, 88vh)',
    boxShadow: '0 4px 24px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08)',
    maxWidth: 'calc(100vw - 40px)',
    backgroundColor: themeSettings?.backgroundColor || '#FFFFFF',
    borderRadius: themeSettings?.borderRadius || '16px',
    fontSize: themeSettings?.fontSize || undefined,
  };
}

interface ChatWindowProps {
  chat: WidgetChat;
  showTalkToHuman: boolean;
  disableBackNavigation: boolean;
  themeSettings?: WidgetThemeSettings;
  onBack: () => void;
  onClose: () => void;
}

// Chat Widget - Positioned above the launcher button
function ChatWindow({ chat, showTalkToHuman, disableBackNavigation, themeSettings, onBack, onClose }: ChatWindowProps) {
  return (
    <div
      className="fixed bottom-[90px] right-5 shadow-2xl flex flex-col z-[999999] overflow-hidden"
      style={getChatWindowStyle(themeSettings)}
    >
      <ChatHeader
        themeSettings={themeSettings}
        disableBackNavigation={disableBackNavigation}
        showTalkToHuman={showTalkToHuman}
        onBack={onBack}
        onTalkToHuman={chat.requestHuman}
        onClose={onClose}
      />
      <ChatMessages chat={chat} themeSettings={themeSettings} />
      <ChatInputBar chat={chat} themeSettings={themeSettings} />
    </div>
  );
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

  const chat = useWidgetChat({
    enableAi,
    allowHumanEscalation,
    customerEmail,
    customerName,
    previewSystemInstructions,
    previewKnowledgePermissions,
    previewWelcomeMessage,
    onEscalationRequested,
    onTicketCreationRequested,
  });

  const [isOpen, setIsOpen] = useState(disableBackNavigation && defaultOpen);
  const [activeView, setActiveView] = useState<WidgetView | null>(() =>
    getInitialView(startingPage, defaultOpen, disableBackNavigation)
  );

  const openChatView = () => {
    // Close all views and open chat
    setActiveView(null);
    setIsOpen(true);
  };

  const handleLauncherClick = () => {
    if (disableLauncherButton) return;
    if (activeView) {
      setActiveView(null);
      return;
    }
    // Open the starting page based on settings
    const startingView = STARTING_PAGE_VIEWS.get(startingPage);
    if (startingView) setActiveView(startingView);
    else setIsOpen(!isOpen);
  };

  const handleChatBack = () => {
    if (disableBackNavigation) return;
    setIsOpen(false);
    setActiveView('messages');
  };

  const handleChatClose = () => {
    if (!hideCloseButton) setIsOpen(false);
  };

  return (
    <>
      {/* Launcher Button - Always visible like Intercom */}
      <Button
        variant="ghost"
        onClick={handleLauncherClick}
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

      {/* Full-page views (messages, status, FAQ, ...) */}
      <WidgetViewHost
        view={activeView}
        enabledPages={enabledPages}
        themeSettings={themeSettings}
        hideCloseButton={hideCloseButton}
        onClose={() => setActiveView(null)}
        onNavigate={setActiveView}
        onOpenChat={openChatView}
      />

      {isOpen && activeView === null && (
        <ChatWindow
          chat={chat}
          showTalkToHuman={enableAi && !hideEscalationButton}
          disableBackNavigation={disableBackNavigation}
          themeSettings={themeSettings}
          onBack={handleChatBack}
          onClose={handleChatClose}
        />
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
