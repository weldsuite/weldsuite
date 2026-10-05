import { useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { getTranslations } from '@/lib/i18n';
import {
  useMessages,
  useThreadMessages,
  useChatMessage,
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
import { MessageItem, type MessageItemMessage } from './message-item';
import { MessageSkeleton } from './message-skeleton';
import { Button } from '@weldsuite/ui/components/button';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { RoomClient } from '@weldsuite/realtime/client';
import { useChatContext } from './chat-context';
import { isSystemNotice } from '../lib/system-notice';
import { flashMessageWhenMounted } from '../lib/jump-to-message';
import type { ChatMessage } from '@/hooks/queries/use-weldchat-queries';
import type { ChatCall } from '@weldsuite/db/schema/chat-calls';

/** A message row as this list's cache-merge + filter pipeline builds it. */
interface ListMessage extends ChatMessage {
  isBookmarked: boolean;
}

/** Normalizes `useMessages()` (infinite, channel view) and `useThreadMessages()`
 * (flat, thread view) — only one is ever actually enabled at a time — onto a
 * single shape. `fetchNextPage`/`hasNextPage`/`isFetchingNextPage` only exist
 * on the infinite-query result; they're simply absent (falsy) in thread mode. */
interface MessagesQueryResult {
  data?: {
    pages?: Array<{ data?: { messages?: ChatMessage[] } | ChatMessage[] }>;
    data?: ChatMessage[];
  };
  isLoading: boolean;
  isError?: boolean;
  refetch?: () => void;
  fetchNextPage?: () => void;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
}

/** Quote of a Discord-style inline reply, stored at `metadata.replyTo`. */
function inlineReplyOf(message: ChatMessage) {
  const metadata = message.metadata as { replyTo?: { authorName?: string; authorAvatar?: string | null; content?: string } } | null | undefined;
  return metadata?.replyTo ?? undefined;
}

interface ReadReceiptEntry {
  userId: string;
  userName?: string;
  userAvatar?: string;
}

/** Most older pages a message deep link will load while looking for its target. */
const MAX_JUMP_PAGES = 10;
/** How long after a jump the list ignores scroll events for its pin-to-bottom decision. */
const JUMP_SETTLE_MS = 1500;

interface MessageListProps {
  channelId: string;
  parentId?: string;
  showChannel?: boolean;
  client?: RoomClient | null;
  isDm?: boolean;
  /** Deep-link target (`?msg=`): scrolled to and highlighted once found; channel view only. */
  targetMessageId?: string;
  /** Called once the deep link has been handled (jumped to, or reported as not found): clear it from the URL. */
  onTargetHandled?: () => void;
}

export function MessageList({
  channelId,
  parentId,
  showChannel,
  isDm,
  targetMessageId,
  onTargetHandled,
}: Readonly<MessageListProps>) {
  const t = getTranslations('weldchat');
  const { userId: currentUserId } = useAuth();
  const { getClient } = useAppApiClient();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Check if there's an active call on this channel
  const { data: activeCallData } = useQuery({
    queryKey: weldchatKeys.activeCall(channelId),
    queryFn: async () => {
      const c = await getClient();
      return c.get<{ data: ChatCall | null }>(`/chat-calls/active/${channelId}`);
    },
    refetchInterval: 10000,
    enabled: !parentId,
  });
  const hasActiveCall = !!activeCallData?.data;
  // Always call both hooks to satisfy rules of hooks — only one will be enabled
  const messagesResult = useMessages(parentId ? '' : channelId);
  const threadResult = useThreadMessages(channelId, parentId || '');

  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    (parentId ? threadResult : messagesResult) as MessagesQueryResult;

  // Channel info — used by the empty state. Hits the same cache the page
  // already populated, so no extra fetch in normal navigation.
  const { data: channelData } = useChannel(parentId ? '' : channelId);
  const channel = channelData?.data;

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
      const filtered = (readers as ReadReceiptEntry[]).filter(
        (r) => r.userId !== currentUserId
      );
      if (filtered.length > 0) {
        map.set(
          messageId,
          filtered.map((r) => ({
            userId: r.userId,
            userName: r.userName || '',
            userAvatar: r.userAvatar || undefined,
          })),
        );
      }
    }
    return map;
  }, [readReceiptsData, currentUserId]);

  const { filters, openThread } = useChatContext();

  // Channel pages arrive newest-first; reverse them to chronological (oldest
  // first, newest at bottom). Thread replies are already sorted oldest-first by
  // `useThreadMessages`, so they must not be reversed again.
  const allMessages = useMemo((): ListMessage[] => {
    const paged = data?.pages?.flatMap((page) => {
      const d = page.data;
      return Array.isArray(d) ? d : (d?.messages ?? []);
    });
    const chronological = paged ? [...paged].reverse() : [...(data?.data ?? [])];
    return chronological.map((m) => ({
      ...m,
      isBookmarked: bookmarkedIds.has(m.id),
    }));
  }, [data, bookmarkedIds]);

  // Thread view: the message the thread hangs off, shown above the replies.
  const { data: threadParentData } = useChatMessage(parentId ?? '');
  const threadParent = parentId ? (threadParentData?.data as MessageItemMessage | undefined) : undefined;

  // Apply client-side filters
  const messages = useMemo(() => {
    let filtered = allMessages;

    // Type filter
    if (filters.type === 'messages') {
      filtered = filtered.filter((m) => !m.attachments?.length && m.content?.trim());
    } else if (filters.type === 'files') {
      filtered = filtered.filter((m) => m.attachments?.some((a) => !a.mimeType?.startsWith('image/')));
    } else if (filters.type === 'images') {
      filtered = filtered.filter((m) => m.attachments?.some((a) => a.mimeType?.startsWith('image/')));
    } else if (filters.type === 'links') {
      filtered = filtered.filter((m) => m.content && /https?:\/\/[^\s]+/.test(m.content));
    }

    // Keyword search
    if (filters.search) {
      const q = filters.search.toLowerCase();
      filtered = filtered.filter((m) => m.content?.toLowerCase().includes(q));
    }

    // From filter
    if (filters.from.length > 0) {
      const names = new Set(filters.from.map((n) => n.toLowerCase()));
      filtered = filtered.filter((m) => {
        const name = m.authorName?.toLowerCase();
        return name ? names.has(name) : false;
      });
    }

    // Date filter
    if (filters.date) {
      const filterDateStr = filters.date.toDateString();
      filtered = filtered.filter((m) => new Date(m.createdAt ?? '').toDateString() === filterDateStr);
    }

    return filtered;
  }, [allMessages, filters]);

  // Find the last "started a call" system message — only that one should show as live
  const lastCallStartedId = useMemo(() => {
    if (!hasActiveCall) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const text = (m.content || '').toLowerCase();
      if (isSystemNotice(m) &&
          (text.includes('started a voice call') || text.includes('started a video call') || text.includes('started a call'))) {
        return m.id;
      }
    }
    return null;
  }, [messages, hasActiveCall]);

  // --- Auto-scroll logic ---
  // Defaults to false = "pin to bottom". Only set to true when user scrolls up.
  const userScrolledUpRef = useRef(false);
  // While a deep-link jump is settling (smooth scroll, pages loading above), scroll
  // events must not flip the list back to "pin to bottom".
  const jumpHoldUntilRef = useRef(0);
  const holdPosition = useCallback(() => {
    userScrolledUpRef.current = true;
    jumpHoldUntilRef.current = Date.now() + JUMP_SETTLE_MS;
  }, []);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (Date.now() < jumpHoldUntilRef.current) return;
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

  // --- Message deep link (`?msg=<id>`) ---
  // Resolve the target first: a thread reply isn't in the channel list, so its
  // thread's parent message is the anchor and the thread opens beside it.
  const notFoundText = t.messageList.messageNotFound;
  const jumpEnabled = !parentId && !!targetMessageId;
  const { data: jumpTargetData, isError: jumpTargetFailed } = useChatMessage(jumpEnabled && targetMessageId ? targetMessageId : '');
  const jumpTarget = jumpTargetData?.data;
  const jumpDoneRef = useRef<string | null>(null);
  const jumpPagesRef = useRef(0);
  const cancelFlashRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    jumpPagesRef.current = 0;
    // No link in the URL (any more): the next one jumps again, even to the same message.
    if (!targetMessageId) jumpDoneRef.current = null;
  }, [targetMessageId]);

  // The list isn't remounted when the channel/thread changes: drop what belonged to the last one.
  useEffect(() => {
    userScrolledUpRef.current = false;
    jumpHoldUntilRef.current = 0;
    jumpDoneRef.current = null;
    jumpPagesRef.current = 0;
  }, [channelId, parentId]);

  useEffect(() => () => cancelFlashRef.current?.(), []);

  useEffect(() => {
    if (!jumpEnabled || !targetMessageId || isLoading || isError) return;
    if (jumpDoneRef.current === targetMessageId) return;
    if (!jumpTarget && !jumpTargetFailed) return;

    const replyParentId = typeof jumpTarget?.parentId === 'string' ? jumpTarget.parentId : undefined;
    const anchorId = replyParentId ?? targetMessageId;
    const otherChannel = !!jumpTarget?.channelId && jumpTarget.channelId !== channelId;

    if (!otherChannel && allMessages.some((m) => m.id === anchorId)) {
      jumpDoneRef.current = targetMessageId;
      // Don't let the pin-to-bottom logic pull the view back down.
      holdPosition();
      const cancels = [flashMessageWhenMounted(anchorId)];
      if (replyParentId) {
        openThread(replyParentId);
        cancels.push(flashMessageWhenMounted(targetMessageId));
      }
      cancelFlashRef.current?.();
      cancelFlashRef.current = () => cancels.forEach((cancel) => cancel());
      onTargetHandled?.();
      return;
    }

    if (isFetchingNextPage) return;
    if (!otherChannel && !jumpTargetFailed && hasNextPage && jumpPagesRef.current < MAX_JUMP_PAGES) {
      jumpPagesRef.current += 1;
      holdPosition();
      fetchNextPage?.();
      return;
    }

    jumpDoneRef.current = targetMessageId;
    toast.info(notFoundText);
    onTargetHandled?.();
  }, [jumpEnabled, targetMessageId, isLoading, isError, jumpTarget, jumpTargetFailed, channelId, allMessages, isFetchingNextPage, hasNextPage, fetchNextPage, openThread, notFoundText, onTargetHandled, holdPosition]);

  if (isLoading)
    return (
      <div className="flex-1 p-4">
        <MessageSkeleton count={8} />
      </div>
    );

  if (isError) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">Could not load messages.</p>
        <Button variant="outline" size="sm" onClick={() => refetch?.()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <>
    <style>{`
      @keyframes pinned-flash {
        0% { background-color: transparent; }
        10% { background-color: rgba(59, 130, 246, 0.12); }
        50% { background-color: rgba(59, 130, 246, 0.12); }
        100% { background-color: transparent; }
      }
      .pinned-highlight {
        animation: pinned-flash 1s ease-out forwards;
      }
    `}</style>
    <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-transparent hover:scrollbar-thumb-muted-foreground/20" style={{ scrollbarWidth: 'thin', scrollbarColor: 'transparent transparent' }} onMouseEnter={(e) => { e.currentTarget.style.scrollbarColor = 'rgba(150,150,150,0.2) transparent'; }} onMouseLeave={(e) => { e.currentTarget.style.scrollbarColor = 'transparent transparent'; }}>
      <div data-testid="chat-message-list" className="flex flex-col min-h-full pt-4 pb-8 space-y-1">
        {/* Spacer pushes messages to bottom when content is shorter than viewport */}
        <div className="flex-1" />
        {hasNextPage && (
          <div className="flex justify-center py-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fetchNextPage?.()}
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
        {threadParent && (
          <div data-testid="chat-thread-parent" className="border-b pb-3 mb-2">
            <MessageItem
              message={threadParent}
              channelId={channelId}
              membersMap={membersMap}
              isDm={isDm}
            />
          </div>
        )}
        {messages.map((message, index) => {
          const prevMessage = messages[index - 1];
          const msgTime = new Date(message.createdAt ?? '').getTime();
          const prevTime = prevMessage ? new Date(prevMessage.createdAt ?? '').getTime() : 0;
          const timeDiff = msgTime - prevTime;

          const showDate =
            !prevMessage ||
            new Date(message.createdAt ?? '').toDateString() !==
              new Date(prevMessage.createdAt ?? '').toDateString();

          const replyToMessage =
            inlineReplyOf(message) ??
            (message.parentId ? messages.find((m) => m.id === message.parentId) : undefined);

          // Compact (no avatar/name) only if same author, same date, within 5 min, and valid
          // timestamps. A message that quotes another one keeps its header so the quote shows.
          const isCompact =
            !!prevMessage &&
            !replyToMessage &&
            prevMessage.authorId === message.authorId &&
            !isSystemNotice(prevMessage) &&
            !showDate &&
            !Number.isNaN(timeDiff) &&
            timeDiff >= 0 &&
            timeDiff < 300000;

          return (
            <div key={message.id}>
              {showDate && (
                <div data-chat-divider="date" className="flex items-center gap-4 my-4 px-2 md:px-4">
                  <div className="flex-1 border-t" />
                  <span className="text-xs text-muted-foreground font-medium">
                    {new Date(message.createdAt ?? '').toLocaleDateString(undefined, {
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
                replyToMessage={replyToMessage}
                readBy={readByMap.get(message.id)}
                isDm={isDm}
                hasActiveCall={hasActiveCall && message.id === lastCallStartedId}
              />
            </div>
          );
        })}
      </div>
    </div>
    </>
  );
}
