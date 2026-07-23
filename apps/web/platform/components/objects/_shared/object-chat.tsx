/**
 * `ObjectChatShell` — the generic chat sidebar used by every object panel.
 *
 * Layout + state machine (loading → empty composer → live channel) live
 * here. The HTTP path is owned by the panel folder via the `channelQuery`
 * and `onSendFirstMessage` props, so each panel can target whatever
 * backend it likes — today that's `apps/workers/app-api`.
 *
 * Realtime is still backed by the shared `useWeldChatRoom` family of
 * hooks. They take a channelId and don't care which worker created it.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { useUser } from '@clerk/clerk-react';
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useTranslations } from '@weldsuite/i18n/client';
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
import { EntityChatHeader } from '@/components/entity-chat/entity-chat-header';

export interface ObjectChannel {
  id: string;
  name: string;
  entityType: string;
  entityId: string;
  entityDisplayName: string | null;
}

interface ChannelEnvelope {
  data: ObjectChannel | null;
}

interface SendObjectMessagePayload {
  content: string;
  mentions: string[];
}

export interface ObjectChatShellProps {
  channelQuery: UseQueryResult<ChannelEnvelope, unknown>;
  /**
   * Posts the first message, which lazily creates the channel server-side.
   * Resolved value supplies the freshly-created channel + message so the
   * shell can transition out of the empty state.
   */
  onSendFirstMessage: (
    payload: SendObjectMessagePayload,
  ) => Promise<{ channel: ObjectChannel; message: unknown }>;
  /** Display name shown in the header before the channel exists. */
  fallbackName?: string;
  hideCallButtons?: boolean;
  hideHeader?: boolean;
  /** Custom header rendered inside the ChatContext provider. */
  headerSlot?: ReactNode;
  /** Query key for invalidating the channel cache after first message. */
  channelQueryKey?: readonly unknown[];
}

export function ObjectChatShell({
  channelQuery,
  onSendFirstMessage,
  fallbackName,
  hideCallButtons,
  hideHeader,
  headerSlot,
  channelQueryKey,
}: ObjectChatShellProps) {
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

  const channel = channelQuery.data?.data ?? null;
  const ctx = useMemo<ChatContextValue>(
    () => ({
      activeChannelId: channel?.id ?? null,
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
    [replyTo, filters, channel?.id],
  );

  if (channelQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('sweep.entities.loadingChat')}
      </div>
    );
  }

  const headerName =
    channel?.name || channel?.entityDisplayName || fallbackName || t('sweep.entities.chat');

  return (
    <ChatContext.Provider value={ctx}>
      <div className="flex h-full min-h-0 flex-col">
        {!hideHeader && (
          <EntityChatHeader
            name={headerName}
            channelId={channel?.id ?? null}
            hideCallButtons={hideCallButtons}
          />
        )}
        {headerSlot}
        <div className="flex min-h-0 flex-1 flex-col">
          {channel ? (
            <EmbeddedChannelChat channelId={channel.id} />
          ) : (
            <FirstMessageComposer
              currentUser={user}
              onSendFirstMessage={onSendFirstMessage}
              onSent={(createdChannel, message) => {
                if (channelQueryKey) {
                  queryClient.setQueryData<ChannelEnvelope>(channelQueryKey, {
                    data: createdChannel,
                  });
                }
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
  currentUser,
  onSendFirstMessage,
  onSent,
}: {
  currentUser: ReturnType<typeof useUser>['user'];
  onSendFirstMessage: ObjectChatShellProps['onSendFirstMessage'];
  onSent: (channel: ObjectChannel, message: unknown) => void;
}) {
  const t = useTranslations();
  const { data: membersData } = useWorkspaceMembers();
  const membersMap = useMemo(() => {
    const map = new Map<string, string>();
    const list: Array<{ userId?: string; name?: string }> = membersData?.data ?? [];
    for (const m of list) if (m?.userId && m?.name) map.set(m.userId, m.name);
    return map;
  }, [membersData]);

  const [pending, setPending] = useState<Array<Record<string, unknown>>>([]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col min-h-full py-4 space-y-1">
          <div className="flex-1" />
          {pending.map((msg) => (
            <MessageItem key={msg.id as string} message={msg as never} membersMap={membersMap} />
          ))}
        </div>
      </div>
      <MessageInput
        channelId=""
        placeholder={t('sweep.entities.typeMessagePlaceholder')}
        onSubmitOverride={async (payload) => {
          const id = `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const optimistic = {
            id,
            channelId: '',
            authorId: currentUser?.id ?? '',
            authorName: currentUser?.fullName || currentUser?.firstName || t('sweep.entities.you'),
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
            const result = await onSendFirstMessage({
              content: payload.content,
              mentions: payload.mentions,
            });
            onSent(result.channel, result.message);
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
    onMessageCreated: (message: { id: string }) => {
      mergeMessageIntoCache(queryClient, channelId, message as never);
    },
    onMessageUpdated: (message: { id: string }) => {
      updateMessageInCache(queryClient, channelId, message.id, message as never);
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
      <MessageInput
        channelId={channelId}
        client={client}
        placeholder={t('sweep.entities.typeMessagePlaceholder')}
      />
    </div>
  );
}
