import { useState, useEffect } from 'react';
import { X, MessageSquare, Trash2, Clock, User as UserIcon, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { getStoredConversationIds, removeConversationId } from '@/lib/utils/conversation-storage';
import { fetchConversation, type ConversationDetails } from '@/lib/api/conversations';
import { useMobileDetection, useViewportHeight } from '@/hooks';

interface ConversationHistoryViewProps {
  widgetId: string;
  currentConversationId?: string;
  onClose: () => void;
  onSelectConversation: (conversationId: string) => void;
  onStartNewConversation: () => void;
}

export function ConversationHistoryView({
  widgetId,
  currentConversationId,
  onClose,
  onSelectConversation,
  onStartNewConversation
}: ConversationHistoryViewProps) {
  const [conversations, setConversations] = useState<ConversationDetails[]>([]);
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

  // Fetch conversations from API
  useEffect(() => {
    async function loadConversations() {
      setLoading(true);
      const conversationIds = getStoredConversationIds(widgetId);

      if (conversationIds.length === 0) {
        setConversations([]);
        setLoading(false);
        return;
      }

      // Fetch details for all conversations in parallel
      const results = await Promise.all(
        conversationIds.map(id =>
          fetchConversation(id, widgetId).catch(error => {
            console.error('Failed to fetch conversation:', id, error);
            return null;
          })
        )
      );
      const fetchedConversations: ConversationDetails[] = [];
      results.forEach((r, i) => {
        if (r && r.success && r.conversation) {
          fetchedConversations.push(r.conversation);
        } else if (r && !r.success) {
          removeConversationId(widgetId, conversationIds[i]);
        }
      });

      // Sort by most recent first
      fetchedConversations.sort((a, b) => {
        const dateA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : new Date(a.createdAt).getTime();
        const dateB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : new Date(b.createdAt).getTime();
        return dateB - dateA;
      });

      setConversations(fetchedConversations);
      setLoading(false);
    }

    loadConversations();
  }, [widgetId]);

  // Determine if we should use full-screen mode
  const isFullScreen = isEmbedded || isMobile;

  const handleDeleteConversation = (conversationId: string, e: React.MouseEvent) => {
    e.stopPropagation();

    if (confirm('Are you sure you want to delete this conversation from history?')) {
      removeConversationId(widgetId, conversationId);
      setConversations(prev => prev.filter(c => c.id !== conversationId));
    }
  };

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

    return date.toLocaleDateString();
  };

  const getPreviewText = (conversation: ConversationDetails): string => {
    if (!conversation.lastMessage) return 'No messages yet';

    return conversation.lastMessage.length > 60
      ? conversation.lastMessage.substring(0, 60) + '...'
      : conversation.lastMessage;
  };

  // Container styles for embedded vs standalone mode
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
        maxWidth: 'calc(100vw - 40px)',
      };

  return (
    <div
      className={cn(
        'bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden widget-animation',
        !isFullScreen && 'fixed bottom-[90px] right-5 z-[999999]'
      )}
      style={containerStyles}
    >
      {/* Header */}
      <div className="flex items-center justify-between h-14 px-4 border-b">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-gray-700" />
          <h2 className="font-semibold text-sm">Conversation History</h2>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded-lg transition-all duration-150"
          style={{ marginRight: '-5px' }}
        >
          <X className="h-4 w-4 text-gray-500" />
        </button>
      </div>

      {/* Conversations List */}
      <div className="flex-1 overflow-y-auto">
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
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-6">
            <MessageSquare className="h-12 w-12 text-gray-300 mb-3" />
            <p className="text-sm font-medium text-gray-900 mb-1">No conversations yet</p>
            <p className="text-xs text-gray-500">
              Start a new conversation to get help
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {conversations.map((conversation) => {
              const isActive = conversation.id === currentConversationId;

              return (
                <button
                  key={conversation.id}
                  onClick={() => onSelectConversation(conversation.id)}
                  className={cn(
                    "w-full px-4 py-3 text-left transition-colors hover:bg-gray-50 relative group",
                    isActive && "bg-blue-50 hover:bg-blue-50"
                  )}
                >
                  <div className="flex items-start gap-3">
                    {/* Icon */}
                    <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 bg-gray-100">
                      <UserIcon className="h-5 w-5 text-gray-600" />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          #{conversation.conversationNumber}
                        </p>
                        <div className="flex items-center gap-1 text-xs text-gray-500">
                          <Clock className="h-3 w-3" />
                          {formatDate(conversation.lastMessageAt)}
                        </div>
                      </div>

                      <p className="text-xs text-gray-600 line-clamp-2 mb-1">
                        {getPreviewText(conversation)}
                      </p>

                      <div className="flex items-center gap-2 text-xs text-gray-500">
                        <span>{conversation.messageCount} messages</span>
                        {conversation.status && (
                          <>
                            <span>•</span>
                            <span className={cn(
                              "capitalize",
                              conversation.status === 'open' && "text-green-600",
                              conversation.status === 'closed' && "text-gray-500",
                              conversation.status === 'resolved' && "text-blue-600"
                            )}>
                              {conversation.status}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Delete button */}
                    <button
                      onClick={(e) => handleDeleteConversation(conversation.id, e)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-red-50 rounded"
                      title="Remove from history"
                    >
                      <Trash2 className="h-4 w-4 text-red-600" />
                    </button>
                  </div>

                  {isActive && (
                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-600" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer - New Conversation Button */}
      <div className="border-t p-3">
        <button
          onClick={onStartNewConversation}
          className="w-full px-4 py-2.5 bg-black text-white text-sm font-medium rounded-lg hover:bg-gray-800 transition-colors flex items-center justify-center gap-2"
        >
          <MessageSquare className="h-4 w-4" />
          Start New Conversation
        </button>
      </div>

    </div>
  );
}
