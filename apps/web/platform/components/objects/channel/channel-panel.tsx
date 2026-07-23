import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Hash, Lock } from 'lucide-react';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import {
  ObjectPanelTabs,
  useObjectPanelShell,
  useObjectPanelTabConfig,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { useChannel, useChannelMembers, useMessages, useBookmarks } from '@/hooks/queries/use-weldchat-queries';
import { BookmarksPanel } from '@/app/weldchat/components/bookmarks-panel';
import {
  ChatContext,
  type ChatContextValue,
  type ChatFilters,
  type ReplyTo,
} from '@/app/weldchat/components/chat-context';
import { CHANNEL_TABS, type ChannelTab } from './channel-tabs';
import { ChannelPeopleTab } from './channel-people-tab';
import { ChannelThreadsTab } from './channel-threads-tab';
import { ChannelAttachmentsTab } from './channel-attachments-tab';

const CHANNEL_PANEL_WIDTH = 400;

function ChannelAvatar({ channelType }: { channelType?: string }) {
  const Icon = channelType === 'private' ? Lock : Hash;
  return <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
}

function ChannelTitle({ name }: { name?: string }) {
  if (!name) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  return <span className="text-[15px] font-medium text-foreground truncate">{name}</span>;
}

function ChannelPanelTabsBar({
  activeTab,
  setActiveTab,
  mode,
  memberCount,
  threadsCount,
  attachmentsCount,
  bookmarksCount,
}: {
  activeTab: ChannelTab['id'];
  setActiveTab: (id: ChannelTab['id']) => void;
  mode: 'panel' | 'fullscreen';
  memberCount: number;
  threadsCount: number;
  attachmentsCount: number;
  bookmarksCount: number;
}) {
  const configEntries = useMemo(
    () =>
      CHANNEL_TABS.map((t) => ({
        id: t.id,
        label: t.label,
        required: t.required,
        defaultVisible:
          mode === 'panel'
            ? (t.defaultVisibleInPanel ?? false)
            : (t.defaultVisibleInFullscreen ?? false),
      })),
    [mode],
  );

  const { isVisible } = useObjectPanelTabConfig({
    objectType: 'channel',
    mode,
    tabs: configEntries,
  });

  useEffect(() => {
    if (isVisible(activeTab)) return;
    const fallback = CHANNEL_TABS.find((t) => isVisible(t.id));
    if (fallback && fallback.id !== activeTab) setActiveTab(fallback.id);
  }, [activeTab, isVisible, setActiveTab]);

  const counts: Record<ChannelTab['id'], number> = {
    people: memberCount,
    threads: threadsCount,
    attachments: attachmentsCount,
    bookmarks: bookmarksCount,
  };

  const tabs = useMemo(
    () =>
      CHANNEL_TABS.filter((t) => isVisible(t.id)).map((t) => ({
        id: t.id,
        label: t.label,
        icon: t.icon,
        count: counts[t.id] || undefined,
      })),
    [isVisible, memberCount, threadsCount, attachmentsCount, bookmarksCount],
  );

  return (
    <ObjectPanelTabs
      tabs={tabs}
      activeTab={activeTab}
      onChange={(id) => setActiveTab(id as ChannelTab['id'])}
    />
  );
}

export function ChannelPanel(props: ObjectPanelComponentProps) {
  const { id, initialTab, onClose } = props;
  const { data: channelData } = useChannel(id);
  const channel: any = channelData?.data;

  const { data: membersData } = useChannelMembers(id);
  const { data: messagesData } = useMessages(id);
  const { data: bookmarksData } = useBookmarks();

  const flatMessages: any[] = useMemo(
    () =>
      messagesData?.pages?.flatMap((p: any) => p.data?.messages || p.data || []) ?? [],
    [messagesData],
  );
  const memberCount = membersData?.data?.length ?? 0;
  const threadsCount = flatMessages.filter((m) => (m.threadReplyCount ?? 0) > 0).length;
  const attachmentsCount = flatMessages.reduce(
    (sum, m) => sum + (m.attachments?.length ?? 0),
    0,
  );
  const bookmarksCount =
    bookmarksData?.data?.filter((b: any) => b.channelId === id)?.length ?? 0;

  const shell = useObjectPanelShell({
    ...props,
    width: CHANNEL_PANEL_WIDTH,
    loading: !channel,
  });
  const mode = shell.mode;

  const initial: ChannelTab['id'] = useMemo(() => {
    if (initialTab && CHANNEL_TABS.some((t) => t.id === initialTab)) {
      return initialTab as ChannelTab['id'];
    }
    return 'people';
  }, [initialTab]);
  const [activeTab, setActiveTab] = useState<ChannelTab['id']>(initial);

  // The embedded panels (MemberListPanel, ChatFiltersPanel, …) call
  // `useChatContext()` because they were built for the chat layout's right
  // rail. When mounted via the global `ObjectPanelHost`, that provider is
  // gone — so we supply a local context scoped to this channel. Inherit
  // from a parent ChatContext when one happens to exist (panel opened from
  // inside a channel page) so filters and selected profile carry over.
  const parent = useContext(ChatContext);
  const [localFilters, setLocalFilters] = useState<ChatFilters>({
    type: 'all', search: '', from: [], date: undefined,
  });
  const [localReplyTo, setLocalReplyTo] = useState<ReplyTo | null>(null);
  const [localProfileUserId, setLocalProfileUserId] = useState<string | null>(null);
  const [localAgentProfileId, setLocalAgentProfileId] = useState<string | null>(null);

  const ctxValue = useMemo<ChatContextValue>(() => ({
    activeChannelId: parent?.activeChannelId ?? id,
    setActiveChannelId: parent?.setActiveChannelId ?? (() => {}),
    rightPanel: null,
    // Embedded panels only call setRightPanel(null) from their own close
    // buttons — those are hidden in `embedded` mode, but route the call to
    // the host's onClose just in case anything else triggers it.
    setRightPanel: () => onClose(),
    threadMessageId: parent?.threadMessageId ?? null,
    openThread: parent?.openThread ?? (() => {}),
    closeThread: parent?.closeThread ?? (() => {}),
    replyTo: parent?.replyTo ?? localReplyTo,
    setReplyTo: parent?.setReplyTo ?? setLocalReplyTo,
    filters: parent?.filters ?? localFilters,
    setFilters: parent?.setFilters ?? setLocalFilters,
    selectedProfileUserId: parent?.selectedProfileUserId ?? localProfileUserId,
    openUserProfile: parent?.openUserProfile ?? setLocalProfileUserId,
    closeUserProfile: parent?.closeUserProfile ?? (() => setLocalProfileUserId(null)),
    selectedAgentProfileId: parent?.selectedAgentProfileId ?? localAgentProfileId,
    openAgentProfile: parent?.openAgentProfile ?? setLocalAgentProfileId,
    closeAgentProfile: parent?.closeAgentProfile ?? (() => setLocalAgentProfileId(null)),
  }), [
    parent, id, onClose,
    localFilters, localReplyTo, localProfileUserId, localAgentProfileId,
  ]);

  return (
    <ChatContext.Provider value={ctxValue}>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        avatar={<ChannelAvatar channelType={channel?.type} />}
        title={<ChannelTitle name={channel?.name} />}
        tabs={
          <ChannelPanelTabsBar
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            mode={mode}
            memberCount={memberCount}
            threadsCount={threadsCount}
            attachmentsCount={attachmentsCount}
            bookmarksCount={bookmarksCount}
          />
        }
      >
        {activeTab === 'people' && <ChannelPeopleTab channelId={id} />}
        {activeTab === 'threads' && <ChannelThreadsTab channelId={id} messages={flatMessages} />}
        {activeTab === 'attachments' && <ChannelAttachmentsTab channelId={id} messages={flatMessages} />}
        {activeTab === 'bookmarks' && <BookmarksPanel embedded />}
      </EntityDetailView>
    </ChatContext.Provider>
  );
}
