import { useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { getTranslations } from '@/lib/i18n';
import {
  useMessages,
  useThreadMessages,
  useWorkspaceMembers,
  useChannelMembers,
  useBookmarks,
  useChannel,
  useReadReceipts,
  weldchatKeys,
} from '@/hooks/queries/use-weldchat-queries';
import { ChannelEmptyState } from './channel-empty-state';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useQuery } from '@tanstack/react-query';
import { MessageItem } from './message-item';
import { MessageSkeleton } from './message-skeleton';
import { Button } from '@weldsuite/ui/components/button';
import { Loader2 } from 'lucide-react';
import type { RoomClient } from '@weldsuite/realtime/client';
import { useChatContext } from './chat-context';

interface MessageListProps {
  channelId: string;
  parentId?: string;
  showChannel?: boolean;
  client?: RoomClient | null;
  isDm?: boolean;
}

export function MessageList({
  channelId,
  parentId,
  showChannel,
  client,
  isDm,
}: MessageListProps) {
  const t = getTranslations('weldchat');
  const { userId: currentUserId } = useAuth();
  const { getClient } = useAppApiClient();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Check if there's an active call on this channel
  const { data: activeCallData } = useQuery({
    queryKey: weldchatKeys.activeCall(channelId),
    queryFn: async () => {
      const c = await getClient();
      return c.get<any>(`/chat-calls/active/${channelId}`);
    },
    refetchInterval: 10000,
    enabled: !parentId,
  });
  const hasActiveCall = !!activeCallData?.data;
  // Always call both hooks to satisfy rules of hooks — only one will be enabled
  const messagesResult = useMessages(parentId ? '' : channelId);
  const threadResult = useThreadMessages(channelId, parentId || '');

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    parentId ? threadResult as any : messagesResult;

  // Channel info — used by the empty state. Hits the same cache the page
  // already populated, so no extra fetch in normal navigation.
  const { data: channelData } = useChannel(parentId ? '' : channelId);
  const channel = (channelData as any)?.data;

  // Workspace members + agent members for resolving @mention badges
  const { data: membersData } = useWorkspaceMembers();
  const { data: channelMembersData } = useChannelMembers(channelId);
  const membersMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersData?.data ?? []) {
      if (m.userId && m.name) map.set(m.userId, m.name);
    }
    // Agents that were added to this channel — lets <@agt_*> render as "@AgentName"
    for (const m of channelMembersData?.data ?? []) {
      if (m.memberType === 'agent' && m.userId && m.name) map.set(m.userId, m.name);
    }
    return map;
  }, [membersData, channelMembersData]);

  // Bookmarked message IDs for visual indicator
  const { data: bookmarksData } = useBookmarks();
  const bookmarkedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const bk of bookmarksData?.data ?? []) ids.add(bk.messageId);
    return ids;
  }, [bookmarksData]);

  // Per-message read receipts
  const { data: readReceiptsData } = useReadReceipts(channelId);
  const readByMap = useMemo(() => {
    const map = new Map<string, Array<{ userId: string; userName: string; userAvatar?: string }>>();
    const grouped = readReceiptsData?.data;
    if (!grouped) return map;
    for (const [messageId, readers] of Object.entries(grouped)) {
      const filtered = (readers as any[]).filter(
        (r: any) => r.userId !== currentUserId
      );
      if (filtered.length > 0) {
        map.set(
          messageId,
          filtered.map((r: any) => ({
            userId: r.userId,
            userName: r.userName || '',
            userAvatar: r.userAvatar || undefined,
          })),
        );
      }
    }
    return map;
  }, [readReceiptsData, currentUserId]);

  const { filters } = useChatContext();

  // API returns newest-first; reverse to chronological (oldest first, newest at bottom)
  const allMessages = useMemo(() => {
    const raw =
      data?.pages?.flatMap((page: any) => page.data?.messages || page.data || []) || data?.data || [];
    return [...raw].reverse().map((m: any) => ({
      ...m,
      isBookmarked: bookmarkedIds.has(m.id),
    }));
  }, [data, bookmarkedIds]);

  // Apply client-side filters
  const messages = useMemo(() => {
    let filtered = allMessages;

    // Type filter
    if (filters.type === 'messages') {
      filtered = filtered.filter((m: any) => !m.attachments?.length && m.content?.trim());
    } else if (filters.type === 'files') {
      filtered = filtered.filter((m: any) => m.attachments?.some((a: any) => !a.mimeType?.startsWith('image/')));
    } else if (filters.type === 'images') {
      filtered = filtered.filter((m: any) => m.attachments?.some((a: any) => a.mimeType?.startsWith('image/')));
    } else if (filters.type === 'links') {
      filtered = filtered.filter((m: any) => m.content && /https?:\/\/[^\s]+/.test(m.content));
    }

    // Keyword search
    if (filters.search) {
      const q = filters.search.toLowerCase();
      filtered = filtered.filter((m: any) => m.content?.toLowerCase().includes(q));
    }

    // From filter
    if (filters.from.length > 0) {
      const names = new Set(filters.from.map((n) => n.toLowerCase()));
      filtered = filtered.filter((m: any) => {
        const name = m.authorName?.toLowerCase();
        return name ? names.has(name) : false;
      });
    }

    // Date filter
    if (filters.date) {
      const filterDateStr = filters.date.toDateString();
      filtered = filtered.filter((m: any) => new Date(m.createdAt).toDateString() === filterDateStr);
    }

    return filtered;
  }, [allMessages, filters]);

  // Find the last "started a call" system message — only that one should show as live
  const lastCallStartedId = useMemo(() => {
    if (!hasActiveCall) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const text = (m.content || '').toLowerCase();
      if ((m.type === 'system' || /^\[system/.test(m.content || '')) &&
          (text.includes('started a voice call') || text.includes('started a video call') || text.includes('started a call'))) {
        return m.id;
      }
    }
    return null;
  }, [messages, hasActiveCall]);

  // --- Auto-scroll logic ---
  // Defaults to false = "pin to bottom". Only set to true when user scrolls up.
  const userScrolledUpRef = useRef(false);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    userScrolledUpRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight > 150;
  };

  // Scroll to bottom synchronously after every DOM commit that changes messages.
  // useLayoutEffect runs before paint, so the user never sees an un-scrolled frame.
  useLayoutEffect(() => {
    if (userScrolledUpRef.current) return;
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Catch async height changes (images loading, embeds, live call timer, etc.)
  // Depends on isLoading so it re-attaches when the scroll container first mounts.
  useEffect(() => {
    const el = scrollContainerRef.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const obs = new ResizeObserver(() => {
      if (!userScrolledUpRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    obs.observe(inner);
    return () => obs.disconnect();
  }, [isLoading]);

  if (isLoading)
    return (
      <div className="flex-1 p-4">
        <MessageSkeleton count={8} />
      </div>
    );

  return (
    <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-transparent hover:scrollbar-thumb-muted-foreground/20" style={{ scrollbarWidth: 'thin', scrollbarColor: 'transparent transparent' }} onMouseEnter={(e) => { e.currentTarget.style.scrollbarColor = 'rgba(150,150,150,0.2) transparent'; }} onMouseLeave={(e) => { e.currentTarget.style.scrollbarColor = 'transparent transparent'; }}>
      <div data-testid="chat-message-list" className="flex flex-col min-h-full pt-4 pb-8 space-y-1">
        {/* Spacer pushes messages to bottom when content is shorter than viewport */}
        <div className="flex-1" />
        {hasNextPage && (
          <div className="flex justify-center py-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              {t.messageList.loadOlderMessages}
            </Button>
          </div>
        )}
        {!parentId && !hasNextPage && messages.length === 0 && channel && (
          <ChannelEmptyState channel={channel} />
        )}
        {messages.map((message: any, index: number) => {
          const prevMessage = messages[index - 1];
          const msgTime = new Date(message.createdAt).getTime();
          const prevTime = prevMessage ? new Date(prevMessage.createdAt).getTime() : 0;
          const timeDiff = msgTime - prevTime;

          const showDate =
            !prevMessage ||
            new Date(message.createdAt).toDateString() !==
              new Date(prevMessage.createdAt).toDateString();

          // Compact (no avatar/name) only if same author, same date, within 10 min, and valid timestamps
          const isCompact =
            !!prevMessage &&
            prevMessage.authorId === message.authorId &&
            prevMessage.type !== 'system' &&
            !showDate &&
            !isNaN(timeDiff) &&
            timeDiff >= 0 &&
            timeDiff < 300000;

          return (
            <div key={message.id}>
              {showDate && (
                <div data-chat-divider="date" className="flex items-center gap-4 my-4 px-2 md:px-4">
                  <div className="flex-1 border-t" />
                  <span className="text-xs text-muted-foreground font-medium">
                    {new Date(message.createdAt).toLocaleDateString(undefined, {
                      weekday: 'long',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </span>
                  <div className="flex-1 border-t" />
                </div>
              )}
              <MessageItem
                message={message}
                compact={isCompact}
                showChannel={showChannel}
                channelId={channelId}
                membersMap={membersMap}
                replyToMessage={message.parentId ? messages.find((m: any) => m.id === message.parentId) : undefined}
                readBy={readByMap.get(message.id)}
                isDm={isDm}
                hasActiveCall={hasActiveCall && message.id === lastCallStartedId}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
