import * as React from 'react';
import { Hash, Lock, User, FolderPlus, Trash2, Pencil, SquarePen, Plus, BellOff, Bell, Archive, Settings, AtSign, BookUser } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';

function createDmAvatarIcon(name: string, picture?: string) {
  return function DmAvatar() {
    return (
      <Avatar className="h-5 w-5 !rounded-[6px]">
        {picture && <AvatarImage src={picture} className="!rounded-[6px]" />}
        <AvatarFallback className="text-[9px] !rounded-[6px]">
          {(name || '?')[0].toUpperCase()}
        </AvatarFallback>
      </Avatar>
    );
  };
}

function createGroupDmAvatarIcon(
  members: Array<{ name?: string | null; email?: string | null; picture?: string | null }>,
) {
  const visible = members.slice(0, 2);
  return function GroupDmAvatar() {
    return (
      <div className="relative h-5 w-5 flex-shrink-0">
        {visible.map((m, i) => {
          const label = m.name || m.email || '?';
          return (
            <Avatar
              key={i}
              className={
                'h-[13px] w-[13px] absolute !rounded-[4px] border border-background ' +
                (i === 0 ? 'top-0 left-0 z-10' : 'bottom-0 right-0')
              }
            >
              {m.picture && <AvatarImage src={m.picture} className="!rounded-[4px]" />}
              <AvatarFallback className="text-[7px] !rounded-[4px]">
                {label[0]!.toUpperCase()}
              </AvatarFallback>
            </Avatar>
          );
        })}
      </div>
    );
  };
}
import type { MenuGroupProps, MenuItemProps } from '@/components/app-sidebar-layout';
import { useChannels, useDmChannels, useDeleteChannel, useMuteChannel, useArchiveChannel, useCreateSection as useCreateSectionMutation } from '@/hooks/queries/use-weldchat-queries';
import type { ChatChannel, ChatChannelMember } from '@/hooks/queries/use-weldchat-queries';
import { useChatActivityUnread, useChatDrafts } from '@/hooks/queries/use-weldchat-extras-queries';
import { getTranslations } from '@/lib/i18n';
import { useTranslations } from '@weldsuite/i18n/client';
import { useWeldChatCallOptional } from '@/contexts/weldchat-call-context';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { usePathname } from '@/lib/router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useUser } from '@clerk/clerk-react';
import { useTopic } from '@weldsuite/realtime/react';
// Sidebar dialogs are lazy-loaded — they're only rendered when the user
// opens them, so there's no reason to ship them in the main chunk.
const ChannelCreateDialog = React.lazy(() =>
  import('../components/channel-create-dialog').then((m) => ({ default: m.ChannelCreateDialog })),
);
const DmCreateDialog = React.lazy(() =>
  import('../components/dm-create-dialog').then((m) => ({ default: m.DmCreateDialog })),
);
const SectionCreateDialog = React.lazy(() =>
  import('../components/section-create-dialog').then((m) => ({ default: m.SectionCreateDialog })),
);
const SectionRenameDialog = React.lazy(() =>
  import('../components/section-rename-dialog').then((m) => ({ default: m.SectionRenameDialog })),
);
const GroupSettingsDialog = React.lazy(() =>
  import('../components/group-settings-dialog').then((m) => ({ default: m.GroupSettingsDialog })),
);
import type { GroupSettingsTarget } from '../components/group-settings-dialog';
import { useChatSections } from './use-chat-sections';
import { getEntityTypeInfo, listEntityTypes } from '@/lib/entity-channels/registry';
import { LucideDynamicIcon } from '@/components/lucide-dynamic-icon';
import { useUserPreferences } from '@/hooks/queries/use-settings-queries';
import type { UserPreferences } from '@/hooks/queries/use-settings-queries';
import {
  applyTopN,
  DEFAULT_GROUP_FILTER,
  filterChannels,
  sortChannels,
  type GroupFilterSettings,
  type WeldchatGroupFilters,
} from '../lib/group-filter';

const EMPTY_SIDEBAR: { menuGroups: MenuGroupProps[]; dialogs: React.ReactNode } = {
  menuGroups: [],
  dialogs: null,
};

/** DM channel row — a channel row extended with the DM-specific `otherMembers`
 * field `/chat-dm` projects (mirrors the hooks file's private `ChatDm`). */
export interface DmChannel extends ChatChannel {
  otherMembers?: ChatChannelMember[];
}

