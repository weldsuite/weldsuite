import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TouchableHighlight, RefreshControl, Image, ScrollView, Platform } from 'react-native';
import { Plus, Archive, Trash2, BellOff, Bell, Pin, PinOff } from 'lucide-react-native';
import Svg, { Defs, Pattern, Path, Rect } from 'react-native-svg';
import { FlatList, Swipeable } from 'react-native-gesture-handler';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUser } from '@clerk/expo';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';
import appApi from '@/services/app-api';
import { useChatUserEvents } from '@/hooks/useChatUserEvents';
import { SearchField } from '@/components/chat/SearchField';
import { Spinner } from '@/components/ui/Spinner';

interface DmMember {
  userId: string;
  name?: string | null;
  email?: string | null;
  picture?: string | null;
}

interface DmChannel {
  id: string;
  name: string;
  picture?: string | null;
  type: string;
  isGroup?: boolean;
  otherMembers?: DmMember[];
  isMuted?: boolean;
  isPinned?: boolean;
  hasUnread?: boolean;
  unreadCount?: number;
  lastMessagePreview?: string | null;
  lastMessageAt?: string;
}

/**
 * Map a raw app-api `/chat-dm` row into the shape this screen renders.
 * Mirrors the platform sidebar derivation (use-weldchat-sidebar-items.tsx):
 * display name + avatar come from `otherMembers`, unread from
 * lastMessageAt vs the current user's lastReadAt, pin from metadata.pinnedBy.
 */
function mapDm(dm: any, currentUserId: string | undefined): DmChannel {
  const otherMembers: DmMember[] = (dm.otherMembers ?? []).filter((m: any) => m?.userId);
  const isGroup = otherMembers.length > 1;
  const first = otherMembers[0];
  const displayName = isGroup
    ? otherMembers.map((m) => m.name || m.email || 'Unknown').join(', ') || dm.name || 'Group'
    : first?.name || first?.email || dm.name || 'Direct Message';
  const hasUnread =
    !!dm.lastMessageAt && (!dm.lastReadAt || new Date(dm.lastMessageAt) > new Date(dm.lastReadAt));
  const pinnedBy: string[] = Array.isArray(dm.metadata?.pinnedBy) ? dm.metadata.pinnedBy : [];
  return {
    id: dm.id,
    type: dm.type,
    name: displayName,
    isGroup,
    otherMembers,
    picture: isGroup ? null : first?.picture ?? null,
    isMuted: !!dm.isMuted,
    isPinned: currentUserId ? pinnedBy.includes(currentUserId) : false,
    hasUnread,
    unreadCount: dm.unreadMentionCount || 0,
    lastMessagePreview: dm.lastMessagePreview ?? null,
    lastMessageAt: dm.lastMessageAt ?? undefined,
  };
}

