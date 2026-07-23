import { useCallback, useEffect, lazy, Suspense } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useChannel, useMarkChannelAsRead, weldchatKeys, mergeMessageIntoCache, updateMessageInCache, removeMessageFromCache } from '@/hooks/queries/use-weldchat-queries';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useWeldChatRoom } from '@/hooks/weldchat/use-weldchat-room';
import { useWeldChatMessagesRealtime } from '@/hooks/weldchat/use-weldchat-messages-realtime';
import { useWeldChatRealtime } from '@/hooks/weldchat/use-weldchat-realtime';
import { useWeldChatPresence } from '@/hooks/weldchat/use-weldchat-presence';
import { useWeldChatCall } from '@/contexts/weldchat-call-context';
import { ChannelHeader } from '../components/channel-header';
import { PinnedMessagesBar } from '../components/pinned-messages-bar';
import { MessageList } from '../components/message-list';
import { MessageInput } from '../components/message-input';
// Lazy + dynamic-only: keeps call-overlay.tsx out of this route's chunk so the
// module is imported the SAME way app-shell imports it (dynamically). A mixed
// static+dynamic import of the same module lets the CI build fold it into a
// route/entry chunk, breaking app-shell's lazy import().
const InlineCallView = lazy(() =>
  import('../components/call-overlay').then((m) => ({ default: m.InlineCallView })),
);
import { ChatPageSkeleton } from '../components/chat-page-skeleton';
import { ChatDropZone } from '../components/chat-drop-zone';
import { useChatContext } from '../components/chat-context';

export default function ChannelPage() {
  const { t } = useI18n();
  const st = useTranslations();
  const { channelId } = useParams({ from: '/weldchat/$channelId/' });
  const { data, isLoading } = useChannel(channelId);
  const queryClient = useQueryClient();
  const { mutate: markAsRead } = useMarkChannelAsRead();
  const { setActiveChannelId } = useChatContext();

  useEffect(() => {
    setActiveChannelId(channelId ?? null);
    return () => setActiveChannelId(null);
  }, [channelId, setActiveChannelId]);

  // Auto mark channel as read on open
  useEffect(() => {
    if (channelId) markAsRead(channelId);
  }, [channelId, markAsRead]);

  // Shared Chat SDK room for messages, typing, and presence
  const { client, isConnected } = useWeldChatRoom(channelId);

  // Chat SDK message subscription — merges into TanStack Query cache
  const onMessageCreated = useCallback((message: any) => {
    mergeMessageIntoCache(queryClient, channelId, message);
    queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });

    // Auto mark as read when new message arrives and tab is focused
    if (!document.hidden) {
      markAsRead(channelId);
    }

    // Browser notification when tab is not focused
    if (document.hidden && message.authorName && Notification.permission === 'granted') {
      new Notification(message.authorName, {
        body: message.content?.substring(0, 100) ?? st('sweep.weldchat.channelPage.newMessage'),
        tag: `chat-${channelId}-${message.id}`,
      });
    }
  }, [channelId, queryClient, markAsRead, st]);

  const onMessageUpdated = useCallback((message: any) => {
    updateMessageInCache(queryClient, channelId, message.id, message);
  }, [channelId, queryClient]);

  const onMessageDeleted = useCallback((messageId: string) => {
    removeMessageFromCache(queryClient, channelId, messageId);
  }, [channelId, queryClient]);

  useWeldChatMessagesRealtime(client, channelId, {
    onMessageCreated,
    onMessageUpdated,
    onMessageDeleted,
  });

  // Raw pub/sub for reactions, pins, members, calls
  useWeldChatRealtime(client, { channelId });

  // Presence via shared room
  useWeldChatPresence(client);

  const { status: callStatus, channelId: callChannelId, isFullscreen, isPiP } = useWeldChatCall();

  const channel = data?.data;

  useBreadcrumbs([
    { label: st('sweep.weldchat.breadcrumb.chat'), href: '/weldchat' },
    ...(channel ? [{ label: `${channel.type === 'private' ? '' : '#'}${channel.name}` }] : []),
  ]);

  if (isLoading) return <ChatPageSkeleton />;

  if (!channel)
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        {t.weldchat.dm.channelNotFound}
      </div>
    );

  const isInCall = callStatus !== 'idle' && callStatus !== 'ended' && callChannelId === channelId && !isFullscreen && !isPiP;

  return (
    <div className="flex flex-col h-full">
      {!isInCall && <ChannelHeader channel={channel} />}
      {isInCall ? (
        <Suspense fallback={null}>
          <InlineCallView />
        </Suspense>
      ) : (
        <ChatDropZone channelId={channelId}>
          <PinnedMessagesBar channelId={channelId} />
          <MessageList channelId={channelId} client={client} />
          <MessageInput channelId={channelId} client={client} />
        </ChatDropZone>
      )}
    </div>
  );
}
