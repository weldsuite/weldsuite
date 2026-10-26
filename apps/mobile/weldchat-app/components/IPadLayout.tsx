import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Pressable,
  StyleSheet,
  Image,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Image as ExpoImage } from 'expo-image';
import {
  Hash,
  Lock,
  ChevronDown,
  ChevronRight,
  Plus,
  Search,
  PenSquare,
  MoreHorizontal,
} from 'lucide-react-native';
import { useUser } from '@clerk/expo';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { BRAND } from '@/lib/brand';

import type { ThemeColors } from '@/lib/theme-colors';

import { appApi } from '@/services/app-api';
import { useChatUserEvents } from '@/hooks/useChatUserEvents';
import { useChatCache } from '@/hooks/useChatCache';
import { useRecordChatGroups } from '@/hooks/useRecordChatGroups';
import { useI18n } from '@/lib/i18n';
import {
  RECORD_CHAT_TYPES,
  buildRecordGroups,
  hasUnreadMentions,
  isUnreadRecordChat,
  recordChatName,
  recordRefreshFor,
} from '@/lib/record-chats/rules';
import { recordChatIcon, recordGroupLabel } from '@/lib/record-chats/registry';
import { ChannelView } from './chat/ChannelView';

interface Channel {
  id: string;
  name: string;
  type: string;
  unreadCount?: number;
}

interface DmChannel {
  id: string;
  name: string;
  picture?: string | null;
  type: string;
  unreadCount?: number;
  lastMessage?: string;
  lastMessageAt?: string;
}

const SIDEBAR_WIDTH = 320;

/**
 * What the sidebar should have open after a reload. A selection that is no
 * longer in either list (the channel was deleted, or the user left it) is
 * cleared; with nothing selected, the first channel, else the first DM. An
 * open record chat stays open, followed or not (unfollowing it from its header
 * takes it out of the sidebar, but it is still readable).
 */
function nextSelection(
  prev: string | null,
  channels: readonly Channel[],
  dms: readonly DmChannel[],
  openRecordChatId: string | null,
): string | null {
  if (prev) {
    const stillListed =
      prev === openRecordChatId || channels.some((c) => c.id === prev) || dms.some((d) => d.id === prev);
    return stillListed ? prev : null;
  }
  return channels[0]?.id ?? dms[0]?.id ?? null;
}