function formatMessageTime(dateStr?: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfDate = new Date(date);
  startOfDate.setHours(0, 0, 0, 0);

  const dayDiff = Math.round((startOfToday.getTime() - startOfDate.getTime()) / 86400000);

  if (dayDiff <= 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff < 7) return date.toLocaleDateString([], { weekday: 'long' });
  return date.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export default function DmsTab() {
  const [dms, setDms] = useState<DmChannel[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread' | 'favourites' | 'muted'>('all');
  const swipeableRefs = useRef<Map<string, any>>(new Map());
  const router = useRouter();
  const { user } = useUser();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.top), [colors, insets.top]);

  const loadDms = useCallback(async () => {
    try {
      const res = await appApi.chatDm.list();
      setDms((res.data || []).map((dm: any) => mapDm(dm, user?.id)));
    } catch (err) {
      console.error('Failed to load DMs:', err);
    }
  }, [user?.id]);

  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    await loadDms();
    setRefreshing(false);
  }, [loadDms, refreshing]);

  // iOS: trigger a refresh when the list is over-scrolled past the top (we use
  // our own shadcn spinner there instead of the native RefreshControl, so there
  // is exactly one spinner). Android keeps the native RefreshControl.
  const onScrollEndDrag = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      if (Platform.OS !== 'ios') return;
      if (e.nativeEvent.contentOffset.y <= -85) onRefresh();
    },
    [onRefresh],
  );

  useFocusEffect(useCallback(() => {
    loadDms();
  }, [loadDms]));

  useChatUserEvents(loadDms);

  const sortedDms = useMemo(() => {
    // Text search lives on the dedicated /search page now; this list only
    // applies the All/Unread/Favourites/Muted chip filter + pin-then-recency sort.
    let filtered = dms;
    if (filter === 'unread') {
      filtered = filtered.filter((d) => !!d.hasUnread);
    } else if (filter === 'favourites') {
      filtered = filtered.filter((d) => !!d.isPinned);
    } else if (filter === 'muted') {
      filtered = filtered.filter((d) => !!d.isMuted);
    }
    return [...filtered].sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bTime - aTime;
    });
  }, [dms, filter]);

  const handleMute = useCallback(async (item: DmChannel) => {
    const newMuted = !item.isMuted;
    setDms((prev) => prev.map((d) => d.id === item.id ? { ...d, isMuted: newMuted } : d));
    swipeableRefs.current.get(item.id)?.close();
    try {
      await appApi.channels.updateMembership(item.id, { isMuted: newMuted });
    } catch {
      setDms((prev) => prev.map((d) => d.id === item.id ? { ...d, isMuted: item.isMuted } : d));
    }
  }, []);

  const handlePin = useCallback(async (item: DmChannel) => {
    const newPinned = !item.isPinned;
    setDms((prev) => prev.map((d) => d.id === item.id ? { ...d, isPinned: newPinned } : d));
    swipeableRefs.current.get(item.id)?.close();
    try {
      await appApi.chatDm.pin(item.id, { isPinned: newPinned });
    } catch {
      setDms((prev) => prev.map((d) => d.id === item.id ? { ...d, isPinned: item.isPinned } : d));
    }
  }, []);

  const handleArchive = useCallback(async (item: DmChannel) => {
    setDms((prev) => prev.filter((d) => d.id !== item.id));
    try {
      await appApi.chatDm.archive(item.id);
    } catch {
      loadDms();
    }
  }, [loadDms]);

  const handleDelete = useCallback(async (item: DmChannel) => {
    setDms((prev) => prev.filter((d) => d.id !== item.id));
    try {
      await appApi.chatDm.delete(item.id);
    } catch {
      loadDms();
    }
  }, [loadDms]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.headerTitleWrap} pointerEvents="none">
          <Text style={styles.headerTitle}>Chats</Text>
        </View>

        <View style={styles.headerRightGroup}>
          <TouchableOpacity
            style={styles.headerSquareBtn}
            activeOpacity={0.7}
            onPress={() => router.push('/new-dm')}
          >
            <Plus size={20} color={colors.textPrimary} />
          </TouchableOpacity>
        </View>
        {scrolled && <View style={styles.headerDivider} pointerEvents="none" />}
      </View>

      <FlatList
        data={sortedDms}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        onScroll={(e) => {
          const y = e.nativeEvent.contentOffset.y;
          setScrolled((prev) => {
            if (prev && y <= 0) return false;
            if (!prev && y > 4) return true;
            return prev;
          });
        }}
        scrollEventThrottle={16}
        onScrollEndDrag={onScrollEndDrag}
        ListHeaderComponent={
          <View>
            {Platform.OS === 'ios' && refreshing && (
              <View style={styles.refreshSpinnerRow}>
                <Spinner size={22} color={colors.textSecondary} />
              </View>
            )}
            <SearchField
              placeholder="Search"
              onPress={() => router.push('/search' as any)}
              style={styles.searchContainer}
            />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filterRow}
              keyboardShouldPersistTaps="handled"
            >
              {([
                { key: 'all', label: 'All' },
                { key: 'unread', label: 'Unread' },
                { key: 'favourites', label: 'Favourites' },
                { key: 'muted', label: 'Muted' },
              ] as const).map((chip) => {
                const active = filter === chip.key;
                return (
                  <TouchableOpacity
                    key={chip.key}
                    style={[styles.filterChip, active && styles.filterChipActive]}
                    activeOpacity={0.7}
                    onPress={() => setFilter(chip.key)}
                  >
                    <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                      {chip.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        }
        refreshControl={
          // Android only — iOS uses overscroll + the shadcn spinner above.
          Platform.OS === 'android' ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.textMuted}
              colors={[colors.textMuted]}
            />
          ) : undefined
        }
        contentContainerStyle={dms.length === 0 ? styles.emptyContainer : styles.list}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        renderItem={({ item }) => {
          const hasUnread = !!item.hasUnread;
          const timeStr = formatMessageTime(item.lastMessageAt);

          const renderRightActions = () => (
            <View style={styles.swipeRightContainer}>
              <TouchableOpacity
                style={[styles.swipeAction, styles.swipeArchive]}
                onPress={() => handleArchive(item)}
              >
                <Archive size={20} color="#fff" />
                <Text style={styles.swipeActionText}>Archive</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.swipeAction, styles.swipeDelete]}
                onPress={() => handleDelete(item)}
              >
                <Trash2 size={20} color="#fff" />
                <Text style={styles.swipeActionText}>Delete</Text>
              </TouchableOpacity>
            </View>
          );

          const renderLeftActions = () => (
            <View style={styles.swipeLeftContainer}>
              <TouchableOpacity
                style={[styles.swipeAction, styles.swipeMute]}
                onPress={() => handleMute(item)}
              >
                {item.isMuted
                  ? <Bell size={20} color="#fff" />
                  : <BellOff size={20} color="#fff" />
                }
                <Text style={styles.swipeActionText}>{item.isMuted ? 'Unmute' : 'Mute'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.swipeAction, styles.swipePin]}
                onPress={() => handlePin(item)}
              >
                {item.isPinned
                  ? <PinOff size={20} color="#fff" />
                  : <Pin size={20} color="#fff" />
                }
                <Text style={styles.swipeActionText}>{item.isPinned ? 'Unpin' : 'Pin'}</Text>
              </TouchableOpacity>
            </View>
          );

          return (
            <Swipeable
              ref={(ref) => {
                if (ref) swipeableRefs.current.set(item.id, ref);
                else swipeableRefs.current.delete(item.id);
              }}
              renderRightActions={renderRightActions}
              renderLeftActions={renderLeftActions}
              overshootRight={false}
              overshootLeft={false}
              friction={1.5}
              leftThreshold={30}
              rightThreshold={30}
            >
              <TouchableHighlight
                style={[styles.dmItem, hasUnread && styles.dmItemUnread]}
                underlayColor={colors.bgTertiary}
                onPress={() => router.push(`/dm/${item.id}` as any)}
              >
                <View style={styles.dmItemInner}>
                  <View style={styles.avatarOuter}>
                    {item.isGroup ? (
                      <View style={styles.groupAvatarWrap}>
                        {(item.otherMembers ?? []).slice(0, 2).map((m, i) => (
                          <View
                            key={m.userId || i}
                            style={[styles.groupAvatar, i === 0 ? styles.groupAvatarA : styles.groupAvatarB]}
                          >
                            {m.picture ? (
                              <Image source={{ uri: m.picture }} style={styles.groupAvatarImage} />
                            ) : (
                              <Text style={styles.groupAvatarText}>
                                {(m.name || m.email || '?')[0].toUpperCase()}
                              </Text>
                            )}
                          </View>
                        ))}
                      </View>
                    ) : (
                      <View style={styles.avatar}>
                        {item.picture ? (
                          <Image source={{ uri: item.picture }} style={styles.avatarImage} />
                        ) : (
                          <Text style={styles.avatarText}>
                            {(item.name || '?')[0].toUpperCase()}
                          </Text>
                        )}
                      </View>
                    )}
                    {item.isPinned && (
                      <View style={styles.pinBadge}>
                        <Pin size={8} color="#fff" />
                      </View>
                    )}
                  </View>
                  <View style={styles.dmInfo}>
                    <View style={styles.dmTopRow}>
                      <Text style={styles.dmName} numberOfLines={1}>
                        {item.name || 'Direct Message'}
                      </Text>
                      {timeStr !== '' && (
                        <Text style={[styles.dmTime, hasUnread && styles.dmTimeUnread]}>
                          {timeStr}
                        </Text>
                      )}
                    </View>
                    <View style={styles.dmBottomRow}>
                      <Text
                        style={[styles.dmLastMessage, hasUnread && styles.dmLastMessageUnread]}
                        numberOfLines={2}
                      >
                        {item.lastMessagePreview || 'No messages yet'}
                      </Text>
                      {item.isMuted && <BellOff size={12} color={colors.textMuted} style={styles.mutedIcon} />}
                      {hasUnread && (item.unreadCount ?? 0) > 0 && (
                        <View style={styles.unreadBadge}>
                          <Text style={styles.unreadBadgeText}>{item.unreadCount}</Text>
                        </View>
                      )}
                    </View>
                  </View>
                </View>
              </TouchableHighlight>
            </Swipeable>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <View style={styles.illustrationContainer}>
              <Svg width={240} height={170} style={StyleSheet.absoluteFill}>
                <Defs>
                  <Pattern id="grid" width={28} height={28} patternUnits="userSpaceOnUse">
                    <Path
                      d="M 28 0 L 0 0 0 28"
                      fill="none"
                      stroke={colors.bgTertiary}
                      strokeWidth={0.5}
                      strokeDasharray="3 3"
                    />
                  </Pattern>
                </Defs>
                <Rect width="100%" height="100%" fill="url(#grid)" />
              </Svg>
              <Svg width={120} height={120} viewBox="0 0 120 120" fill="none">
                <Path
                  d="M20 32a10 10 0 0 1 10-10h60a10 10 0 0 1 10 10v40a10 10 0 0 1-10 10H52l-16 14V82H30a10 10 0 0 1-10-10V32z"
                  fill={colors.bgSecondary}
                  stroke={colors.bgTertiary}
                  strokeWidth={1}
                />
                <Rect x="38" y="46" width="44" height="4" rx="2" fill={colors.bgTertiary} />
                <Rect x="38" y="56" width="30" height="4" rx="2" fill={colors.bgTertiary} />
                <Rect x="38" y="66" width="36" height="4" rx="2" fill={colors.bgTertiary} />
              </Svg>
            </View>
            <Text style={styles.emptyTitle}>No messages yet</Text>
            <Text style={styles.emptyText}>Start a conversation with someone</Text>
          </View>
        }
      />
    </View>
  );
}