function resolveLiveGroupChannels(
  groupKey: string,
  dms: DmChannel[],
  channels: ChatChannel[],
  entityChannels: ChatChannel[],
  channelSectionMap: Record<string, string | null | undefined>,
): ChatChannel[] {
  if (groupKey === 'dm') return dms;
  if (groupKey.startsWith('entity:')) {
    const entityType = groupKey.slice('entity:'.length);
    return entityChannels.filter((ch) => ch.entityType === entityType);
  }
  if (groupKey.startsWith('section:')) {
    const sectionId = groupKey.slice('section:'.length);
    return channels.filter((ch) => {
      if (ch.type === 'dm' || ch.type === 'entity') return false;
      const assigned = channelSectionMap[ch.id];
      return sectionId === 'default' ? !assigned : assigned === sectionId;
    });
  }
  // Per-channel settings — `channel:<id>` resolves to a single-channel
  // "group of one" so the existing GroupSettingsDialog works unchanged.
  if (groupKey.startsWith('channel:')) {
    const channelId = groupKey.slice('channel:'.length);
    const found =
      channels.find((ch) => ch.id === channelId) ??
      dms.find((ch) => ch.id === channelId) ??
      entityChannels.find((ch) => ch.id === channelId);
    return found ? [found] : [];
  }
  return [];
}

