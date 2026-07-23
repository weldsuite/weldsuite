import { useState, useEffect } from 'react';
import {
  X,
  ChevronRight,
  Home,
  MessageSquare,
  HelpCircle,
  Activity,
  Search,
  Clock,
  Calendar,
  FileText,
  Sparkles,
  Megaphone,
  Package,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { subtleScrollbarStyles, subtleScrollbarCSS } from '@/lib/utils/scrollbar-styles';
import { getStoredConversationIds, removeConversationId } from '@/lib/utils/conversation-storage';
import { platformApi } from '@/lib/api/client';
import { useMobileDetection, useViewportHeight } from '@/hooks';

interface MessagesViewProps {
  widgetId?: string;
  onClose: () => void;
  onOpenChat: () => void;
  onSelectConversation?: (conversationId: string) => void;
  onNavigateHome?: () => void;
  onNavigateStatus?: () => void;
  onNavigateFAQ?: () => void;
  onNavigateChangelog?: () => void;
  onNavigateNews?: () => void;
  onNavigateFeedback?: () => void;
  onNavigateAppointments?: () => void;
  onNavigateAnnouncements?: () => void;
  onNavigateEvents?: () => void;
  onNavigateParcelTracking?: () => void;
  enabledPages?: string[];
  isEntering?: boolean;
}

export function MessagesView({ widgetId, onClose, onOpenChat, onSelectConversation, onNavigateHome, onNavigateStatus, onNavigateFAQ, onNavigateChangelog, onNavigateNews, onNavigateFeedback, onNavigateAppointments, onNavigateAnnouncements, onNavigateEvents, onNavigateParcelTracking, enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'news', 'feedback', 'appointments', 'announcements', 'events', 'parcel-tracking'], isEntering }: MessagesViewProps) {
  const [activeTab] = useState('messages');
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [conversations, setConversations] = useState<Array<{ id: string; status: string; subject?: string; lastMessage?: string; lastMessageAt?: string | null; createdAt?: string | null; messageCount?: number; assigneeName?: string; customerName?: string }>>([]);
  const [loading, setLoading] = useState(true);

  // Detect if we're embedded in an iframe (SDK mode)
  const [isEmbedded, setIsEmbedded] = useState(false);
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

  // Determine if we should use full-screen mode
  const isFullScreen = isEmbedded || isMobile;

  // Load conversations from API
  useEffect(() => {
    async function loadConversations() {
      if (!widgetId) {
        setLoading(false);
        return;
      }

      setLoading(true);
      const conversationIds = getStoredConversationIds(widgetId);

      if (conversationIds.length === 0) {
        // No conversations - show empty state instead of redirecting
        setLoading(false);
        return;
      }

      // Bulk fetch all conversations from DB in one call
      const { success: ok, conversations: fetched } = await platformApi.getConversationsBulk(conversationIds);

      if (!ok) {
        setLoading(false);
        return;
      }

      // Clean up stale IDs that no longer exist in DB
      const fetchedIds = new Set(fetched.map((c) => c.id));
      for (const id of conversationIds) {
        if (!fetchedIds.has(id)) removeConversationId(widgetId, id);
      }

      // Sort by most recent first
      fetched.sort((a, b) => {
        const dateA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : new Date(a.createdAt || 0).getTime();
        const dateB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : new Date(b.createdAt || 0).getTime();
        return dateB - dateA;
      });

      setConversations(fetched);
      setLoading(false);
    }

    loadConversations();
  }, [widgetId]);

  // Format date helper
  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'No messages';

    const now = new Date();
    const date = new Date(dateString);
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
    return `${Math.floor(diffDays / 30)}mo ago`;
  };

  // Convert conversations to message format for display
  const allMessages = conversations.map(conv => ({
    id: conv.id,
    title: conv.subject || 'Conversation',
    preview: conv.lastMessage || 'No messages yet',
    time: formatDate(conv.lastMessageAt || conv.createdAt || null),
    status: conv.status,
    isClosed: conv.status === 'closed' || conv.status === 'resolved',
  }));

  const messages = searchQuery
    ? allMessages.filter(msg =>
        msg.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        msg.preview.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : allMessages;

  const emptyState = allMessages.length === 0;
  const noSearchResults = searchQuery && messages.length === 0;

  // Container styles for embedded/mobile vs standalone desktop mode
  // In embedded mode, SDK container handles border and shadow
  const containerStyles: React.CSSProperties = isFullScreen
    ? {
        // Embedded mode (mobile or desktop): fill entire iframe
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100%',
        height: '100%',
      }
    : {
        // Desktop standalone: floating widget with own border/shadow
        width: '400px',
        height: 'min(680px, 88vh)',
        borderRadius: '16px',
        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08)',
        border: '1px solid rgba(0, 0, 0, 0.1)',
      };

  return (
    <div
      className={cn(
        'flex flex-col bg-white overflow-hidden',
        !isFullScreen && 'fixed bottom-[90px] right-5 z-[999999]'
      )}
      style={containerStyles}
    >
      <div className={cn('flex flex-col flex-1 min-h-0', isEntering && 'view-enter-back')}>
      {/* Header Bar */}
      <div
        className="flex items-center justify-between bg-white relative"
        style={{
          height: '54px',
          padding: '0 16px',
          borderBottom: '1px solid #E5E7EB',
          borderTopLeftRadius: isMobile ? '0' : '16px',
          borderTopRightRadius: isMobile ? '0' : '16px'
        }}
      >
        {/* Left spacer for balance */}
        <div className="w-8"></div>

        {/* Centered Title */}
        <h2
          className="text-gray-900 absolute left-1/2 transform -translate-x-1/2"
          style={{
            fontSize: '16px',
            fontWeight: 560,
            letterSpacing: '-0.01em'
          }}
        >
          Messages
        </h2>

        {/* Close button */}
        <button
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 transition-all duration-150"
          style={{ marginRight: '-6px', borderRadius: '10px' }}
          aria-label="Close"
        >
          <X
            className="h-4 w-4 text-gray-600"
          />
        </button>
      </div>

      {/* Messages List */}
      <style dangerouslySetInnerHTML={{ __html: subtleScrollbarCSS }} />
      <div className="flex-1 overflow-y-auto bg-white subtle-scrollbar" style={subtleScrollbarStyles}>
        {/* Search Bar - Exact same design as Help Page - Only shows when search button is clicked */}
        {showSearch && (
          <div className="bg-white" style={{ padding: '16px 16px 0 16px' }}>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search conversations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                autoFocus
                className={cn(
                  "w-full pl-9 pr-3 py-2 bg-gray-50 rounded-md text-sm",
                  "placeholder:text-gray-400 transition-all duration-200",
                  "focus:outline-none focus:bg-white focus:ring-1 focus:ring-gray-300",
                  searchFocused && "bg-white ring-1 ring-gray-300"
                )}
              />
            </div>
          </div>
        )}

        {loading ? (
          <div className="px-4 pt-3 space-y-3 animate-pulse">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex items-center gap-3 py-3">
                <div className="w-10 h-10 rounded-full bg-gray-100 flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 bg-gray-100 rounded w-3/4" />
                  <div className="h-3 bg-gray-100 rounded w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : emptyState ? (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center" style={{ marginTop: '-40px' }}>
            <div className="relative mb-6" style={{ width: 180, height: 130 }}>
              <svg className="absolute inset-0 w-full h-full" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <pattern id="empty-grid" width="28" height="28" patternUnits="userSpaceOnUse">
                    <path d="M 28 0 L 0 0 0 28" fill="none" stroke="currentColor" strokeWidth="0.5" strokeDasharray="3 3" className="text-gray-200" />
                  </pattern>
                </defs>
                <rect width="100%" height="100%" fill="url(#empty-grid)" />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
                  {/* Speech bubble */}
                  <path d="M30 24h62a8 8 0 018 8v36a8 8 0 01-8 8H52l-10 10v-10h-12a8 8 0 01-8-8V32a8 8 0 018-8z" className="fill-white" />
                  <path d="M30 24h62a8 8 0 018 8v36a8 8 0 01-8 8H52l-10 10v-10h-12a8 8 0 01-8-8V32a8 8 0 018-8z" className="stroke-gray-200" strokeWidth="1" />
                  {/* Text lines */}
                  <rect x="34" y="40" width="52" height="3" rx="1.5" className="fill-gray-100" />
                  <rect x="34" y="48" width="38" height="3" rx="1.5" className="fill-gray-100" />
                  <rect x="34" y="56" width="24" height="3" rx="1.5" className="fill-gray-100" />
                </svg>
              </div>
            </div>
            <h3 className="text-[15px] font-semibold text-gray-900 mb-1.5">
              No conversations yet
            </h3>
            <p className="text-sm text-gray-500 max-w-[320px] leading-relaxed">
              Start a new conversation with our support team
            </p>
          </div>
        ) : noSearchResults ? (
          <div className="flex flex-col items-center justify-center h-full px-8 text-center">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
              <Search size={28} className="text-gray-400" strokeWidth={1.5} />
            </div>
            <h3 className="text-gray-900 font-semibold text-base mb-2">
              No results found
            </h3>
            <p className="text-gray-500 text-sm leading-relaxed">
              Try searching with different keywords
            </p>
          </div>
        ) : (
          <div style={{ paddingBottom: '16px' }}>
            {messages.map((message, index) => (
              <div key={message.id} style={{ margin: '0 16px' }}>
                <button
                  onClick={() => onSelectConversation ? onSelectConversation(message.id) : onOpenChat()}
                  className="w-full text-left hover:bg-gray-50 transition-all duration-150 flex items-center justify-between group"
                  style={{
                    padding: '14px 0',
                    margin: '0 -16px',
                    paddingLeft: '16px',
                    paddingRight: '16px',
                    width: 'calc(100% + 32px)'
                  }}
                >
                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className={cn('truncate', message.isClosed ? 'text-gray-400' : 'text-gray-900')}
                        style={{
                          fontSize: '14px',
                          lineHeight: '1.5',
                          fontWeight: 480
                        }}>
                        {message.preview}
                      </p>
                      {message.isClosed && (
                        <span className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
                          {message.status === 'resolved' ? 'Resolved' : 'Closed'}
                        </span>
                      )}
                    </div>
                    <span className="text-gray-500 mt-1 inline-block"
                      style={{
                        fontSize: '12px'
                      }}>
                      {message.title} · {message.time}
                    </span>
                  </div>

                  {/* Arrow */}
                  <ChevronRight
                    size={18}
                    className="text-gray-400 flex-shrink-0 ml-3"
                  />
                </button>
                {index < messages.length - 1 && (
                  <div style={{ borderBottom: '1px solid #E5E7EB' }} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer CTA - "Send us a message" - floating */}
      {!loading && (
        <div
          className="absolute left-0 right-0 flex justify-center pointer-events-none"
          style={{
            bottom: '16px'
          }}
        >
          <button
            onClick={onOpenChat}
            className="flex items-center justify-center gap-2 bg-gray-900 hover:bg-black text-white transition-all duration-200 px-5 pointer-events-auto shadow-lg"
            style={{
              height: '40px',
              borderRadius: '12px',
              fontSize: '14px',
              fontWeight: 500,
              letterSpacing: '-0.01em'
            }}
          >
            <span style={{ marginTop: '-1px' }}>Send new message</span>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
              <path d="M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z" />
            </svg>
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