const makeStyles = (c: ColorScheme, topInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bgPrimary },
    // iOS shadcn refresh spinner row — sits above the search while refreshing.
    refreshSpinnerRow: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 12,
      paddingBottom: 6,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      paddingTop: topInset + 6,
      paddingHorizontal: 16,
      paddingBottom: 8,
      backgroundColor: c.bgPrimary,
    },
    headerDivider: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.border,
    },
    headerSquareBtn: {
      width: 40,
      height: 40,
      borderRadius: 13,
      backgroundColor: c.bgPrimary,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      justifyContent: 'center',
      alignItems: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.04,
      shadowRadius: 2,
      elevation: 1,
    },
    headerTitleWrap: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: topInset + 6,
      height: 40,
      justifyContent: 'center',
      alignItems: 'center',
    },
    headerTitle: { fontSize: 19, fontWeight: '700', color: c.textPrimary },
    headerRightGroup: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    // Only outer spacing — the pill look lives in <SearchField>.
    searchContainer: {
      marginHorizontal: 16,
      marginTop: 8,
      marginBottom: 8,
    },
    filterRow: {
      paddingHorizontal: 16,
      paddingBottom: 20,
      gap: 8,
    },
    filterChip: {
      paddingHorizontal: 14,
      height: 32,
      borderRadius: 10,
      backgroundColor: c.bgPrimary,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      justifyContent: 'center',
      alignItems: 'center',
    },
    filterChipActive: {
      backgroundColor: c.textPrimary,
      borderColor: c.textPrimary,
    },
    filterChipText: {
      fontSize: 14,
      fontWeight: '500',
      color: c.textPrimary,
    },
    filterChipTextActive: {
      color: '#fff',
      fontWeight: '600',
    },
    list: { paddingBottom: 32 },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.border,
    },
    dmItem: { backgroundColor: c.bgPrimary },
    dmItemUnread: { backgroundColor: c.bgTertiary },
    dmItemInner: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingVertical: 12,
      paddingHorizontal: 16,
      gap: 12,
    },
    avatarOuter: { width: 36, height: 36 },
    avatar: {
      width: 36,
      height: 36,
      borderRadius: 13,
      backgroundColor: c.brand,
      justifyContent: 'center',
      alignItems: 'center',
    },
    avatarText: { fontSize: 15, fontWeight: '600', color: '#fff' },
    avatarImage: { width: 36, height: 36, borderRadius: 13 },
    // Group DM: two overlapping mini avatars (mirrors the platform's stacked icon).
    groupAvatarWrap: { width: 36, height: 36, position: 'relative' },
    groupAvatar: {
      position: 'absolute',
      width: 26,
      height: 26,
      borderRadius: 10,
      backgroundColor: c.brand,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 2,
      borderColor: c.bgPrimary,
      overflow: 'hidden',
    },
    groupAvatarA: { top: 0, left: 0, zIndex: 2 },
    groupAvatarB: { bottom: 0, right: 0 },
    groupAvatarImage: { width: 22, height: 22, borderRadius: 8 },
    groupAvatarText: { fontSize: 11, fontWeight: '600', color: '#fff' },
    pinBadge: {
      position: 'absolute',
      bottom: -2,
      right: -2,
      width: 14,
      height: 14,
      borderRadius: 7,
      backgroundColor: c.warning,
      justifyContent: 'center',
      alignItems: 'center',
    },
    dmInfo: { flex: 1, gap: 2, marginTop: -1 },
    dmTopRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    dmName: {
      flex: 1,
      fontSize: 16,
      color: c.textPrimary,
      fontWeight: '600',
      lineHeight: 21,
    },
    dmTime: { fontSize: 14, color: '#858585' },
    dmTimeUnread: { color: c.brand, fontWeight: '600' },
    dmBottomRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    dmLastMessage: {
      flex: 1,
      fontSize: 15,
      // Darker gray than textSecondary, theme-safe (dark in light mode, light in
      // dark mode) via primary text at reduced opacity.
      color: c.textPrimary,
      opacity: 0.6,
      fontWeight: '400',
      lineHeight: 19,
      minHeight: 38,
    },
    dmLastMessageUnread: { color: c.textPrimary, opacity: 1, fontWeight: '500' },
    mutedIcon: { opacity: 0.7 },
    unreadBadge: {
      minWidth: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: c.brand,
      paddingHorizontal: 7,
      justifyContent: 'center',
      alignItems: 'center',
    },
    unreadBadgeText: {
      fontSize: 12,
      color: '#fff',
      fontWeight: '700',
    },
    emptyContainer: { flex: 1 },
    empty: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
      gap: 12,
    },
    illustrationContainer: {
      width: 240,
      height: 170,
      marginBottom: 12,
      justifyContent: 'center',
      alignItems: 'center',
    },
    swipeRightContainer: { flexDirection: 'row' },
    swipeLeftContainer: { flexDirection: 'row' },
    swipeAction: { width: 72, justifyContent: 'center', alignItems: 'center' },
    swipeActionText: { fontSize: 11, fontWeight: '600', color: '#fff', marginTop: 4 },
    swipeArchive: { backgroundColor: c.brand },
    swipeDelete: { backgroundColor: c.danger },
    swipeMute: { backgroundColor: c.textMuted },
    swipePin: { backgroundColor: c.warning },
    emptyTitle: { fontSize: 16, fontWeight: '600', color: c.textPrimary },
    emptyText: { fontSize: 14, color: c.textMuted, textAlign: 'center', maxWidth: 280, lineHeight: 20 },
  });
