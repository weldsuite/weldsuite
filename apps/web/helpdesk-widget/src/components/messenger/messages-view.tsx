import { Loader2, MessageCircle, Send, X } from 'lucide-react';
import type { WidgetConfigResponse } from '@/lib/api/types';
import type { Messenger } from '@/hooks/use-messenger';
import { Avatar, readableOn, timeAgo } from './parts';

interface MessagesViewProps {
  config: WidgetConfigResponse;
  messenger: Messenger;
  onNewConversation: () => void;
  onOpenConversation: (id: string) => void;
  onClose?: () => void;
}

export function MessagesView({ config, messenger, onNewConversation, onOpenConversation, onClose }: Readonly<MessagesViewProps>) {
  const color = config.branding.primaryColor;
  const { conversations, conversationsLoaded } = messenger;

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="messages-view">
      <header className="relative flex items-center justify-center h-14 border-b border-gray-100 flex-shrink-0">
        <h2 className="text-[15px] font-semibold text-gray-900">Messages</h2>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid="close-button"
            className="absolute right-3 rounded-full p-1.5 text-gray-500 hover:bg-gray-100"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!conversationsLoaded ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center px-8 py-16">
            <MessageCircle className="h-8 w-8 text-gray-300 mb-3" />
            <p className="text-sm font-semibold text-gray-900">No messages</p>
            <p className="text-sm text-gray-500 mt-1">Messages from the team will be shown here</p>
          </div>
        ) : (
          <ul>
            {conversations.map((conversation) => {
              const unread = messenger.isUnread(conversation);
              const who = conversation.lastMessageFromTeam
                ? conversation.assignee?.name ?? config.team[0]?.name ?? 'Support'
                : 'You';
              return (
                <li key={conversation.id}>
                  <button
                    type="button"
                    onClick={() => onOpenConversation(conversation.id)}
                    className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-gray-50 transition border-b border-gray-50"
                  >
                    <Avatar
                      name={conversation.assignee?.name ?? config.team[0]?.name ?? 'Support'}
                      src={conversation.assignee?.avatar ?? config.team[0]?.avatar}
                      size={40}
                    />
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm truncate ${unread ? 'font-semibold text-gray-900' : 'text-gray-800'}`}>
                        {conversation.lastMessagePreview || conversation.title || 'Conversation'}
                      </p>
                      <p className="text-xs text-gray-500 truncate">
                        {who} · {timeAgo(conversation.lastMessageAt ?? conversation.createdAt)}
                        {conversation.state === 'closed' && ' · Closed'}
                      </p>
                    </div>
                    {unread && <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex justify-center py-3 flex-shrink-0">
        <button
          type="button"
          onClick={onNewConversation}
          className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold shadow-md hover:shadow-lg transition"
          style={{ backgroundColor: color, color: readableOn(color) }}
        >
          Send us a message
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
