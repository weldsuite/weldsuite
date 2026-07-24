
import { useState } from 'react';
import {
  X,
  ChevronRight,
  Home,
  MessageSquare,
  HelpCircle,
  Activity,
  Plus,
  Search,
  Calendar,
  Sparkles,
  Megaphone,
  Package
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { subtleScrollbarStyles, subtleScrollbarCSS } from './scrollbar-styles';
import { Button } from '@weldsuite/ui/components/button';

interface WidgetThemeSettings {
  primaryColor?: string;
  backgroundColor?: string;
  textColor?: string;
  buttonColor?: string;
  buttonTextColor?: string;
  borderRadius?: string;
  fontSize?: string;
  launcherColor?: string;
  headerColor?: string;
  accentColor?: string;
  companyLogoUrl?: string;
  // Chat interface colors
  chatBackgroundColor?: string;
  userBubbleColor?: string;
  userBubbleTextColor?: string;
  agentBubbleColor?: string;
  agentBubbleTextColor?: string;
}

interface MessagesViewProps {
  onClose: () => void;
  onOpenChat: () => void;
  onNavigateHome?: () => void;
  onNavigateStatus?: () => void;
  onNavigateFAQ?: () => void;
  onNavigateChangelog?: () => void;
  onNavigateNews?: () => void;
  onNavigateAppointments?: () => void;
  onNavigateAnnouncements?: () => void;
  onNavigateEvents?: () => void;
  onNavigateParcelTracking?: () => void;
  enabledPages?: string[];
  themeSettings?: WidgetThemeSettings;
  hideCloseButton?: boolean;
}

export function MessagesView({
  onClose,
  onOpenChat,
  onNavigateHome,
  onNavigateStatus,
  onNavigateFAQ,
  onNavigateChangelog,
  onNavigateNews,
  onNavigateAppointments,
  onNavigateAnnouncements,
  onNavigateEvents,
  onNavigateParcelTracking,
  enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'appointments', 'announcements', 'events', 'news', 'parcel-tracking'],
  hideCloseButton = false
}: MessagesViewProps) {
  const [activeTab] = useState('messages');
  const [showSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);

  const allMessages = [
    {
      id: '1',
      title: 'Third',
      preview: 'Hi 👋 How can I help you?',
      time: '6 dagen geleden',
      unread: false
    },
    {
      id: '2', 
      title: 'Support',
      preview: 'Your issue has been resolved. Please check and confirm.',
      time: '2 weken geleden',
      unread: false
    },
    {
      id: '3',
      title: 'Billing',
      preview: 'Your invoice for this month is ready for review.',
      time: '1 maand geleden',
      unread: false
    }
  ];

  const messages = searchQuery 
    ? allMessages.filter(msg => 
        msg.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        msg.preview.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : allMessages;

  const emptyState = allMessages.length === 0;
  const noSearchResults = searchQuery && messages.length === 0;

  return (
    <div
      className="fixed bottom-[90px] right-5 flex flex-col bg-white dark:bg-background z-[999999] overflow-hidden"
      style={{
        width: '400px',
        height: 'min(680px, 88vh)',
        borderRadius: '16px',
        boxShadow: '0 16px 40px rgba(0,0,0,0.35)'
      }}
    >
      {/* Header Bar */}
      <div
        className="flex items-center justify-between relative border-b border-gray-200 dark:border-border bg-white dark:bg-background"
        style={{
          height: '52px',
          padding: '0 16px',
          borderTopLeftRadius: '16px',
          borderTopRightRadius: '16px',
        }}
      >
        {/* Left spacer for balance */}
        <div className="w-8"></div>

        {/* Centered Title */}
        <h2
          className="absolute left-1/2 transform -translate-x-1/2 text-gray-900 dark:text-foreground"
          style={{
            fontSize: '15px',
            fontWeight: 500,
            letterSpacing: '-0.01em',
          }}
        >
          Messages
        </h2>

        {/* Actions */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            onClick={() => !hideCloseButton && onClose()}
            className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-all duration-150 p-0"
            aria-label="Close"
          >
            <X
              size={18}
              strokeWidth={2}
              className="text-gray-500 dark:text-muted-foreground"
            />
          </Button>
        </div>
      </div>

      {/* Messages List */}
      <style dangerouslySetInnerHTML={{ __html: subtleScrollbarCSS }} />
      <div className="flex-1 overflow-y-auto bg-white dark:bg-background subtle-scrollbar" style={subtleScrollbarStyles}>
        {/* Search Bar - Exact same design as Help Page - Only shows when search button is clicked */}
        {showSearch && (
          <div className="bg-white dark:bg-background" style={{ padding: '16px 16px 0 16px' }}>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-muted-foreground" />
              <input
                type="text"
                placeholder="Search conversations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                autoFocus
                className={cn(
                  "w-full pl-9 pr-3 py-2 bg-gray-50 dark:bg-secondary rounded-md text-sm text-gray-900 dark:text-foreground",
                  "placeholder:text-gray-400 dark:placeholder:text-gray-500 transition-all duration-200",
                  "focus:outline-none focus:bg-white dark:focus:bg-gray-700 focus:ring-1 focus:ring-gray-300 dark:focus:ring-gray-600",
                  searchFocused && "bg-white dark:bg-accent ring-1 ring-gray-300 dark:ring-gray-600"
                )}
              />
            </div>
          </div>
        )}
        
        {emptyState ? (
          <div className="flex flex-col items-center justify-center h-full px-8 text-center">
            <div className="w-16 h-16 bg-gray-100 dark:bg-secondary rounded-full flex items-center justify-center mb-4">
              <MessageSquare size={28} className="text-gray-400 dark:text-muted-foreground" strokeWidth={1.5} />
            </div>
            <h3 className="text-gray-900 dark:text-foreground font-semibold text-base mb-2">
              No conversations yet
            </h3>
            <p className="text-gray-500 dark:text-muted-foreground text-sm leading-relaxed mb-6">
              Start a new conversation with our support team
            </p>
            <Button
              variant="ghost"
              onClick={onOpenChat}
              className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg transition-all duration-150 text-sm font-medium hover:bg-blue-700"
            >
              <Plus size={16} strokeWidth={2} />
              New conversation
            </Button>
          </div>
        ) : noSearchResults ? (
          <div className="flex flex-col items-center justify-center h-full px-8 text-center">
            <div className="w-16 h-16 bg-gray-100 dark:bg-secondary rounded-full flex items-center justify-center mb-4">
              <Search size={28} className="text-gray-400 dark:text-muted-foreground" strokeWidth={1.5} />
            </div>
            <h3 className="text-gray-900 dark:text-foreground font-semibold text-base mb-2">
              No results found
            </h3>
            <p className="text-gray-500 dark:text-muted-foreground text-sm leading-relaxed">
              Try searching with different keywords
            </p>
          </div>
        ) : (
          <div style={{ paddingBottom: '16px' }}>
            {messages.map((message, index) => (
              <div key={message.id}>
                {index > 0 && (
                  <div className="border-t border-gray-100 dark:border-border mx-4" />
                )}
                <Button
                  variant="ghost"
                  onClick={onOpenChat}
                  className="w-full text-left hover:bg-gray-50 dark:hover:bg-secondary/50 transition-all duration-150 flex items-center justify-between group h-auto"
                  style={{
                    padding: '14px 16px'
                  }}
                >
                  {/* Content - Simple text layout */}
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-900 dark:text-foreground truncate"
                      style={{
                        fontSize: '14px',
                        lineHeight: '1.5'
                      }}>
                      {message.preview}
                    </p>
                    <span className="text-gray-500 dark:text-muted-foreground mt-1 inline-block"
                      style={{
                        fontSize: '12px'
                      }}>
                      {message.title} · {message.time}
                    </span>
                  </div>

                  {/* Arrow */}
                  <ChevronRight
                    size={18}
                    className="text-gray-400 dark:text-muted-foreground flex-shrink-0 ml-3"
                  />
                </Button>
                {index === messages.length - 1 && (
                  <div className="border-t border-gray-100 dark:border-border mx-4" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer CTA - "Send new message" */}
      {!emptyState && (
        <div className="bg-white dark:bg-background p-4 flex justify-center">
          <Button
            variant="ghost"
            onClick={onOpenChat}
            className="h-10 w-[189px] flex items-center justify-center gap-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-[10px] text-sm font-medium transition-all duration-200 hover:bg-gray-800 dark:hover:bg-gray-200"
          >
            Send new message
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
              <path d="M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z" />
            </svg>
          </Button>
        </div>
      )}

      {/* Bottom Tab Bar with all navigation - Only show if more than 1 page is enabled */}
      {enabledPages.length > 1 && (
        <div
          className="bg-white dark:bg-background relative border-t border-gray-200 dark:border-border"
          style={{
            height: '60px',
            borderBottomLeftRadius: '16px',
            borderBottomRightRadius: '16px'
          }}
        >
          <div className="flex items-center h-full overflow-x-auto scrollbar-hide" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
            <div className="flex items-center min-w-full px-2">
              {[
                { id: 'home', icon: Home, label: 'Home', onClick: onNavigateHome },
                { id: 'messages', icon: MessageSquare, label: 'Chat', onClick: () => {} },
                { id: 'help', icon: HelpCircle, label: 'Help', onClick: onNavigateFAQ },
                { id: 'status', icon: Activity, label: 'Status', onClick: onNavigateStatus },
                { id: 'changelog', icon: Sparkles, label: 'Changelog', onClick: onNavigateChangelog },
                { id: 'news', icon: Sparkles, label: 'News', onClick: onNavigateNews },
                { id: 'appointments', icon: Calendar, label: 'Book', onClick: onNavigateAppointments },
                { id: 'announcements', icon: Megaphone, label: 'Announce', onClick: onNavigateAnnouncements },
                { id: 'events', icon: Calendar, label: 'Events', onClick: onNavigateEvents },
                { id: 'parcel-tracking', icon: Package, label: 'Track', onClick: onNavigateParcelTracking }
              ].filter(tab => enabledPages.includes(tab.id)).map((tab) => (
                <Button
                  key={tab.id}
                  variant="ghost"
                  onClick={tab.onClick}
                  className="flex flex-col items-center justify-center px-3 py-2 transition-all group flex-1 min-w-[60px] h-auto"
                  aria-label={tab.label}
                >
                  <tab.icon
                    size={18}
                    className={cn(
                      "mb-1 transition-colors",
                      activeTab === tab.id ? "text-gray-900 dark:text-foreground" : "text-gray-400 dark:text-muted-foreground"
                    )}
                    strokeWidth={activeTab === tab.id ? 2 : 1.5}
                  />
                  <span
                    className={cn(
                      "text-[10px] transition-colors",
                      activeTab === tab.id ? "text-gray-900 dark:text-foreground font-medium" : "text-gray-400 dark:text-muted-foreground"
                    )}
                  >
                    {tab.label}
                  </span>
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}