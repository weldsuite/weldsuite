import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TouchableHighlight, RefreshControl, Image, ScrollView, Platform } from 'react-native';
import { Archive, Trash2, BellOff, Bell, Pin, PinOff, SquarePen, Users } from 'lucide-react-native';
import Svg, { Defs, Pattern, Path, Rect } from 'react-native-svg';
import { FlatList } from 'react-native-gesture-handler';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUser } from '@clerk/expo';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { BRAND } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';

import type { ThemeColors } from '@/lib/theme-colors';

import { appApi } from '@/services/app-api';
import { useChatUserEvents } from '@/hooks/useChatUserEvents';
import { useChatCache } from '@/hooks/useChatCache';
import { formatMessageTime, mapDm, type DmChannel } from '@/lib/chat/dm';
import { SearchField } from '@/components/chat/SearchField';
import { Spinner } from '@/components/ui/Spinner';
import { ComposeMenu } from '@/components/home/ComposeMenu';
import { ConversationMenu, dmMenuTarget, type ConversationPatch } from '@/components/home/ConversationMenu';
import { floatingTabBarBottomInset } from '@/components/floating-tab-bar';

/** Space between the compose button and the top of the tab bar's slot. */
const COMPOSE_BUTTON_GAP = 6;

function withoutArchived({ archived: _archived, ...rest }: ConversationPatch): Partial<DmChannel> {
  return rest;
}

function DmListSeparator() {
  const { colors } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />;
}

export default function DmsTab() {
  const { t } = useI18n();
  const [dms, setDms] = useState<DmChannel[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread' | 'favourites' | 'muted'>('all');
  const swipeableRefs = useRef<Map<string, SwipeableMethods>>(new Map());
  const [composeOpen, setComposeOpen] = useState(false);
  const router = useRouter();
  const { user } = useUser();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.top), [colors, insets.top]);
  const cache = useChatCache();
  // Set when a network fetch lands so a late cache read can't overwrite it.
  const networkLoadedRef = useRef(false);

  // Cache-first paint so Chats isn't blank while the network round-trip runs.
  // Cached rows are already mapped (display name / unread / pin) from the last
  // successful fetch, so they can be shown as-is.
  useEffect(() => {
    let cancelled = false;
    networkLoadedRef.current = false;
    void (async () => {
      const cached = await cache.getDms();
      if (cancelled || networkLoadedRef.current) return;
      setDms((cached as DmChannel[] | null) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [cache]);

  const loadDms = useCallback(async () => {
    try {
      const res = await appApi.chatDm.list();
      const next = (res.data || []).map((dm: any) => mapDm(dm, user?.id));
      networkLoadedRef.current = true;
      setDms(next);
      void cache.setDms(next);
    } catch (err) {
      // Keep any cached / previously-loaded list instead of clearing to [].
      console.error('Failed to load DMs:', err);
    }
  }, [user?.id, cache]);

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
      if (e.nativeEvent.contentOffset.y <= -85) void onRefresh();
    },
    [onRefresh],
  );

  useFocusEffect(useCallback(() => {
    void loadDms();
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

  // A change made from a row's long-press menu, shown right away.
  const patchDm = useCallback((id: string, patch: ConversationPatch) => {
    if (patch.archived === false) {
      void loadDms();
      return;
    }
    setDms((prev) =>
      patch.archived
        ? prev.filter((d) => d.id !== id)
        : prev.map((d) => (d.id === id ? { ...d, ...withoutArchived(patch) } : d)),
    );
  }, [loadDms]);

  // A screen opened from the compose card waits for its Modal to be gone: on
  // iOS a modal pushed while a <Modal> is up is dismissed together with it.
  const pendingHrefRef = useRef<string | null>(null);
  const goFromCompose = (href: string) => {
    pendingHrefRef.current = href;
    setComposeOpen(false);
  };
  const flushPendingHref = useCallback(() => {
    const href = pendingHrefRef.current;
    pendingHrefRef.current = null;
    if (href) router.push(href as any);
  }, [router]);

  const handleArchive = useCallback(async (item: DmChannel) => {
    setDms((prev) => prev.filter((d) => d.id !== item.id));
    try {
      await appApi.chatDm.archive(item.id);
    } catch {
      void loadDms();
    }
  }, [loadDms]);

  const handleDelete = useCallback(async (item: DmChannel) => {
    setDms((prev) => prev.filter((d) => d.id !== item.id));
    try {
      await appApi.chatDm.delete(item.id);
    } catch {
      void loadDms();
    }
  }, [loadDms]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.headerTitleWrap} pointerEvents="none">
          <Text style={styles.headerTitle}>{t.tabs.directMessages}</Text>
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
                <Spinner size={22} color={colors.mutedForeground} />
              </View>
            )}
            <SearchField
              placeholder={t.common.search}
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
                { key: 'all', label: t.dms.filterAll },
                { key: 'unread', label: t.dms.filterUnread },
                { key: 'favourites', label: t.dms.filterFavourites },
                { key: 'muted', label: t.dms.filterMuted },
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
              tintColor={colors.muted}
              colors={[colors.muted]}
            />
          ) : undefined
        }
        contentContainerStyle={dms.length === 0 ? styles.emptyContainer : styles.list}
        ItemSeparatorComponent={DmListSeparator}
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
                <Text style={styles.swipeActionText}>{t.dms.archive}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.swipeAction, styles.swipeDelete]}
                onPress={() => handleDelete(item)}
              >
                <Trash2 size={20} color="#fff" />
                <Text style={styles.swipeActionText}>{t.common.delete}</Text>
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
                <Text style={styles.swipeActionText}>{item.isMuted ? t.dms.unmute : t.dms.mute}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.swipeAction, styles.swipePin]}
                onPress={() => handlePin(item)}
              >
                {item.isPinned
                  ? <PinOff size={20} color="#fff" />
                  : <Pin size={20} color="#fff" />
                }
                <Text style={styles.swipeActionText}>{item.isPinned ? t.dms.unpin : t.dms.pin}</Text>
              </TouchableOpacity>
            </View>
          );

          return (
            <ReanimatedSwipeable
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
              <ConversationMenu conversation={dmMenuTarget(item)} onChange={patchDm}>
                <TouchableHighlight
                  style={[styles.dmItem, hasUnread && styles.dmItemUnread]}
                  underlayColor={colors.secondary}
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
                          {item.lastMessagePreview || t.dms.noMessagesPreview}
                        </Text>
                        {item.isMuted && <BellOff size={12} color={colors.muted} style={styles.mutedIcon} />}
                        {hasUnread && (item.unreadCount ?? 0) > 0 && (
                          <View style={styles.unreadBadge}>
                            <Text style={styles.unreadBadgeText}>{item.unreadCount}</Text>
                          </View>
                        )}
                      </View>
                    </View>
                  </View>
                </TouchableHighlight>
              </ConversationMenu>
            </ReanimatedSwipeable>
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
                      stroke={colors.secondary}
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
                  fill={colors.cardBackground}
                  stroke={colors.secondary}
                  strokeWidth={1}
                />
                <Rect x="38" y="46" width="44" height="4" rx="2" fill={colors.secondary} />
                <Rect x="38" y="56" width="30" height="4" rx="2" fill={colors.secondary} />
                <Rect x="38" y="66" width="36" height="4" rx="2" fill={colors.secondary} />
              </Svg>
            </View>
            <Text style={styles.emptyTitle}>{t.dms.emptyTitle}</Text>
            <Text style={styles.emptyText}>{t.dms.emptyHint}</Text>
          </View>
        }
      />

      {/* New: a conversation with one person, or a group. Same button as Home. */}
      <ComposeMenu
        open={composeOpen}
        onOpen={() => setComposeOpen(true)}
        bottom={floatingTabBarBottomInset(insets.bottom) + COMPOSE_BUTTON_GAP}
        buttonBottom={COMPOSE_BUTTON_GAP}
        buttonLabel={t.dms.newDm}
        items={[
          {
            key: 'group',
            icon: <Users size={20} color={colors.text} strokeWidth={1.9} />,
            title: t.dms.composeGroup,
            hint: t.dms.composeGroupHint,
            onPress: () => goFromCompose('/new-dm?group=1'),
          },
        ]}
        primary={{
          icon: <SquarePen size={20} color={colors.background} strokeWidth={2.1} />,
          label: t.home.composeMessage,
          onPress: () => goFromCompose('/new-message'),
        }}
        onRequestClose={() => setComposeOpen(false)}
        onClosed={flushPendingHref}
      />
    </View>
  );
}

