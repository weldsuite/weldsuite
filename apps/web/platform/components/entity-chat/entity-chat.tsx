import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUser } from '@clerk/clerk-react';
import { weldchatEntityApi, type EntityChannel } from '@/lib/api/domains/weldchat-entity';
import { MessageItem } from '@/app/weldchat/components/message-item';
import { MessageList } from '@/app/weldchat/components/message-list';
import { MessageInput } from '@/app/weldchat/components/message-input';
import {
  mergeMessageIntoCache,
  updateMessageInCache,
  removeMessageFromCache,
  useWorkspaceMembers,
  weldchatKeys,
} from '@/hooks/queries/use-weldchat-queries';
import { useWeldChatRoom } from '@/hooks/weldchat/use-weldchat-room';
import { useWeldChatMessagesRealtime } from '@/hooks/weldchat/use-weldchat-messages-realtime';
import { useWeldChatRealtime } from '@/hooks/weldchat/use-weldchat-realtime';
import { useWeldChatPresence } from '@/hooks/weldchat/use-weldchat-presence';
import {
  ChatContext,
  type ChatContextValue,
  type RightPanel,
  type ReplyTo,
  type ChatFilters,
} from '@/app/weldchat/components/chat-context';
import { EntityChatHeader } from './entity-chat-header';
import { useTranslations } from '@weldsuite/i18n/client';

interface EntityChatProps {
  entityType: string;
  entityId: string;
  /** Display name shown in the header when the channel hasn't been created
   *  yet. Once the channel exists, its own name takes over. */
  fallbackName?: string;
  /** Hide the voice/video call buttons in the header. */
  hideCallButtons?: boolean;
  /** Hide the entire header (title + call buttons). */
  hideHeader?: boolean;
  /** Custom header rendered inside the ChatContext provider — lets the
   *  caller include filter / bookmark buttons that depend on chat context. */
  headerSlot?: React.ReactNode;
}

/**
 * Generic entity-chat surface. Renders the same WeldChat `MessageList` +
 * composer regardless of whether the channel already exists or is being
 * lazily created on first message — the visual layout is identical in
 * both states. Used by any entity that wants its own chat: tasks,
 * projects, and anything added to the server-side provider registry.
 */
export function EntityChat({ entityType, entityId, fallbackName, hideCallButtons, hideHeader, headerSlot }: EntityChatProps) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const { user } = useUser();
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null);
  const [filters, setFilters] = useState<ChatFilters>({
    type: 'all',
    search: '',
    from: [],
    date: undefined,
  });

  // ChatContext hoisted to cover both the no-channel optimistic view and
  // the live channel view, so MessageItem renders identically in both.
  const ctx = useMemo<ChatContextValue>(
    () => ({
      activeChannelId: null,
      setActiveChannelId: () => {},
      rightPanel: null as RightPanel,
      setRightPanel: () => {},
      threadMessageId: null,
      openThread: () => {},
      closeThread: () => {},
      replyTo,
      setReplyTo,
      filters,
      setFilters,
      selectedProfileUserId: null,
      openUserProfile: () => {},
      closeUserProfile: () => {},
      selectedAgentProfileId: null,
      openAgentProfile: () => {},
      closeAgentProfile: () => {},
    }),
    [replyTo, filters],
  );

  const channelQueryKey = useMemo(
    () => ['entity-channel', entityType, entityId],
    [entityType, entityId],
  );
  const channelQuery = useQuery<EntityChannel | null>({
    queryKey: channelQueryKey,
    queryFn: () => weldchatEntityApi.getEntityChannel(entityType, entityId),
    retry: false,
  });

  const channel = channelQuery.data ?? null;

  if (channelQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('sweep.weldchat.entityChat.loadingChat')}
      </div>
    );
  }

  const headerName = channel?.name || channel?.entityDisplayName || fallbackName || t('sweep.weldchat.entityChat.defaultChatName');

  return (
    <ChatContext.Provider value={ctx}>
      <div className="flex h-full min-h-0 flex-col">
        {!hideHeader && (
          <EntityChatHeader name={headerName} channelId={channel?.id ?? null} hideCallButtons={hideCallButtons} />
        )}
        {headerSlot}
        <div className="flex min-h-0 flex-1 flex-col">
          {channel ? (
            <EmbeddedChannelChat channelId={channel.id} />
          ) : (
            <FirstMessageComposer
              entityType={entityType}
              entityId={entityId}
              currentUser={user}
              onSent={(createdChannel, message) => {
                queryClient.setQueryData(channelQueryKey, createdChannel);
                queryClient.setQueryData(weldchatKeys.messages(createdChannel.id), {
                  pages: [{ data: { messages: [message], hasMore: false, nextCursor: null } }],
                  pageParams: [undefined],
                });
                queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
              }}
            />
          )}
        </div>
      </div>
    </ChatContext.Provider>
  );
}

