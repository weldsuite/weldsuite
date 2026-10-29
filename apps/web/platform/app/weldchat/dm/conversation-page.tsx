import { useCallback, useMemo, useEffect, lazy, Suspense } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useParams } from '@tanstack/react-router';
import { useMessageDeepLink } from '../lib/message-search';
import { useQueryClient } from '@tanstack/react-query';
import { useDmByUser, useMarkChannelAsRead, weldchatKeys, mergeMessageIntoCache, updateMessageInCache, removeMessageFromCache } from '@/hooks/queries/use-weldchat-queries';
import type { ChatMessage } from '@/hooks/queries/use-weldchat-queries';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useWeldChatRoom } from '@/hooks/weldchat/use-weldchat-room';
import { useWeldChatMessagesRealtime, type WeldChatRealtimeMessage, type WeldChatRealtimeMessageUpdate } from '@/hooks/weldchat/use-weldchat-messages-realtime';
import { useWeldChatRealtime } from '@/hooks/weldchat/use-weldchat-realtime';
import { useWeldChatPresence } from '@/hooks/weldchat/use-weldchat-presence';
import { useMarkReadOnOpen } from '@/hooks/weldchat/use-mark-read-on-open';

import { ChannelHeader } from '../components/channel-header';
import { PinnedMessagesBar } from '../components/pinned-messages-bar';
import { MessageList } from '../components/message-list';
import { MessageInput } from '../components/message-input';
import { ChatPageSkeleton } from '../components/chat-page-skeleton';
import { useObjectPanel } from '@/components/object-panel';
import { useWeldChatCall } from '@/contexts/weldchat-call-context';
import { useEntitySheet } from '@/components/entity-sheet/use-entity-sheet';
// Lazy + dynamic-only — see channel/page.tsx for the why (avoids a mixed
// static+dynamic import of call-overlay that the CI build mis-chunks).
const InlineCallView = lazy(() =>
  import('../components/call-overlay').then((m) => ({ default: m.InlineCallView })),
);
import { useChatContext } from '../components/chat-context';

export default function DmConversationPage() {
  const { t } = useI18n();
  const st = useTranslations();
  const { userId: targetUserId } = useParams({ from: '/weldchat/dm/$userId' });
  const { targetMessageId, clearTarget } = useMessageDeepLink();
  const { data, isLoading } = useDmByUser(targetUserId);
  const queryClient = useQueryClient();
  const { mutate: markAsRead } = useMarkChannelAsRead();
  const { open: openObjectPanel, closeAll: closeAllObjectPanels } = useObjectPanel();

  const { status: callStatus, channelId: callChannelId, isFullscreen, isPiP } = useWeldChatCall();
  const { isOpen: isEntitySheetOpen, close: closeEntitySheet } = useEntitySheet();
  const { rightPanel, setActiveChannelId } = useChatContext();
  const isOverlayPanelOpen = rightPanel === 'bookmarks' || rightPanel === 'filters';

  // The member panel is the registered `team-member` object panel. It never
  // opens on its own: it starts closed on every DM and opens only when the
  // person's name in the header is clicked.
  const openMemberPanel = () => {
    window.dispatchEvent(new CustomEvent('member-detail-panel-user-toggle'));
    // Opening the member panel while an entity sheet is up would stack
    // overlays again — dismiss the sheet so the member panel takes the slot.
    if (isEntitySheetOpen) closeEntitySheet();
    openObjectPanel({ type: 'team-member', id: targetUserId });
  };

  // Entity sheet (e.g. customer detail from an `@customer` mention) and
  // Bookmarks / Filters (the 480px right-panel slot) would stack a second
  // panel next to the member panel. Close the member panel when either opens;
  // the header button reopens it.
  useEffect(() => {
    if (isEntitySheetOpen || isOverlayPanelOpen) closeAllObjectPanels();
  }, [isEntitySheetOpen, isOverlayPanelOpen, closeAllObjectPanels]);

  const channel = data?.data;

  const dmDisplayName = useMemo(() => {
    if (channel?.type === 'dm') {
      const other = channel.otherMembers?.[0];
      return other?.name || other?.email || channel.name || st('sweep.weldchat.dmConversation.defaultName');
    }
    return channel?.name || st('sweep.weldchat.dmConversation.defaultName');
  }, [channel, st]);

  useBreadcrumbs([
    { label: st('sweep.weldchat.breadcrumb.chat'), href: '/weldchat' },
    ...(channel ? [{ label: dmDisplayName }] : []),
  ]);
  const channelId = channel?.id;
  useEffect(() => {
    setActiveChannelId(channelId ?? null);
    return () => setActiveChannelId(null);
  }, [channelId, setActiveChannelId]);
  const isInCall = callStatus !== 'idle' && callChannelId === channelId && !isFullscreen && !isPiP;

  const { client } = useWeldChatRoom(channelId ?? null);

  // Mark the DM read on open; the answer says where the new messages start.
  const unreadMarker = useMarkReadOnOpen(channelId);

  const onMessageCreated = useCallback((message: WeldChatRealtimeMessage) => {
    if (!channelId) return;
    mergeMessageIntoCache(queryClient, channelId, message as unknown as ChatMessage);
    queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
    queryClient.invalidateQueries({ queryKey: weldchatKeys.dms() });

    // Auto mark as read when new message arrives and tab is focused
    if (!document.hidden) {
      markAsRead(channelId);
    }
  }, [channelId, queryClient, markAsRead]);

  const onMessageUpdated = useCallback((message: WeldChatRealtimeMessageUpdate) => {
    if (!channelId) return;
    updateMessageInCache(queryClient, channelId, message.id, message as unknown as Record<string, unknown>);
  }, [channelId, queryClient]);

  const onMessageDeleted = useCallback((messageId: string) => {
    if (!channelId) return;
    removeMessageFromCache(queryClient, channelId, messageId);
  }, [channelId, queryClient]);

  useWeldChatMessagesRealtime(client, channelId ?? null, {
    onMessageCreated,
    onMessageUpdated,
    onMessageDeleted,
  });

  useWeldChatRealtime(client, { channelId });
  useWeldChatPresence(client);

  if (isLoading || !channelId) return <ChatPageSkeleton />;

  if (!channel)
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        {t.weldchat.dm.conversationNotFound}
      </div>
    );

  // No panel JSX here any more: <ObjectPanelHost /> renders the `team-member`
  // panel from the object-panel stack that the effect above drives.
  return (
    <div className="flex flex-col h-full">
      {!isInCall && (
        <ChannelHeader channel={channel} onOpenMemberPanel={openMemberPanel} />
      )}
      {isInCall ? (
        <Suspense fallback={null}>
          <InlineCallView />
        </Suspense>
      ) : (
        <>
          <PinnedMessagesBar channelId={channelId} />
          {/* Distinct keys per sibling: see channel/page.tsx. */}
          <MessageList key={`list:${channelId}`} channelId={channelId} client={client} isDm targetMessageId={targetMessageId} onTargetHandled={clearTarget} unreadMarker={unreadMarker} />
          <MessageInput key={`input:${channelId}`} channelId={channelId} client={client} />
        </>
      )}
    </div>
  );
}
