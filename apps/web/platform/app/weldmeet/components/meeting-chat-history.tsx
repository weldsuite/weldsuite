/**
 * MeetingChatHistory — Read-only chat history for meeting detail pages.
 * Used both as a sidebar in MeetingIntelligence and as a standalone Card.
 */

import { useMemo } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyStateIllustration } from '@/components/entity-list';
import { Loader2, MessageSquare } from 'lucide-react';
import { useMeetingMessages } from '@/hooks/queries/use-meeting-chat-queries';
import { getTranslations } from '@/lib/i18n';

interface MeetingChatHistoryProps {
  meetingId: string;
  hideHeader?: boolean;
}

interface MeetingChatMessage {
  id: string;
  type?: string;
  authorId: string;
  authorName?: string;
  authorAvatar?: string;
  content: string;
  createdAt: string;
}

interface MeetingMessagesPage {
  data?: { messages?: MeetingChatMessage[] };
}

export function MeetingChatHistory({ meetingId, hideHeader }: MeetingChatHistoryProps) {
  const t = getTranslations('weldmeet');
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useMeetingMessages(meetingId);

  const messages = useMemo(() => {
    const raw = data?.pages?.flatMap((page: MeetingMessagesPage) => page.data?.messages || []) || [];
    return [...raw].reverse();
  }, [data]);

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        {!hideHeader && <ChatHistoryHeader count={0} />}
        <div className="flex items-center justify-center gap-2 py-8">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{t.chatHistory.loading}</span>
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-col h-full">
        {!hideHeader && <ChatHistoryHeader count={0} />}
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <EmptyStateIllustration>
            <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" className="translate-y-2">
              <path d="M30 24h62a8 8 0 018 8v36a8 8 0 01-8 8H52l-10 10v-10h-12a8 8 0 01-8-8V32a8 8 0 018-8z" className="fill-white dark:fill-white/[0.03]" />
              <path d="M30 24h62a8 8 0 018 8v36a8 8 0 01-8 8H52l-10 10v-10h-12a8 8 0 01-8-8V32a8 8 0 018-8z" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
              <rect x="34" y="40" width="52" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
              <rect x="34" y="48" width="38" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
              <rect x="34" y="56" width="24" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
            </svg>
          </EmptyStateIllustration>
          <p className="text-[15px] font-semibold text-foreground mb-0">{t.chatHistory.noMessages}</p>
          <p className="text-sm text-muted-foreground max-w-[320px] leading-relaxed">{t.chatHistory.noMessagesHint}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {!hideHeader && <ChatHistoryHeader count={messages.length} />}
      <div className="flex-1 overflow-y-auto">
        <div className="py-3 space-y-0.5">
          {hasNextPage && (
            <div className="flex justify-center py-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                {t.chatHistory.loadOlder}
              </Button>
            </div>
          )}
          {messages.map((message: MeetingChatMessage, index: number) => {
            const prevMessage = messages[index - 1];
            const msgTime = new Date(message.createdAt).getTime();
            const prevTime = prevMessage ? new Date(prevMessage.createdAt).getTime() : 0;
            const timeDiff = msgTime - prevTime;

            const showDate =
              !prevMessage ||
              new Date(message.createdAt).toDateString() !==
                new Date(prevMessage.createdAt).toDateString();

            const isCompact =
              !!prevMessage &&
              prevMessage.authorId === message.authorId &&
              !showDate &&
              !isNaN(timeDiff) &&
              timeDiff >= 0 &&
              timeDiff < 300000;

            return (
              <div key={message.id}>
                {showDate && (
                  <div className="flex items-center gap-3 my-3 px-4">
                    <div className="flex-1 border-t" />
                    <span className="text-[11px] text-muted-foreground font-medium">
                      {new Date(message.createdAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                    <div className="flex-1 border-t" />
                  </div>
                )}
                <ChatHistoryMessage message={message} compact={isCompact} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ChatHistoryHeader({ count }: { count: number }) {
  const t = getTranslations('weldmeet');
  return (
    <div className="px-4 py-3 border-b flex items-center gap-2 flex-shrink-0">
      <MessageSquare className="h-4 w-4 text-muted-foreground" />
      <span className="text-sm font-medium">{t.chatHistory.header}</span>
      {count > 0 && (
        <span className="text-xs text-muted-foreground">({count})</span>
      )}
    </div>
  );
}

function ChatHistoryMessage({ message, compact }: { message: MeetingChatMessage; compact?: boolean }) {
  const timeStr = new Date(message.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (message.type === 'system') {
    return (
      <div className="flex justify-center py-1 px-4">
        <span className="text-[11px] text-muted-foreground">{message.content}</span>
      </div>
    );
  }

  return (
    <div className="px-4 py-0.5 hover:bg-muted/50 transition-colors">
      <div className="flex gap-2">
        {compact ? (
          <div className="w-6 flex-shrink-0" />
        ) : (
          <Avatar className="h-6 w-6 flex-shrink-0 mt-0.5 !rounded-md">
            {message.authorAvatar && (
              <AvatarImage src={message.authorAvatar} className="!rounded-md" />
            )}
            <AvatarFallback className="text-[8px] !rounded-md">
              {(message.authorName || '?')[0].toUpperCase()}
            </AvatarFallback>
          </Avatar>
        )}
        <div className="flex-1 min-w-0">
          {!compact && (
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-xs">{message.authorName}</span>
              <span className="text-[11px] text-muted-foreground">{timeStr}</span>
            </div>
          )}
          <p className="text-xs whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      </div>
    </div>
  );
}