export function IPadLayout() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [dms, setDms] = useState<DmChannel[]>([]);
  const [search, setSearch] = useState('');
  const [channelsCollapsed, setChannelsCollapsed] = useState(false);
  const [dmsCollapsed, setDmsCollapsed] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const router = useRouter();
  const { user } = useUser();
  const { t, format } = useI18n();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.top, insets.bottom), [colors, insets.top, insets.bottom]);
  const cache = useChatCache();
  // Set when a network fetch lands so a late cache read can't overwrite it.
  const networkLoadedRef = useRef(false);

  // Cache-first paint so the sidebar isn't blank on cold start.
  // Only hydrate channels here — the phone DMs tab caches a mapped shape that
  // doesn't match this sidebar's raw DM rows.
  useEffect(() => {
    let cancelled = false;
    networkLoadedRef.current = false;
    void (async () => {
      const cachedChannels = await cache.getChannels();
      if (cancelled || networkLoadedRef.current) return;
      const chs = (cachedChannels as Channel[] | null) ?? [];
      setChannels(chs);
      if (chs.length) {
        setSelectedChannelId((prev) => prev ?? chs[0].id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cache]);

  // Record chats (companies, people, tasks, projects, domains) the user follows.
  const recordChats = useRecordChatGroups();
  const { refresh: refreshRecordChats } = recordChats;
  const recordRows = useMemo(
    () => RECORD_CHAT_TYPES.flatMap((type) => recordChats.rows[type] ?? []),
    [recordChats.rows],
  );
  const recordChatIdsRef = useRef<ReadonlySet<string>>(new Set());
  recordChatIdsRef.current = new Set(recordRows.map((row) => row.id));
  // The record chat open in the right pane, if that is what is selected.
  const openRecordChatIdRef = useRef<string | null>(null);
  const selectConversation = useCallback((id: string, isRecordChat = false) => {
    openRecordChatIdRef.current = isRecordChat ? id : null;
    setSelectedChannelId(id);
  }, []);

  const loadData = useCallback(async () => {
    try {
      // Only public/private channels, so DMs and record chats can't use up the page.
      const [chRes, dmRes] = await Promise.all([
        appApi.channels.list({ limit: 100, types: ['public', 'private'] }),
        appApi.chatDm.list(),
      ]);
      // Match platform: DMs and record chats have their own lists. The server
      // already filters by type; this also covers an older API.
      const chs = ((chRes.data || []) as any[]).filter(
        (c: any) => c.type !== 'dm' && c.type !== 'entity',
      ) as Channel[];
      const dmList = (dmRes.data || []) as DmChannel[];
      networkLoadedRef.current = true;
      setChannels(chs);
      setDms(dmList);
      void cache.setChannels(chs);
      // Auto-select the first channel if none is selected; drop a selection that is gone.
      setSelectedChannelId((prev) => nextSelection(prev, chs, dmList, openRecordChatIdRef.current));
    } catch (err) {
      // Keep any cached / previously-loaded list instead of clearing to [].
      console.error('Failed to load data:', err);
    }
  }, [cache]);

  // Also reloads when the tabs regain focus: leaving or deleting a channel from
  // its info screen only publishes to that channel's room, not to this list.
  useFocusEffect(
    useCallback(() => {
      void loadData();
      refreshRecordChats('all', true);
    }, [loadData, refreshRecordChats]),
  );

  useChatUserEvents((event) => {
    void loadData();
    const kind = recordRefreshFor(event, {
      recordChatIds: recordChatIdsRef.current,
      channelIds: new Set([...channels.map((ch) => ch.id), ...dms.map((dm) => dm.id)]),
    });
    if (kind !== 'none') refreshRecordChats(kind);
  });

  const [collapsedRecordGroups, setCollapsedRecordGroups] = useState<Record<string, boolean>>({});
  const recordGroups = useMemo(
    () =>
      buildRecordGroups(recordChats.summary, recordChats.rows, {
        isCollapsed: (type) => collapsedRecordGroups[type] ?? false,
      }),
    [recordChats.summary, recordChats.rows, collapsedRecordGroups],
  );

  const filteredChannels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return channels;
    return channels.filter((ch) => (ch.name || '').toLowerCase().includes(query));
  }, [channels, search]);

  const filteredDms = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return dms;
    return dms.filter((d) => (d.name || '').toLowerCase().includes(query));
  }, [dms, search]);

  const sortedDms = useMemo(() => {
    return [...filteredDms].sort((a, b) => {
      const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bTime - aTime;
    });
  }, [filteredDms]);

  return (
    <View style={styles.container}>
      {/* Sidebar */}
      <View style={styles.sidebar}>
        {/* Sidebar Header */}
        <View style={styles.sidebarHeader}>
          <Text style={styles.sidebarTitle}>WeldChat</Text>
          <View style={styles.sidebarHeaderActions}>
            <TouchableOpacity
              onPress={() => router.push('/settings' as any)}
              hitSlop={8}
            >
              {user?.imageUrl ? (
                <ExpoImage source={{ uri: user.imageUrl }} style={styles.profileAvatar} />
              ) : (
                <View style={[styles.profileAvatar, styles.profileAvatarFallback]}>
                  <Text style={styles.profileAvatarText}>
                    {(user?.firstName ?? '?')[0].toUpperCase()}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {/* Search */}
        <View style={styles.searchContainer}>
          <Search size={16} color={colors.muted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search"
            placeholderTextColor={colors.muted}
            value={search}
            onChangeText={setSearch}
          />
        </View>

        <ScrollView style={styles.sidebarScroll} showsVerticalScrollIndicator={false}>
          {/* Channels Section */}
          <TouchableOpacity
            style={styles.sectionHeader}
            onPress={() => setChannelsCollapsed(!channelsCollapsed)}
          >
            {channelsCollapsed ? (
              <ChevronRight size={12} color={colors.muted} />
            ) : (
              <ChevronDown size={12} color={colors.muted} />
            )}
            <Text style={styles.sectionTitle}>CHANNELS</Text>
            <TouchableOpacity
              style={styles.addBtn}
              onPress={() => router.push('/new-channel' as any)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Plus size={16} color={colors.muted} />
            </TouchableOpacity>
          </TouchableOpacity>

          {!channelsCollapsed &&
            filteredChannels.map((ch) => {
              const isActive = selectedChannelId === ch.id;
              return (
                <Pressable
                  key={ch.id}
                  style={[styles.sidebarItem, isActive && styles.sidebarItemActive]}
                  onPress={() => selectConversation(ch.id)}
                >
                  {ch.type === 'private' ? (
                    <Lock size={16} color={colors.muted} style={styles.itemIcon} />
                  ) : (
                    <Hash size={16} color={colors.muted} style={styles.itemIcon} />
                  )}
                  <Text
                    style={[
                      styles.itemName,
                      (ch.unreadCount ?? 0) > 0 && styles.itemNameUnread,
                      isActive && styles.itemNameActive,
                    ]}
                    numberOfLines={1}
                  >
                    {ch.name}
                  </Text>
                  {(ch.unreadCount ?? 0) > 0 && (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{ch.unreadCount}</Text>
                    </View>
                  )}
                </Pressable>
              );
            })}

          {/* Record chats: one group per type the user follows, top 5, quiet ones left out. */}
          {recordGroups.map((group) => (
            <View key={group.type}>
              <View style={styles.sectionDivider} />
              <TouchableOpacity
                style={styles.sectionHeader}
                onPress={() => setCollapsedRecordGroups((prev) => ({ ...prev, [group.type]: !group.collapsed }))}
              >
                {group.collapsed ? (
                  <ChevronRight size={12} color={colors.muted} />
                ) : (
                  <ChevronDown size={12} color={colors.muted} />
                )}
                <Text style={styles.sectionTitle}>{recordGroupLabel(t, group.type).toUpperCase()}</Text>
                {group.mentions > 0 && (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{group.mentions}</Text>
                  </View>
                )}
              </TouchableOpacity>
              {group.rows.map((chat) => {
                const isActive = selectedChannelId === chat.id;
                const RecordIcon = recordChatIcon(chat.entityType) ?? Hash;
                const unread = isUnreadRecordChat(chat) || hasUnreadMentions(chat);
                return (
                  <Pressable
                    key={chat.id}
                    style={[styles.sidebarItem, isActive && styles.sidebarItemActive]}
                    onPress={() => selectConversation(chat.id, true)}
                  >
                    <RecordIcon size={16} color={colors.muted} style={styles.itemIcon} />
                    <Text
                      style={[styles.itemName, unread && styles.itemNameUnread, isActive && styles.itemNameActive]}
                      numberOfLines={1}
                    >
                      {recordChatName(chat)}
                    </Text>
                    {(chat.unreadMentionCount ?? 0) > 0 && (
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>{chat.unreadMentionCount}</Text>
                      </View>
                    )}
                  </Pressable>
                );
              })}
              {group.showAll && (
                <Pressable
                  style={styles.sidebarItem}
                  onPress={() => router.push(`/records?type=${group.type}` as any)}
                  accessibilityRole="link"
                >
                  <MoreHorizontal size={16} color={colors.muted} style={styles.itemIcon} />
                  <Text style={styles.itemName} numberOfLines={1}>
                    {format(t.recordChats.showAll, { count: group.followed })}
                  </Text>
                </Pressable>
              )}
            </View>
          ))}

          {/* DMs Section */}
          <View style={styles.sectionDivider} />
          <TouchableOpacity
            style={styles.sectionHeader}
            onPress={() => setDmsCollapsed(!dmsCollapsed)}
          >
            {dmsCollapsed ? (
              <ChevronRight size={12} color={colors.muted} />
            ) : (
              <ChevronDown size={12} color={colors.muted} />
            )}
            <Text style={styles.sectionTitle}>DIRECT MESSAGES</Text>
            <TouchableOpacity
              style={styles.addBtn}
              onPress={() => router.push('/new-dm' as any)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <PenSquare size={14} color={colors.muted} />
            </TouchableOpacity>
          </TouchableOpacity>

          {!dmsCollapsed &&
            sortedDms.map((dm) => {
              const isActive = selectedChannelId === dm.id;
              const hasUnread = (dm.unreadCount ?? 0) > 0;
              return (
                <Pressable
                  key={dm.id}
                  style={[styles.sidebarItem, isActive && styles.sidebarItemActive]}
                  onPress={() => selectConversation(dm.id)}
                >
                  <View style={styles.dmAvatar}>
                    {dm.picture ? (
                      <Image source={{ uri: dm.picture }} style={styles.dmAvatarImage} />
                    ) : (
                      <Text style={styles.dmAvatarText}>
                        {(dm.name || '?')[0].toUpperCase()}
                      </Text>
                    )}
                  </View>
                  <View style={styles.dmInfo}>
                    <Text
                      style={[
                        styles.itemName,
                        hasUnread && styles.itemNameUnread,
                        isActive && styles.itemNameActive,
                      ]}
                      numberOfLines={1}
                    >
                      {dm.name || 'Direct Message'}
                    </Text>
                    {dm.lastMessage && (
                      <Text style={styles.dmLastMessage} numberOfLines={1}>
                        {dm.lastMessage}
                      </Text>
                    )}
                  </View>
                  {hasUnread && (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{dm.unreadCount}</Text>
                    </View>
                  )}
                </Pressable>
              );
            })}

          <View style={{ height: 20 }} />
        </ScrollView>
      </View>

      {/* Main Content */}
      <View style={styles.mainContent}>
        {selectedChannelId ? (
          <ChannelView
            key={selectedChannelId}
            channelId={selectedChannelId}
            hideBackButton
          />
        ) : (
          <View style={styles.emptyMain}>
            <Text style={styles.emptyMainTitle}>Select a conversation</Text>
            <Text style={styles.emptyMainText}>
              Choose a channel or DM from the sidebar to start chatting
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeColors, topInset: number, _bottomInset: number) =>
  StyleSheet.create({
    container: {
      flex: 1,
      flexDirection: 'row',
      backgroundColor: c.background,
    },
    // Sidebar
    sidebar: {
      width: SIDEBAR_WIDTH,
      backgroundColor: c.cardBackground,
      borderRightWidth: 1,
      borderRightColor: c.secondary,
    },
    sidebarHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: topInset + 12,
      paddingHorizontal: 16,
      paddingBottom: 12,
    },
    sidebarTitle: {
      fontSize: 20,
      fontWeight: '700',
      color: c.text,
    },
    sidebarHeaderActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    profileAvatar: { width: 28, height: 28, borderRadius: 8 },
    profileAvatarFallback: {
      backgroundColor: BRAND,
      justifyContent: 'center',
      alignItems: 'center',
    },
    profileAvatarText: { fontSize: 12, fontWeight: '700', color: '#fff' },
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: 12,
      marginBottom: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      backgroundColor: c.secondary,
      borderRadius: 8,
      gap: 8,
    },
    searchInput: {
      flex: 1,
      fontSize: 14,
      color: c.text,
      padding: 0,
    },
    sidebarScroll: { flex: 1, paddingHorizontal: 8 },
    // Section headers
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      paddingLeft: 6,
      paddingRight: 4,
    },
    sectionTitle: {
      fontSize: 11,
      fontWeight: '700',
      color: c.muted,
      letterSpacing: 0.5,
      flex: 1,
      marginLeft: 8,
    },
    sectionDivider: {
      height: 1,
      backgroundColor: c.secondary,
      marginHorizontal: 4,
      marginVertical: 8,
    },
    addBtn: { padding: 4 },
    // Sidebar items
    sidebarItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 7,
      paddingHorizontal: 8,
      borderRadius: 6,
      marginVertical: 1,
    },
    sidebarItemActive: {
      backgroundColor: c.secondary,
    },
    itemIcon: { marginRight: 8 },
    itemName: {
      flex: 1,
      fontSize: 14,
      color: c.muted,
    },
    itemNameUnread: {
      color: c.text,
      fontWeight: '600',
    },
    itemNameActive: {
      color: c.text,
    },
    // DM-specific
    dmAvatar: {
      width: 28,
      height: 28,
      borderRadius: 10,
      backgroundColor: BRAND,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 8,
    },
    dmAvatarImage: { width: 28, height: 28, borderRadius: 10 },
    dmAvatarText: { fontSize: 12, fontWeight: '700', color: '#fff' },
    dmInfo: { flex: 1 },
    dmLastMessage: {
      fontSize: 12,
      color: c.muted,
      marginTop: 1,
    },
    // Badge
    badge: {
      backgroundColor: c.destructive,
      borderRadius: 8,
      minWidth: 18,
      height: 18,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 5,
    },
    badgeText: { color: c.primaryForeground, fontSize: 11, fontWeight: '700' },
    // Main content area
    mainContent: {
      flex: 1,
      backgroundColor: c.background,
    },
    emptyMain: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
    },
    emptyMainTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: c.text,
      marginBottom: 8,
    },
    emptyMainText: {
      fontSize: 14,
      color: c.muted,
      textAlign: 'center',
      maxWidth: 300,
    },
  });