const makeStyles = (c: ThemeColors, topInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
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
      // The height the old "+" button gave it, so the page doesn't shift up.
      minHeight: topInset + 6 + 40 + 8,
      paddingTop: topInset + 6,
      paddingHorizontal: 16,
      paddingBottom: 8,
      backgroundColor: c.background,
    },
    headerDivider: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.border,
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
    headerTitle: { fontSize: 19, fontWeight: '700', color: c.text },
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
      backgroundColor: c.background,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      justifyContent: 'center',
      alignItems: 'center',
    },
    filterChipActive: {
      backgroundColor: c.text,
      borderColor: c.text,
    },
    filterChipText: {
      fontSize: 14,
      fontWeight: '500',
      color: c.text,
    },
    filterChipTextActive: {
      color: '#fff',
      fontWeight: '600',
    },
    list: { paddingBottom: 32 },
    dmItem: { backgroundColor: c.background },
    dmItemUnread: { backgroundColor: c.secondary },
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
      backgroundColor: BRAND,
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
      backgroundColor: BRAND,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 2,
      borderColor: c.background,
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
      color: c.text,
      fontWeight: '600',
      lineHeight: 21,
    },
    dmTime: { fontSize: 14, color: '#858585' },
    dmTimeUnread: { color: BRAND, fontWeight: '600' },
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
      color: c.text,
      opacity: 0.6,
      fontWeight: '400',
      lineHeight: 19,
      minHeight: 38,
    },
    dmLastMessageUnread: { color: c.text, opacity: 1, fontWeight: '500' },
    mutedIcon: { opacity: 0.7 },
    unreadBadge: {
      minWidth: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: BRAND,
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
    swipeArchive: { backgroundColor: BRAND },
    swipeDelete: { backgroundColor: c.destructive },
    swipeMute: { backgroundColor: c.muted },
    swipePin: { backgroundColor: c.warning },
    emptyTitle: { fontSize: 16, fontWeight: '600', color: c.text },
    emptyText: { fontSize: 14, color: c.muted, textAlign: 'center', maxWidth: 280, lineHeight: 20 },
  });
