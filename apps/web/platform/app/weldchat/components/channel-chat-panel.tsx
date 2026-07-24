/**
 * Channel Chat Panel — WeldChat in-call chat tab.
 *
 * Renders the CURRENT channel's chat inside a WeldChat call, using the same
 * shared <SharedMeetingChatPanel> the WeldMeet experience uses (so the look is
 * identical), but wired to the WeldChat channel data layer instead of the
 * meeting chat.
 *
 * Consumed by chat-meeting-room.tsx as the `chatPanelSlot` of MeetingRoomView.
 * Because the fullscreen call overlay is mounted globally (the channel page is
 * unmounted while fullscreen), this panel opens its OWN realtime room so new
 * messages stream in live regardless of where the call is shown. The room is
 * only connected while the chat tab is open (`isOpen ? channelId : null`).
 */

import { useMemo, useCallback } from 'react';
import { useAuth, useUser } from '@clerk/clerk-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  SharedMeetingChatPanel,
  MeetingChatNotification,
  type ChatMessage,
} from '@weldsuite/weldmeet-ui';
import {
  useMessages,
  useSendMessage,
  usePinMessage,
  useUnpinMessage,
  usePinnedMessages,
  useDeleteMessage,
  weldchatKeys,
  mergeMessageIntoCache,
  removeMessageFromCache,
  type ChatMessage as WeldChatCacheMessage,
} from '@/hooks/queries/use-weldchat-queries';
import { useWeldChatRoom } from '@/hooks/weldchat/use-weldchat-room';
import { useWeldChatMessagesRealtime, type WeldChatRealtimeMessage } from '@/hooks/weldchat/use-weldchat-messages-realtime';
import { useTranslations } from '@weldsuite/i18n/client';

interface RawMessageAttachment {
  id: string;
  fileName?: string;
  name?: string;
  fileSize?: number;
  size?: number;
  url: string;
}

interface RawChatMessage {
  id: string;
  authorId: string;
  authorName?: string;
  authorAvatar?: string | null;
  content?: string;
  type?: string;
  createdAt: string;
  attachments?: RawMessageAttachment[];
  pinnedAt?: string | null;
  _optimistic?: boolean;
}

interface RawMessagesPage {
  data?: { messages?: RawChatMessage[] };
}

interface RawPinnedMessage {
  id: string;
  content?: string;
}

export interface ChannelChatPanelProps {
  channelId: string;
  isOpen: boolean;
  onClose: () => void;
  onOpen?: () => void;
  notificationHost?: HTMLElement | null;
  skipTransition?: boolean;
}

export function ChannelChatPanel({
  channelId,
  isOpen,
  onClose,
  onOpen,
  notificationHost,
}: ChannelChatPanelProps) {
  const { userId } = useAuth();
  const { user } = useUser();
  const queryClient = useQueryClient();
  const st = useTranslations();

  // ── Realtime ────────────────────────────────────────────────────────────
  // Only connect the room while the chat tab is open — the call overlay is
  // mounted globally, so an always-on socket here would duplicate the channel
  // page's connection for no benefit when chat is closed.
  const { client } = useWeldChatRoom(isOpen ? channelId : null);

  const onMessageCreated = useCallback(
    (message: WeldChatRealtimeMessage) => {
      mergeMessageIntoCache(queryClient, channelId, message as unknown as WeldChatCacheMessage);
      queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
    },
    [channelId, queryClient],
  );

  const onMessageDeleted = useCallback(
    (messageId: string) => {
      removeMessageFromCache(queryClient, channelId, messageId);
    },
    [channelId, queryClient],
  );

  useWeldChatMessagesRealtime(client, isOpen ? channelId : null, {
    onMessageCreated,
    onMessageDeleted,
  });

  // ── Queries ─────────────────────────────────────────────────────────────
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useMessages(channelId);
  const { data: pinnedData } = usePinnedMessages(channelId);

  const { mutate: sendMessageMutate } = useSendMessage();
  const { mutate: pinMessage } = usePinMessage();
  const { mutate: unpinMessage } = useUnpinMessage();
  const { mutate: deleteMessage } = useDeleteMessage();

  // ── Derived data ──────────────────────────────────────────────────────────
  // API returns newest-first pages; flatten + reverse to chronological order
  // (oldest → newest) for the shared component.
  const messages = useMemo((): ChatMessage[] => {
    const raw: RawChatMessage[] =
      (data?.pages as RawMessagesPage[] | undefined)?.flatMap((page) => page.data?.messages ?? []) ?? [];
    return [...raw].reverse().map((m) => ({
      id: m.id,
      authorId: m.authorId,
      authorName: m.authorName ?? st('sweep.weldchat.sidebar.unknownMember'),
      authorAvatar: m.authorAvatar ?? null,
      content: m.content ?? '',
      type: m.type ?? 'message',
      createdAt: m.createdAt,
      attachments: (m.attachments ?? []).map((a) => ({
        id: a.id,
        fileName: a.fileName ?? a.name ?? '',
        fileSize: a.fileSize ?? a.size,
        url: a.url,
      })),
      pinnedAt: m.pinnedAt ?? null,
      _optimistic: m._optimistic,
    }));
  }, [data, st]);

  const pinnedMessages = useMemo(() => {
    const pins = (pinnedData?.data as RawPinnedMessage[] | undefined) ?? [];
    return pins.map((p) => ({ id: p.id, content: p.content ?? '' }));
  }, [pinnedData]);

  // ── Callbacks ─────────────────────────────────────────────────────────────
  const handleSend = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      sendMessageMutate({
        channelId,
        content: text,
        _optimisticId: `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      });
    },
    [channelId, sendMessageMutate],
  );

  const handlePin = useCallback(
    (messageId: string) => pinMessage({ channelId, messageId }),
    [channelId, pinMessage],
  );

  const handleUnpin = useCallback(
    (messageId: string) => unpinMessage({ channelId, messageId }),
    [channelId, unpinMessage],
  );

  const handleDelete = useCallback(
    (messageId: string) => deleteMessage({ channelId, messageId }),
    [channelId, deleteMessage],
  );

  const canDeleteMessage = useCallback(
    (message: ChatMessage) => message.authorId === userId,
    [userId],
  );

  const currentUserId = userId ?? '';
  const currentUserName =
    user?.fullName || user?.firstName || user?.username || st('sweep.weldchat.entityChat.you');

  return (
    <>
      <SharedMeetingChatPanel
        isOpen={isOpen}
        onClose={onClose}
        messages={messages}
        isLoading={isLoading}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        onFetchNextPage={fetchNextPage}
        currentUserId={currentUserId}
        currentUserName={currentUserName}
        onSendMessage={handleSend}
        pinnedMessages={pinnedMessages}
        onPinMessage={handlePin}
        onUnpinMessage={handleUnpin}
        canDeleteMessage={canDeleteMessage}
        onDeleteMessage={handleDelete}
        onCopyToast={(msg) => toast.success(msg)}
      />
      <MeetingChatNotification
        messages={messages}
        currentUserId={currentUserId}
        isChatOpen={isOpen}
        onOpenChat={onOpen}
        host={notificationHost}
      />
    </>
  );
}