export function useWeldchatSidebarItems(isActive: boolean): {
  menuGroups: MenuGroupProps[];
  dialogs: React.ReactNode;
} {
  const [showNewChannel, setShowNewChannel] = React.useState(false);
  const [showNewDm, setShowNewDm] = React.useState(false);
  const [showNewSection, setShowNewSection] = React.useState(false);
  const [pendingSectionId, setPendingSectionId] = React.useState<string | null>(null);
  const [renamingSectionId, setRenamingSectionId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const [settingsTarget, setSettingsTarget] = React.useState<GroupSettingsTarget | null>(null);
  /** Per-group session-level collapse override: undefined = use settings.collapsedByDefault, true/false = user toggled. */
  const [collapseToggles, setCollapseToggles] = React.useState<Map<string, boolean>>(new Map());
  /** Per-group manual reordering: maps groupKey -> array of channel ids in user's chosen order. */
  const [manualOrder, setManualOrder] = React.useState<Map<string, string[]>>(new Map());

  const { data: userPrefs } = useUserPreferences();
  const groupFilters: WeldchatGroupFilters =
    (userPrefs?.uiPreferences as (NonNullable<UserPreferences['uiPreferences']> & { weldchatGroupFilters?: WeldchatGroupFilters }) | undefined)
      ?.weldchatGroupFilters ?? {};
  const getFilter = (key: string): GroupFilterSettings => ({
    ...DEFAULT_GROUP_FILTER,
    ...(groupFilters[key] ?? {}),
  });
  const isCollapsed = (groupKey: string): boolean => {
    if (collapseToggles.has(groupKey)) return !!collapseToggles.get(groupKey);
    return !!getFilter(groupKey).collapsedByDefault;
  };
  const toggleGroupCollapse = (groupKey: string) => {
    setCollapseToggles((prev) => {
      const next = new Map(prev);
      const current = prev.has(groupKey) ? prev.get(groupKey)! : !!getFilter(groupKey).collapsedByDefault;
      next.set(groupKey, !current);
      return next;
    });
  };

  const { data: channelsData } = useChannels();
  const { data: dmsData } = useDmChannels();
  const { mutate: deleteChannel } = useDeleteChannel();
  const { mutate: muteChannel } = useMuteChannel();
  const { mutate: archiveChannel } = useArchiveChannel();
  const {
    sections,
    channelSectionMap,
    createSection,
    deleteSection,
    renameSection,
    moveChannelToSection,
  } = useChatSections();
  const createSectionMutation = useCreateSectionMutation();

  const callCtx = useWeldChatCallOptional();
  const activeCallChannelId = callCtx?.channelId ?? null;
  const callStatus = callCtx?.status ?? 'idle';
  const joinCall = callCtx?.joinCall;
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  const { user } = useUser();

  const t = getTranslations('weldchat');
  const st = useTranslations();
  const { data: activityUnreadData } = useChatActivityUnread();
  const { data: draftsData } = useChatDrafts();
  const unreadActivityCount: number = activityUnreadData?.data?.count ?? 0;

  const channels: ChatChannel[] = React.useMemo(
    () => (isActive ? (channelsData?.data || []) : []),
    [isActive, channelsData],
  );
  const dms: DmChannel[] = React.useMemo(
    () => (isActive ? ((dmsData?.data ?? []) as DmChannel[]) : []),
    [isActive, dmsData],
  );

  // Suppress the Drafts badge for the channel the user is actively viewing —
  // the autosave creates a server draft within seconds of typing, but it's
  // not really a "left-behind draft" until the user navigates away.
  const pathname = usePathname() ?? '';
  const activeChannelId: string | null = (() => {
    // /weldchat/dm/group/<channelId>
    const groupDmMatch = pathname.match(/^\/weldchat\/dm\/group\/([^/]+)/);
    if (groupDmMatch) return groupDmMatch[1] ?? null;
    // /weldchat/dm/<userId>  → resolve to the DM channel
    const dmMatch = pathname.match(/^\/weldchat\/dm\/([^/]+)/);
    if (dmMatch) {
      const targetUserId = dmMatch[1];
      const dm = dms.find((d) =>
        d.otherMembers?.some((m) => m.userId === targetUserId),
      );
      return dm?.id ?? null;
    }
    // /weldchat/<channelId>  (excluding the reserved top-level routes)
    const channelMatch = pathname.match(/^\/weldchat\/([^/]+)/);
    const reserved = new Set(['activity', 'drafts', 'directories', 'bookmarks', 'search', 'thread']);
    if (channelMatch && !reserved.has(channelMatch[1] ?? '')) return channelMatch[1] ?? null;
    return null;
  })();

  const draftCount: number = (() => {
    const drafts = draftsData?.data ?? [];
    if (!activeChannelId) return drafts.length;
    return drafts.filter((d) => d?.channelId !== activeChannelId).length;
  })();

  // Single batch fetch at mount — push events below keep the cache in sync.
  const activeCallsKey = ['weldchat', 'active-calls'] as const;
  const { data: activeCallsList } = useQuery({
    queryKey: activeCallsKey,
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: Array<{ channelId: string; callId: string; callType: 'voice' | 'video' }> }>(
        '/chat-calls/active',
      );
      return res?.data ?? [];
    },
    enabled: isActive,
    staleTime: Infinity,
  });

  // Push updates: on CALL_STARTED / CALL_ENDED from the user's topic, patch the cache.
  useTopic<{ channelId: string; callId: string; callType?: 'voice' | 'video' }>(
    user?.id && isActive ? `chat.user.${user.id}` : '',
    (event) => {
      if (event.event !== 'call_started' && event.event !== 'call_ended') return;
      queryClient.setQueryData<Array<{ channelId: string; callId: string; callType: 'voice' | 'video' }>>(
        activeCallsKey,
        (prev) => {
          const list = prev ?? [];
          if (event.event === 'call_started') {
            if (list.some((c) => c.channelId === event.data.channelId)) return list;
            return [
              ...list,
              {
                channelId: event.data.channelId,
                callId: event.data.callId,
                callType: event.data.callType ?? 'voice',
              },
            ];
          }
          return list.filter((c) => c.callId !== event.data.callId);
        },
      );
    },
  );

  const activeCallChannels = new Map<string, { type: 'voice' | 'video'; id: string }>();
  for (const call of activeCallsList ?? []) {
    activeCallChannels.set(call.channelId, { type: call.callType, id: call.callId });
  }
  if ((callStatus === 'connected' || callStatus === 'connecting') && activeCallChannelId) {
    if (!activeCallChannels.has(activeCallChannelId)) {
      activeCallChannels.set(activeCallChannelId, { type: 'voice', id: '' });
    }
  }

  // Auto-assign newly created channel to pending section
  const prevChannelIdsRef = React.useRef<Set<string> | null>(null);
  React.useEffect(() => {
    const currentIds = new Set(channels.map((ch) => ch.id));
    if (pendingSectionId && prevChannelIdsRef.current !== null) {
      for (const id of currentIds) {
        if (!prevChannelIdsRef.current.has(id)) {
          moveChannelToSection(id, pendingSectionId);
          setPendingSectionId(null);
          break;
        }
      }
    }
    prevChannelIdsRef.current = currentIds;
  }, [channels, pendingSectionId, moveChannelToSection]);

  if (!isActive) {
    return EMPTY_SIDEBAR;
  }

  const allChannelItems: MenuItemProps[] = channels
    .filter((ch) => ch.type !== 'dm' && ch.type !== 'entity')
    .map((ch): MenuItemProps => {
      const hasUnread = ch.lastMessageAt && (!ch.lastReadAt || new Date(ch.lastMessageAt) > new Date(ch.lastReadAt));
      const mentionCount = ch.unreadMentionCount || 0;
      return {
      title: ch.name ?? '',
      href: `/weldchat/${ch.id}`,
      icon: ch.type === 'private' ? Lock : Hash,
      bold: !!hasUnread,
      badge: mentionCount > 0 ? `${mentionCount}` : undefined,
      activeCall: activeCallChannels.has(ch.id),
      activeCallType: activeCallChannels.get(ch.id)?.type,
      activeCallId: activeCallChannels.get(ch.id)?.id,
      onJoinCall: activeCallChannels.has(ch.id) && joinCall ? () => {
        const callId = activeCallChannels.get(ch.id)?.id;
        if (callId) joinCall(callId);
      } : undefined,
      id: ch.id,
      actions: [
        {
          label: ch.isMuted ? st('sweep.weldchat.sidebar.unmute') : st('sweep.weldchat.sidebar.mute'),
          icon: ch.isMuted ? Bell : BellOff,
          onClick: () => muteChannel({ channelId: ch.id, mute: !ch.isMuted }),
        },
        ...(sections.length > 0
          ? sections
              .filter((sec) => channelSectionMap[ch.id] !== sec.id)
              .map((sec) => ({
                label: st('sweep.weldchat.sidebar.moveToSection', { name: sec.name }),
                icon: FolderPlus,
                onClick: () => moveChannelToSection(ch.id, sec.id),
              }))
          : []),
        ...(channelSectionMap[ch.id]
          ? [{
              label: st('sweep.weldchat.sidebar.removeFromSection'),
              icon: FolderPlus,
              onClick: () => moveChannelToSection(ch.id, null),
            }]
          : []),
        {
          label: st('sweep.weldchat.sidebar.settings'),
          icon: Settings,
          onClick: () =>
            setSettingsTarget({
              groupKey: `channel:${ch.id}`,
              groupLabel: ch.name ?? '',
              channels: [ch],
            }),
        },
        {
          label: st('sweep.weldchat.sidebar.archive'),
          icon: Archive,
          onClick: () => archiveChannel(ch.id),
        },
        {
          label: st('sweep.weldchat.sidebar.delete'),
          icon: Trash2,
          onClick: () => deleteChannel(ch.id),
        },
      ],
    };
    });

  const dmItems: MenuItemProps[] = [];
  const seenDmUsers = new Set<string>();
  for (const dm of dms) {
    const otherMembers = (dm.otherMembers ?? []).filter((m) => m?.userId);
    const isGroup = otherMembers.length > 1;
    const hasUnread = dm.lastMessageAt && (!dm.lastReadAt || new Date(dm.lastMessageAt) > new Date(dm.lastReadAt));
    const mentionCount = dm.unreadMentionCount || 0;
    const commonActions = [
      {
        label: dm.isMuted ? st('sweep.weldchat.sidebar.unmute') : st('sweep.weldchat.sidebar.mute'),
        icon: dm.isMuted ? Bell : BellOff,
        onClick: () => muteChannel({ channelId: dm.id, mute: !dm.isMuted }),
      },
      {
        label: st('sweep.weldchat.sidebar.settings'),
        icon: Settings,
        onClick: () =>
          setSettingsTarget({
            groupKey: `channel:${dm.id}`,
            groupLabel:
              dm.name ??
              (dm.otherMembers?.[0]?.name ?? dm.otherMembers?.[0]?.email ?? st('sweep.weldchat.sidebar.directMessageFallback')),
            channels: [dm],
          }),
      },
      {
        label: st('sweep.weldchat.sidebar.archive'),
        icon: Archive,
        onClick: () => archiveChannel(dm.id),
      },
      {
        label: st('sweep.weldchat.sidebar.delete'),
        icon: Trash2,
        onClick: () => deleteChannel(dm.id),
      },
    ];

    if (isGroup) {
      if (seenDmUsers.has(dm.id)) continue;
      seenDmUsers.add(dm.id);
      const displayName =
        otherMembers.map((m) => m.name || m.email || st('sweep.weldchat.sidebar.unknownMember')).join(', ') ||
        dm.name ||
        st('sweep.weldchat.channelEmptyState.groupFallback');
      dmItems.push({
        title: displayName,
        href: `/weldchat/dm/group/${dm.id}`,
        icon: createGroupDmAvatarIcon(otherMembers),
        bold: !!hasUnread,
        badge: mentionCount > 0 ? `${mentionCount}` : undefined,
        actions: commonActions,
        id: dm.id,
      });
      continue;
    }

    const other = otherMembers[0];
    const otherUserId = other?.userId;
    const key = otherUserId || dm.id;
    if (seenDmUsers.has(key)) continue;
    seenDmUsers.add(key);
    const displayName = other?.name || other?.email || dm.name || st('sweep.weldchat.sidebar.directMessageDisplayFallback');
    dmItems.push({
      title: displayName,
      href: otherUserId ? `/weldchat/dm/${otherUserId}` : `/weldchat/dm/${dm.id}`,
      icon: other ? createDmAvatarIcon(displayName, other.picture) : User,
      bold: !!hasUnread,
      badge: mentionCount > 0 ? `${mentionCount}` : undefined,
      actions: commonActions,
      id: dm.id,
    });
  }

  // Entity-linked channels (tasks, tickets, …) — grouped by entityType in the sidebar.
  const entityChannels = channels.filter((ch) => ch.type === 'entity' && ch.entityType);
  const entityGroups = new Map<string, MenuItemProps[]>();
  for (const ch of entityChannels) {
    const entityType = ch.entityType ?? '';
    const list = entityGroups.get(entityType) ?? [];
    const hasUnread = ch.lastMessageAt && (!ch.lastReadAt || new Date(ch.lastMessageAt) > new Date(ch.lastReadAt));
    const mentionCount = ch.unreadMentionCount || 0;
    const info = getEntityTypeInfo(entityType);
    const iconName = info?.icon ?? 'Hash';
    const Icon: React.ComponentType<{ className?: string }> = (props) => (
      <LucideDynamicIcon name={iconName} className={props.className} />
    );
    list.push({
      title: ch.entityDisplayName || ch.name || '',
      href: `/weldchat/${ch.id}`,
      icon: Icon,
      bold: !!hasUnread,
      badge: mentionCount > 0 ? `${mentionCount}` : undefined,
      id: ch.id,
      actions: [
        {
          label: ch.isMuted ? st('sweep.weldchat.sidebar.unmute') : st('sweep.weldchat.sidebar.mute'),
          icon: ch.isMuted ? Bell : BellOff,
          onClick: () => muteChannel({ channelId: ch.id, mute: !ch.isMuted }),
        },
        {
          label: st('sweep.weldchat.sidebar.settings'),
          icon: Settings,
          onClick: () =>
            setSettingsTarget({
              groupKey: `channel:${ch.id}`,
              groupLabel: ch.entityDisplayName || ch.name || '',
              channels: [ch],
            }),
        },
        {
          label: st('sweep.weldchat.sidebar.delete'),
          icon: Trash2,
          onClick: () => deleteChannel(ch.id),
        },
      ],
    });
    entityGroups.set(entityType, list);
  }

  // Helper: apply per-group filter + sort + topN to a list of items, given the
  // underlying source channels (so we can filter on rich metadata like
  // lastMessageAt / isMuted, then map back to display items by id).
  const activeCallChannelIdSet = new Set<string>(activeCallChannels.keys());
  function applyFilterAndSort(
    items: MenuItemProps[],
    sourceChannels: ChatChannel[],
    key: string,
  ): MenuItemProps[] {
    const settings = getFilter(key);
    const enriched = sourceChannels.map((ch) => ({
      ...ch,
      hasActiveCall: activeCallChannelIdSet.has(ch.id),
    }));
    const filtered = filterChannels(enriched, settings, activeCallChannelIdSet);
    const sorted = sortChannels(filtered, settings);
    const itemsById = new Map<string, MenuItemProps>(
      items.filter((i) => !!i.id).map((i) => [i.id as string, i]),
    );
    let ordered = sorted
      .map((ch) => itemsById.get(ch.id))
      .filter((i): i is MenuItemProps => Boolean(i));

    // Apply manual drag-and-drop order if the user has reordered this group.
    const manual = manualOrder.get(key);
    if (manual && manual.length > 0) {
      const present = new Map(ordered.map((i) => [i.id as string, i]));
      const head: MenuItemProps[] = [];
      for (const id of manual) {
        const item = present.get(id);
        if (item) {
          head.push(item);
          present.delete(id);
        }
      }
      // New / unordered channels keep their sort-position at the end.
      ordered = [...head, ...present.values()];
    }
    return applyTopN(ordered, settings.topN);
  }

  function applyPeekFilter(
    items: MenuItemProps[],
    sourceChannels: ChatChannel[],
    key: string,
  ): MenuItemProps[] {
    const settings = getFilter(key);
    if (!settings.peekActiveWhenCollapsed) return [];
    const now = Date.now();
    const recentMs = (settings.peekRecentMinutes ?? 60) * 60 * 1000;
    const peekIds = new Set<string>();
    for (const ch of sourceChannels) {
      const active = activeCallChannelIdSet.has(ch.id);
      const hasUnread =
        !!ch.lastMessageAt &&
        (!ch.lastReadAt || new Date(ch.lastMessageAt).getTime() > new Date(ch.lastReadAt).getTime());
      const recently =
        !!ch.lastMessageAt && now - new Date(ch.lastMessageAt).getTime() < recentMs;
      const matched =
        (settings.peekMentions && (ch.unreadMentionCount ?? 0) > 0) ||
        (settings.peekUnread && hasUnread) ||
        (settings.peekActiveCalls && active) ||
        (settings.peekPinned && ch.isPinned) ||
        (settings.peekFavorited && ch.isFavorite) ||
        (settings.peekRecentlyActive && recently);
      if (matched) peekIds.add(ch.id);
    }
    const subset = items.filter((i) => i.id && peekIds.has(i.id));
    return applyTopN(subset, settings.peekMaxItems ?? null);
  }

  function decorateLabel(label: string): string {
    return label;
  }

  function shouldShowGroup(items: MenuItemProps[], key: string): boolean {
    const settings = getFilter(key);
    if (items.length === 0 && settings.hideWhenEmpty) return false;
    return true;
  }

  function makeReorderHandler(groupKey: string) {
    return (newItems: MenuItemProps[]) => {
      const ids = newItems.map((i) => i.id ?? '').filter((s) => s.length > 0);
      setManualOrder((prev) => {
        const next = new Map(prev);
        next.set(groupKey, ids);
        return next;
      });
    };
  }

  function makeSettingsAction(
    groupKey: string,
    groupLabel: string,
    sourceChannels: ChatChannel[],
  ): NonNullable<MenuGroupProps['groupContextMenu']>[number] {
    return {
      label: st('sweep.weldchat.sidebar.settings'),
      icon: Settings,
      onClick: () => setSettingsTarget({ groupKey, groupLabel, channels: sourceChannels }),
    };
  }

  // Build menu groups
  const menuGroups: MenuGroupProps[] = [];

  // Top navigation group (Activity / Drafts / Directories) — no label header.
  menuGroups.push({
    group: '',
    groupKey: 'weldchat:top-nav',
    hideLabel: true,
    items: [
      {
        title: t.activity ?? 'Activity',
        href: '/weldchat/activity',
        icon: AtSign,
        bold: unreadActivityCount > 0,
        badge: unreadActivityCount > 0 ? String(unreadActivityCount) : undefined,
      },
      {
        title: t.drafts ?? 'Drafts',
        href: '/weldchat/drafts',
        icon: SquarePen,
        bold: draftCount > 0,
        badge: draftCount > 0 ? String(draftCount) : undefined,
      },
      {
        title: t.directories ?? 'Directories',
        href: '/weldchat/directories',
        icon: BookUser,
      },
    ],
  });

  const dmKey = 'dm';
  const filteredDmItems = applyFilterAndSort(dmItems, dms, dmKey);
  const dmCollapsed = isCollapsed(dmKey);
  const dmDisplayItems = dmCollapsed
    ? applyPeekFilter(filteredDmItems, dms, dmKey)
    : filteredDmItems;
  if (shouldShowGroup(filteredDmItems, dmKey)) {
    const dmAddButton = React.createElement(
      'button',
      {
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation();
          setShowNewDm(true);
        },
        className:
          'opacity-0 group-hover/label:opacity-100 transition-opacity flex items-center justify-center w-5 h-5 rounded-[6px] hover:bg-gray-200 dark:hover:bg-accent text-muted-foreground hover:text-foreground',
        title: st('sweep.weldchat.sidebar.addDirectMessage'),
      },
      React.createElement('span', { className: 'sr-only' }, st('sweep.weldchat.sidebar.addDirectMessagesSrOnly')),
      React.createElement(Plus, { className: 'h-3.5 w-3.5', 'aria-hidden': true }),
    );
    menuGroups.push({
      group: decorateLabel(st('sweep.weldchat.sidebar.directMessagesGroup')),
      groupKey: dmKey,
      items: dmDisplayItems,
      collapsed: dmCollapsed,
      // Keep the header (and its "New DM" affordance) visible even with zero
      // DMs — otherwise unified-module-sidebar drops the empty group and a
      // user with no conversations can never start their first DM from the
      // sidebar. When the user opts into hiding empty groups
      // (hideWhenEmpty), the hook's shouldShowGroup() already skips the push
      // above, so this flag never fights that preference.
      keepWhenEmpty: true,
      onToggleCollapse: () => toggleGroupCollapse(dmKey),
      draggable: true,
      onReorder: makeReorderHandler(dmKey),
      onAdd: () => setShowNewDm(true),
      customAddButton: dmAddButton,
      groupContextMenu: [
        {
          label: st('sweep.weldchat.sidebar.muteAll'),
          icon: BellOff,
          onClick: () => {
            for (const dm of dms) {
              if (!dm.isMuted) muteChannel({ channelId: dm.id, mute: true });
            }
          },
        },
        {
          label: st('sweep.weldchat.sidebar.unmuteAll'),
          icon: Bell,
          onClick: () => {
            for (const dm of dms) {
              if (dm.isMuted) muteChannel({ channelId: dm.id, mute: false });
            }
          },
        },
        makeSettingsAction(dmKey, st('sweep.weldchat.sidebar.directMessagesGroup'), dms),
      ],
    });
  }

  // Insert one group per entity type that has at least one channel,
  // using the client-side registry for the label.
  for (const info of listEntityTypes()) {
    const groupItems = entityGroups.get(info.type);
    if (!groupItems || groupItems.length === 0) continue;
    const sourceChannels = entityChannels.filter((ch) => ch.entityType === info.type);
    const entityKey = `entity:${info.type}`;
    const filteredItems = applyFilterAndSort(groupItems, sourceChannels, entityKey);
    if (!shouldShowGroup(filteredItems, entityKey)) continue;
    const entityCollapsed = isCollapsed(entityKey);
    const entityDisplayItems = entityCollapsed
      ? applyPeekFilter(filteredItems, sourceChannels, entityKey)
      : filteredItems;
    menuGroups.push({
      group: decorateLabel(info.label),
      groupKey: entityKey,
      items: entityDisplayItems,
      collapsed: entityCollapsed,
      onToggleCollapse: () => toggleGroupCollapse(entityKey),
      draggable: true,
      onReorder: makeReorderHandler(entityKey),
      groupContextMenu: [
        {
          label: st('sweep.weldchat.sidebar.muteAll'),
          icon: BellOff,
          onClick: () => {
            for (const ch of sourceChannels) {
              if (!ch.isMuted) muteChannel({ channelId: ch.id, mute: true });
            }
          },
        },
        {
          label: st('sweep.weldchat.sidebar.unmuteAll'),
          icon: Bell,
          onClick: () => {
            for (const ch of sourceChannels) {
              if (ch.isMuted) muteChannel({ channelId: ch.id, mute: false });
            }
          },
        },
        {
          label: st('sweep.weldchat.sidebar.archiveAll'),
          icon: Archive,
          onClick: () => {
            for (const ch of sourceChannels) {
              archiveChannel(ch.id);
            }
          },
          destructive: true,
        },
        makeSettingsAction(entityKey, info.label, sourceChannels),
      ],
    });
  }

  // Build all channel sections — default "Channels" is treated as id=null.
  // A channel is unsectioned when it has no sectionId OR its sectionId
  // doesn't match any existing section (e.g. the section was deleted).
  // The default group is always shown when there are unsectioned channels,
  // so they can never silently disappear from the sidebar.
  const validSectionIds = new Set(sections.map((s) => s.id));
  const isUnsectioned = (channelId: string) => {
    const sectionId = channelSectionMap[channelId];
    return !sectionId || !validSectionIds.has(sectionId);
  };
  const unsectionedChannelCount = allChannelItems.filter(
    (ch) => isUnsectioned(ch.id ?? ''),
  ).length;
  const allSections: { id: string | null; name: string }[] = [
    ...sections.map((s) => ({ id: s.id as string | null, name: s.name })),
  ];
  if (sections.length === 0 || unsectionedChannelCount > 0) {
    const hasUserChannelsSection = sections.some((s) => s.name === 'Channels');
    allSections.push({
      id: null,
      name: hasUserChannelsSection
        ? st('sweep.weldchat.sidebar.otherChannels')
        : st('sweep.weldchat.sidebar.channels'),
    });
  }
  const totalSections = allSections.length;

  for (const section of allSections) {
    const sectionChannels = allChannelItems.filter((ch) =>
      section.id ? channelSectionMap[ch.id ?? ''] === section.id : isUnsectioned(ch.id ?? ''),
    );
    const sectionKey = `section:${section.id ?? 'default'}`;
    const sectionSourceChannels = channels.filter(
      (ch) =>
        ch.type !== 'dm' &&
        ch.type !== 'entity' &&
        (section.id ? channelSectionMap[ch.id] === section.id : isUnsectioned(ch.id)),
    );
    const filteredSectionChannels = applyFilterAndSort(
      sectionChannels,
      sectionSourceChannels,
      sectionKey,
    );
    if (!shouldShowGroup(filteredSectionChannels, sectionKey)) continue;

    const canDelete = totalSections > 1;

    const contextMenu: NonNullable<MenuGroupProps['groupContextMenu']> = [
      {
        label: st('sweep.weldchat.sidebar.addChannel'),
        icon: Plus,
        onClick: () => {
          if (section.id) setPendingSectionId(section.id);
          setShowNewChannel(true);
        },
      },
      {
        label: st('sweep.weldchat.sidebar.newSection'),
        icon: FolderPlus,
        onClick: () => setShowNewSection(true),
      },
      {
        label: st('sweep.weldchat.sidebar.rename'),
        icon: Pencil,
        onClick: () => {
          if (section.id) {
            setRenamingSectionId(section.id);
            setRenameValue(section.name);
          } else {
            // For the default section, create it as a real section first
            createSectionMutation.mutate({ name: section.name }, {
              onSuccess: (result) => {
                const newId = result?.data?.id;
                if (newId) {
                  setRenamingSectionId(newId);
                  setRenameValue(section.name);
                }
              },
            });
          }
        },
      },
      makeSettingsAction(sectionKey, section.name, sectionSourceChannels),
    ];

    if (canDelete) {
      contextMenu.push({
        label: st('sweep.weldchat.sidebar.delete'),
        icon: Trash2,
        onClick: () => {
          if (section.id) deleteSection(section.id);
        },
        destructive: true,
      });
    }

    const addButton = React.createElement(
      'div',
      { className: 'flex items-center gap-0.5 opacity-0 group-hover/label:opacity-100 transition-opacity' },
      React.createElement(
        'button',
        {
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation();
            if (section.id) setPendingSectionId(section.id);
            setShowNewChannel(true);
          },
          className: 'flex items-center justify-center w-5 h-5 rounded-[6px] hover:bg-gray-200 dark:hover:bg-accent text-muted-foreground hover:text-foreground transition-colors',
          title: st('sweep.weldchat.sidebar.newChannel'),
        },
        React.createElement('svg', {
          xmlns: 'http://www.w3.org/2000/svg',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className: 'h-3.5 w-3.5',
        }, React.createElement('path', { d: 'M5 12h14' }), React.createElement('path', { d: 'M12 5v14' })),
      ),
      React.createElement(
        'button',
        {
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation();
            setShowNewSection(true);
          },
          className: 'flex items-center justify-center w-5 h-5 rounded-[6px] hover:bg-gray-200 dark:hover:bg-accent text-muted-foreground hover:text-foreground transition-colors',
          title: st('sweep.weldchat.sidebar.newSection'),
        },
        React.createElement(FolderPlus, { className: 'h-3.5 w-3.5' }),
      ),
    );

    const sectionCollapsed = isCollapsed(sectionKey);
    const sectionDisplayItems = sectionCollapsed
      ? applyPeekFilter(filteredSectionChannels, sectionSourceChannels, sectionKey)
      : filteredSectionChannels;
    menuGroups.push({
      group: decorateLabel(section.name),
      items: sectionDisplayItems,
      collapsed: sectionCollapsed,
      onToggleCollapse: () => toggleGroupCollapse(sectionKey),
      draggable: true,
      onReorder: makeReorderHandler(sectionKey),
      groupKey: sectionKey,
      keepWhenEmpty: true,
      // Only wire onAdd when the section has no channels at all — this triggers
      // the dashed "+ Add channel" placeholder in the sidebar layout. When the
      // section is just collapsed (items empty due to peek filter), we leave
      // onAdd unset so the placeholder doesn't appear misleadingly.
      onAdd:
        filteredSectionChannels.length === 0
          ? () => {
              if (section.id) setPendingSectionId(section.id);
              setShowNewChannel(true);
            }
          : undefined,
      onCrossGroupDrop: (channelId, fromKey, toKey) => {
        // Only handle drops between channel sections (not from/to DM or entity groups).
        if (!fromKey.startsWith('section:') || !toKey.startsWith('section:')) return;
        const targetSectionId = toKey.slice('section:'.length);
        moveChannelToSection(channelId, targetSectionId === 'default' ? null : targetSectionId);
      },
      groupContextMenu: contextMenu,
      customAddButton: addButton,
      addLabel: st('sweep.weldchat.sidebar.addChannel'),
    });
  }

  const dialogs = (
    <React.Suspense fallback={null}>
      {showNewChannel && (
        <ChannelCreateDialog open={showNewChannel} onOpenChange={setShowNewChannel} />
      )}
      {showNewDm && <DmCreateDialog open={showNewDm} onOpenChange={setShowNewDm} />}
      {showNewSection && (
        <SectionCreateDialog
          open={showNewSection}
          onOpenChange={setShowNewSection}
          onCreateSection={createSection}
        />
      )}
      {renamingSectionId && (
        <SectionRenameDialog
          open={!!renamingSectionId}
          onOpenChange={(open) => { if (!open) setRenamingSectionId(null); }}
          currentName={renameValue}
          onRename={(name) => {
            if (renamingSectionId) renameSection(renamingSectionId, name);
            setRenamingSectionId(null);
          }}
        />
      )}
      {settingsTarget && (
        <GroupSettingsDialog
          open={!!settingsTarget}
          onOpenChange={(open) => { if (!open) setSettingsTarget(null); }}
          target={
            settingsTarget
              ? {
                  ...settingsTarget,
                  channels: resolveLiveGroupChannels(
                    settingsTarget.groupKey,
                    dms,
                    channels,
                    entityChannels,
                    channelSectionMap,
                  ),
                }
              : null
          }
        />
      )}
    </React.Suspense>
  );

  return { menuGroups, dialogs };
}
