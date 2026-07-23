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
import { ChannelHeader } from '../components/channel-header';
import { PinnedMessagesBar } from '../components/pinned-messages-bar';
import { MessageList } from '../components/message-list';
import { MessageInput } from '../components/message-input';
import { ChatPageSkeleton } from '../components/chat-page-skeleton';
import { useWeldChatCall } from '@/contexts/weldchat-call-context';
// Lazy + dynamic-only — see channel/page.tsx for the why (avoids a mixed
// static+dynamic import of call-overlay that the CI build mis-chunks).
const InlineCallView = lazy(() =>
  import('../components/call-overlay').then((m) => ({ default: m.InlineCallView })),
);
import { useChatContext } from '../components/chat-context';

export default function GroupConversationPage() {
  const { t } = useI18n();
  const st = useTranslations();
  const { channelId } = useParams({ from: '/weldchat/dm/group/$channelId' });
  const { data, isLoading } = useChannel(channelId);
  const queryClient = useQueryClient();
  const { mutate: markAsRead } = useMarkChannelAsRead();

  const { status: callStatus, channelId: callChannelId, isFullscreen, isPiP } = useWeldChatCall();
  const { setActiveChannelId } = useChatContext();
  const channel = data?.data;
  const isInCall = callStatus !== 'idle' && callStatus !== 'ended' && callChannelId === channelId && !isFullscreen && !isPiP;

  useEffect(() => {
    setActiveChannelId(channelId ?? null);
    return () => setActiveChannelId(null);
  }, [channelId, setActiveChannelId]);

  useBreadcrumbs([
    { label: st('sweep.weldchat.breadcrumb.chat'), href: '/weldchat' },
    ...(channel ? [{ label: channel.name || st('sweep.weldchat.groupConversation.defaultName') }] : []),
  ]);

  const { client, isConnected } = useWeldChatRoom(channelId ?? null);

  // Auto mark as read on open
  useEffect(() => {
    if (channelId) markAsRead(channelId);
  }, [channelId, markAsRead]);

  const onMessageCreated = useCallback((message: any) => {
    if (!channelId) return;
    mergeMessageIntoCache(queryClient, channelId, message);
    queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
    queryClient.invalidateQueries({ queryKey: weldchatKeys.dms() });

    if (!document.hidden) {
      markAsRead(channelId);
    }
  }, [channelId, queryClient, markAsRead]);

  const onMessageUpdated = useCallback((message: any) => {
    if (!channelId) return;
    updateMessageInCache(queryClient, channelId, message.id, message);
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

  return (
    <div className="flex flex-col h-full">
      {!isInCall && (
        <ChannelHeader channel={channel} />
      )}
      {isInCall ? (
        <Suspense fallback={null}>
          <InlineCallView />
        </Suspense>
      ) : (
        <>
          <PinnedMessagesBar channelId={channelId} />
          <MessageList channelId={channelId} client={client} isDm />
          <MessageInput channelId={channelId} client={client} />
        </>
      )}
    </div>
  );
}
