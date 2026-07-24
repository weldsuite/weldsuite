import { useCallback, useState, useMemo, useRef, useEffect, lazy, Suspense } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useDmByUser, useMarkChannelAsRead, weldchatKeys, mergeMessageIntoCache, updateMessageInCache, removeMessageFromCache, useWorkspaceMembers } from '@/hooks/queries/use-weldchat-queries';
import type { ChatMessage } from '@/hooks/queries/use-weldchat-queries';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useWeldChatRoom } from '@/hooks/weldchat/use-weldchat-room';
import { useWeldChatMessagesRealtime, type WeldChatRealtimeMessage } from '@/hooks/weldchat/use-weldchat-messages-realtime';
import { useWeldChatRealtime } from '@/hooks/weldchat/use-weldchat-realtime';
import { useWeldChatPresence } from '@/hooks/weldchat/use-weldchat-presence';

import { ChannelHeader } from '../components/channel-header';
import { PinnedMessagesBar } from '../components/pinned-messages-bar';
import { MessageList } from '../components/message-list';
import { MessageInput } from '../components/message-input';
import { ChatPageSkeleton } from '../components/chat-page-skeleton';
import { X } from 'lucide-react';
import { TeamMemberDetailsPanel, fromTeamMember, type TeamMemberDetail } from '@/components/team-member-details-panel';
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
  const { data, isLoading } = useDmByUser(targetUserId);
  const queryClient = useQueryClient();
  const { mutate: markAsRead } = useMarkChannelAsRead();
  const { data: membersData } = useWorkspaceMembers();

  const initialOpen = useRef(localStorage.getItem('weldchat-dm-member-panel') !== 'false');
  const [showMemberPanel, setShowMemberPanel] = useState(initialOpen.current);
  const [wasToggled, setWasToggled] = useState(false);

  const { status: callStatus, channelId: callChannelId, isFullscreen, isPiP } = useWeldChatCall();
  const { isOpen: isEntitySheetOpen, close: closeEntitySheet } = useEntitySheet();
  const { rightPanel, setActiveChannelId } = useChatContext();
  const isOverlayPanelOpen = rightPanel === 'bookmarks' || rightPanel === 'filters';

  const toggleMemberPanel = (open: boolean) => {
    window.dispatchEvent(new CustomEvent('member-detail-panel-user-toggle'));
    setWasToggled(true);
    setShowMemberPanel(open);
    localStorage.setItem('weldchat-dm-member-panel', String(open));
    // Reopening the member panel while an entity sheet is up would stack
    // overlays again — dismiss the sheet so the member panel takes the slot.
    if (open && isEntitySheetOpen) closeEntitySheet();
  };

  // Entity sheet (e.g. customer detail from an `@customer` mention) and the
  // DM member-detail panel both float over the right edge — letting them
  // coexist stacks two overlays. Close the member panel whenever the entity
  // sheet opens; the channel header already renders the toggle button when
  // `!showMemberPanel`, so the user can reopen it once the sheet is gone.
  // Don't persist to localStorage — the user's saved preference is preserved.
  useEffect(() => {
    if (isEntitySheetOpen) {
      setShowMemberPanel(false);
      setWasToggled(true);
    }
  }, [isEntitySheetOpen]);

  // Bookmarks / Filters render in the right-panel slot (480px, inside the
  // content flex). The DM member-details panel is a separate fixed overlay
  // on the right edge — letting both render would stack two panels. Close the
  // member panel while bookmarks/filters is active; user can reopen it via
  // the header toggle once they close the overlay panel.
  useEffect(() => {
    if (isOverlayPanelOpen) {
      setShowMemberPanel(false);
      setWasToggled(true);
    }
  }, [isOverlayPanelOpen]);

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
  const isInCall = callStatus !== 'idle' && callStatus !== 'ended' && callChannelId === channelId && !isFullscreen && !isPiP;

  const targetMember: TeamMemberDetail | null = useMemo(() => {
    const members = membersData?.data || [];
    const found = members.find((m) => m.userId === targetUserId);
    if (!found) return null;
    return fromTeamMember(found);
  }, [membersData, targetUserId]);

  const { client } = useWeldChatRoom(channelId ?? null);

  // Auto mark DM as read on open
  useEffect(() => {
    if (channelId) markAsRead(channelId);
  }, [channelId, markAsRead]);

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

  const onMessageUpdated = useCallback((message: WeldChatRealtimeMessage) => {
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

  // When panel is saved as open and user hasn't toggled in this session,
  // bypass the animated TeamMemberDetailsPanel completely and render a
  // plain fixed div that is present from the very first paint.
  const useStaticPanel = showMemberPanel && !wasToggled;

  const renderPanel = () => {
    if (useStaticPanel) {
      // Static: always render the outer shell so it's in the DOM from frame 1.
      // Content fills in when member data arrives — no animation, no layout shift.
      return (
        <div
          className="fixed bg-background z-50 flex flex-col border-l border-border inset-0 md:inset-auto md:right-0 md:top-[60px] md:bottom-0"
          style={{ width: '480px' }}
        >
          {targetMember && (
            <TeamMemberDetailsPanel
              member={targetMember}
              isOpen
              onClose={() => toggleMemberPanel(false)}
              canManageMembers={false}
              onRemoveMember={() => {}}
              onMemberUpdated={() => queryClient.invalidateQueries({ queryKey: weldchatKeys.workspaceMembers() })}
              context="settings"
              hideMessages
              closeIcon={<X className="h-4 w-4 text-gray-500" />}
              skipAnimation
              renderContentOnly
            />
          )}
        </div>
      );
    }

    // Animated: normal behavior after user manually toggles
    return (
      <TeamMemberDetailsPanel
        member={targetMember}
        isOpen={showMemberPanel && !!targetMember}
        onClose={() => toggleMemberPanel(false)}
        canManageMembers={false}
        onRemoveMember={() => {}}
        onMemberUpdated={() => queryClient.invalidateQueries({ queryKey: weldchatKeys.workspaceMembers() })}
        context="settings"
        closeIcon={<X className="h-4 w-4 text-gray-500" />}
      />
    );
  };

  return (
    <>
      <div className="flex flex-col h-full">
        {!isInCall && (
          <ChannelHeader
            channel={channel}
            showMemberPanel={showMemberPanel}
            onToggleMemberPanel={() => toggleMemberPanel(true)}
          />
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
      {renderPanel()}
    </>
  );
}