// ---------------------------------------------------------------------------

function FirstMessageComposer({
  entityType,
  entityId,
  currentUser,
  onSent,
}: {
  entityType: string;
  entityId: string;
  currentUser: ReturnType<typeof useUser>['user'];
  onSent: (channel: EntityChannel, message: any) => void;
}) {
  const t = useTranslations();
  const { data: membersData } = useWorkspaceMembers();
  const membersMap = useMemo(() => {
    const map = new Map<string, string>();
    const list: any[] = membersData?.data ?? [];
    for (const m of list) if (m?.userId && m?.name) map.set(m.userId, m.name);
    return map;
  }, [membersData]);

  const [pending, setPending] = useState<Array<any>>([]);

  const sendMutation = useMutation({
    mutationFn: (payload: { content: string; mentions: string[] }) =>
      weldchatEntityApi.sendEntityMessage(entityType, entityId, {
        content: payload.content,
        mentions: payload.mentions,
      }),
    onSuccess: (result) => {
      onSent(result.channel, result.message);
    },
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col min-h-full py-4 space-y-1">
          <div className="flex-1" />
          {pending.map((msg) => (
            <MessageItem key={msg.id} message={msg} membersMap={membersMap} />
          ))}
        </div>
      </div>
      <MessageInput
        channelId=""
        placeholder={t('sweep.weldchat.entityChat.messagePlaceholder')}
        onSubmitOverride={async (payload) => {
          const id = `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const optimistic = {
            id,
            channelId: '',
            authorId: currentUser?.id ?? '',
            authorName: currentUser?.fullName || currentUser?.firstName || t('sweep.weldchat.entityChat.you'),
            authorAvatar: currentUser?.imageUrl ?? null,
            content: payload.content,
            htmlContent: null,
            type: 'message',
            parentId: null,
            reactions: {},
            mentions: payload.mentions,
            attachments: payload.attachments.length > 0 ? payload.attachments : null,
            hasAttachments: payload.attachments.length > 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            _optimistic: true,
          };
          setPending((prev) => [...prev, optimistic]);
          try {
            await sendMutation.mutateAsync({
              content: payload.content,
              mentions: payload.mentions,
            });
          } catch (err) {
            setPending((prev) => prev.filter((m) => m.id !== id));
            throw err;
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function EmbeddedChannelChat({ channelId }: { channelId: string }) {
  const t = useTranslations();
  const queryClient = useQueryClient();

  const { client } = useWeldChatRoom(channelId);

  useWeldChatMessagesRealtime(client, channelId, {
    onMessageCreated: (message: any) => {
      mergeMessageIntoCache(queryClient, channelId, message);
    },
    onMessageUpdated: (message: any) => {
      updateMessageInCache(queryClient, channelId, message.id, message);
    },
    onMessageDeleted: (messageId: string) => {
      removeMessageFromCache(queryClient, channelId, messageId);
    },
  });
  useWeldChatRealtime(client, { channelId });
  useWeldChatPresence(client);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MessageList channelId={channelId} client={client} />
      <MessageInput channelId={channelId} client={client} placeholder={t('sweep.weldchat.entityChat.messagePlaceholder')} />
    </div>
  );
}
