/**
 * Record chats: every chat on a company, person, task, project or domain the
 * user may read, not only the 5 per type Home shows. The title picks the
 * record type ("Record chats ⌄" / "Companies ⌄"); one chip row of filters
 * (Following, Unread, Mentions, All), search, infinite scroll. Swipe a row to
 * follow, unfollow or mute it; long-press for its menu.
 *
 * Opened from Home's "Show all (N)" rows (`/records?type=company`) and its
 * "Record chats" row. Same list endpoint as the web's /weldchat/records.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { FlatList } from 'react-native-gesture-handler';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@clerk/expo';
import { Bell, BellOff, ChevronDown, ChevronLeft, Hash, Plus, UserMinus } from 'lucide-react-native';
import { MenuView, type MenuAction } from '@expo/ui/community/menu';
import type { RecordChatListItem } from '@weldsuite/app-api-client/domains/chat-entity-channels';
import {
  RECORD_CHAT_FILTERS,
  type RecordChatFilter,
} from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { BRAND } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';
import type { ThemeColors } from '@/lib/theme-colors';
import { SearchField } from '@/components/chat/SearchField';
import { ConversationMenu, recordMenuTarget, type ConversationPatch } from '@/components/home/ConversationMenu';
import { useChatUserEvents } from '@/hooks/useChatUserEvents';
import { forgetMembership, updateMembership } from '@/lib/chat/conversation-menu';
import { formatMessageTime } from '@/lib/chat/dm';
import {
  RECORD_CHAT_TYPES,
  hasUnreadMentions,
  isRecordChatType,
  isUnreadRecordChat,
  recordChatName,
  uniqueRows,
  type RecordChatType,
} from '@/lib/record-chats/rules';
import { recordChatIcon, recordGroupLabel, recordTypeLabel } from '@/lib/record-chats/registry';
import { appApi } from '@/services/app-api';

const PAGE_SIZE = 25;
/** Typing pauses this long before the search runs. */
const SEARCH_DEBOUNCE_MS = 300;
/** Events in a burst wait this long, then reload once. */
const REFRESH_DEBOUNCE_MS = 400;

type Styles = ReturnType<typeof makeStyles>;

/** The title menu's "every type" action. */
const TYPE_ALL = 'all';
/** iOS menu icons per type (Android menus show none). */
const TYPE_SYMBOLS = {
  company: 'building.2',
  person: 'person',
  task: 'checkmark.square',
  project: 'briefcase',
  domain: 'globe',
  sheet: 'tablecells',
  doc: 'doc.text',
} as const satisfies Record<RecordChatType, string>;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export default function RecordsScreen() {
  const params = useLocalSearchParams<{ type?: string }>();
  const router = useRouter();
  const { userId } = useAuth();
  const { t, format } = useI18n();
  const toast = useToast();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.top, insets.bottom), [colors, insets.top, insets.bottom]);

  const [type, setType] = useState<RecordChatType | null>(isRecordChatType(params.type) ? params.type : null);
  // A link to this screen while it is open (`?type=task`) reuses it with new params.
  useEffect(() => {
    if (params.type !== undefined) setType(isRecordChatType(params.type) ? params.type : null);
  }, [params.type]);
  const [filter, setFilter] = useState<RecordChatFilter>('following');
  const [query, setQuery] = useState('');
  const search = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);

  const [rows, setRows] = useState<RecordChatListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  // Each first-page load gets a number; answers to an older one are dropped.
  const requestRef = useRef(0);
  const swipeableRefs = useRef<Map<string, SwipeableMethods>>(new Map());

  const listQuery = useMemo(
    () => ({ type: type ?? undefined, filter, search: search || undefined, limit: PAGE_SIZE }),
    [type, filter, search],
  );

  const loadFirst = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setFailed(false);
    try {
      const res = await appApi.chatEntityChannels.list(listQuery);
      if (request !== requestRef.current) return;
      setRows(res.data ?? []);
      setCursor(res.pagination?.cursor ?? null);
      setHasMore(!!res.pagination?.hasMore);
    } catch (err) {
      if (request !== requestRef.current) return;
      console.error('Failed to load record chats:', err);
      setFailed(true);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [listQuery]);

  // Also on coming back from a chat, which has moved its read marker.
  useFocusEffect(
    useCallback(() => {
      void loadFirst();
    }, [loadFirst]),
  );

  const loadMore = useCallback(async () => {
    if (!hasMore || !cursor || loading || loadingMore) return;
    const request = requestRef.current;
    setLoadingMore(true);
    try {
      const res = await appApi.chatEntityChannels.list({ ...listQuery, cursor });
      if (request !== requestRef.current) return;
      setRows((prev) => uniqueRows([prev, res.data ?? []]));
      setCursor(res.pagination?.cursor ?? null);
      setHasMore(!!res.pagination?.hasMore);
    } catch (err) {
      console.error('Failed to load more record chats:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, cursor, loading, loadingMore, listQuery]);

  // New follows and messages in listed chats reload the first page, once per burst.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);
  useChatUserEvents((event) => {
    const channelId = (event.data as { channelId?: unknown } | null)?.channelId;
    const relevant = event.event === 'channel_new' || rows.some((row) => row.id === channelId);
    if (!relevant || refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void loadFirst();
    }, REFRESH_DEBOUNCE_MS);
  });

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  /** A change from a row's menu or swipe, shown at once. */
  const patchRow = useCallback(
    (id: string, patch: ConversationPatch) => {
      const found = rowsRef.current.some((row) => row.id === id);
      setRows((prev) =>
        prev.flatMap((row) => {
          if (row.id !== id) return [row];
          const next = { ...row };
          if (patch.isMuted !== undefined) next.isMuted = patch.isMuted;
          if (patch.hasUnread === false) {
            next.lastReadAt = new Date().toISOString();
            next.unreadMentionCount = 0;
          }
          if (patch.isFollowing !== undefined) {
            next.isFollowing = patch.isFollowing;
            // Only "All" lists chats you don't follow.
            if (!patch.isFollowing && filter !== 'all') return [];
          }
          return [next];
        }),
      );
      // Undoing a failed action on a row that already left the list, or a mark-read: reload.
      if (patch.hasUnread === true || (patch.isFollowing === true && !found)) void loadFirst();
    },
    [filter, loadFirst],
  );

  const toggleFollow = useCallback(
    (row: RecordChatListItem) => {
      swipeableRefs.current.get(row.id)?.close();
      const next = !row.isFollowing;
      forgetMembership(row.id, userId);
      patchRow(row.id, { isFollowing: next });
      const request = next
        ? appApi.chatEntityChannels.follow(row.entityType, row.entityId)
        : appApi.chatEntityChannels.unfollow(row.entityType, row.entityId);
      request.catch(() => {
        patchRow(row.id, { isFollowing: !next });
        toast.error(next ? t.recordChats.followFailed : t.recordChats.unfollowFailed);
      });
    },
    [userId, patchRow, toast, t],
  );

  const toggleMute = useCallback(
    (row: RecordChatListItem) => {
      swipeableRefs.current.get(row.id)?.close();
      if (!userId || !row.isFollowing) return;
      const next = !row.isMuted;
      patchRow(row.id, { isMuted: next });
      updateMembership(row.id, userId, { isMuted: next }).catch(() => {
        patchRow(row.id, { isMuted: !next });
        toast.error(t.recordChats.muteFailed);
      });
    },
    [userId, patchRow, toast, t],
  );

  const emptyText = (() => {
    if (search) return format(t.recordChats.emptySearch, { query: search });
    if (filter === 'following') return t.recordChats.emptyFollowing;
    if (filter === 'unread') return t.recordChats.emptyUnread;
    if (filter === 'mentions') return t.recordChats.emptyMentions;
    return t.recordChats.emptyAll;
  })();

  // The record type is picked from the title (like Home's workspace menu), so
  // the filters keep the only chip row.
  const title = type ? recordGroupLabel(t, type) : t.recordChats.title;
  const typeMenu: MenuAction[] = [
    { id: TYPE_ALL, title: t.recordChats.allTypes, state: type === null ? 'on' : 'off' },
    ...RECORD_CHAT_TYPES.map((key) => ({
      id: key,
      title: recordGroupLabel(t, key),
      image: TYPE_SYMBOLS[key],
      state: key === type ? ('on' as const) : ('off' as const),
    })),
  ];

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={t.common.back}
        >
          <ChevronLeft size={26} color={colors.text} strokeWidth={2} />
        </TouchableOpacity>
        <MenuView
          actions={typeMenu}
          onPressAction={({ nativeEvent }) =>
            setType(isRecordChatType(nativeEvent.event) ? nativeEvent.event : null)
          }
          style={styles.titleMenu}
        >
          <View
            style={styles.titleBtn}
            accessible
            accessibilityRole="button"
            accessibilityLabel={`${title}, ${t.recordChats.chooseType}`}
          >
            <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
            <ChevronDown size={18} color={colors.mutedForeground} strokeWidth={2.2} />
          </View>
        </MenuView>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.5}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View>
            <SearchField
              placeholder={t.recordChats.searchPlaceholder}
              value={query}
              onChangeText={setQuery}
              onClear={() => setQuery('')}
              style={styles.search}
            />
            <ChipRow
              chips={RECORD_CHAT_FILTERS.map((key) => ({ key, label: t.recordChats.filters[key] }))}
              active={filter}
              onSelect={setFilter}
              styles={styles}
            />
          </View>
        }
        renderItem={({ item }) => (
          <ReanimatedSwipeable
            ref={(ref) => {
              if (ref) swipeableRefs.current.set(item.id, ref);
              else swipeableRefs.current.delete(item.id);
            }}
            renderLeftActions={() => (
              <View style={styles.swipeActions}>
                <TouchableOpacity
                  style={[styles.swipeAction, item.isFollowing ? styles.swipeUnfollow : styles.swipeFollow]}
                  onPress={() => toggleFollow(item)}
                >
                  {item.isFollowing ? <UserMinus size={20} color="#fff" /> : <Plus size={20} color="#fff" />}
                  <Text style={styles.swipeActionText}>
                    {item.isFollowing ? t.recordChats.unfollow : t.recordChats.follow}
                  </Text>
                </TouchableOpacity>
                {item.isFollowing && (
                  <TouchableOpacity style={[styles.swipeAction, styles.swipeMute]} onPress={() => toggleMute(item)}>
                    {item.isMuted ? <Bell size={20} color="#fff" /> : <BellOff size={20} color="#fff" />}
                    <Text style={styles.swipeActionText}>
                      {item.isMuted ? t.recordChats.unmute : t.recordChats.mute}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
            overshootLeft={false}
            friction={1.5}
            leftThreshold={30}
          >
            <ConversationMenu conversation={recordMenuTarget(item)} onChange={patchRow}>
              <RecordRow
                chat={item}
                showType={type === null}
                onFollow={() => toggleFollow(item)}
                styles={styles}
                colors={colors}
              />
            </ConversationMenu>
          </ReanimatedSwipeable>
        )}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.loader} color={colors.mutedForeground} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>{failed ? t.recordChats.loadFailed : emptyText}</Text>
              {failed && (
                <TouchableOpacity style={styles.retryBtn} onPress={() => void loadFirst()} accessibilityRole="button">
                  <Text style={styles.retryText}>{t.common.retry}</Text>
                </TouchableOpacity>
              )}
            </View>
          )
        }
        ListFooterComponent={loadingMore ? <ActivityIndicator style={styles.loader} color={colors.mutedForeground} /> : null}
      />
    </View>
  );
}

function ChipRow<K extends string>({
  chips,
  active,
  onSelect,
  styles,
}: Readonly<{ chips: { key: K; label: string }[]; active: K; onSelect: (key: K) => void; styles: Styles }>) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chipRow}
      keyboardShouldPersistTaps="handled"
    >
      {chips.map((chip) => {
        const selected = chip.key === active;
        return (
          <TouchableOpacity
            key={chip.key}
            style={[styles.chip, selected && styles.chipActive]}
            activeOpacity={0.7}
            onPress={() => onSelect(chip.key)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
          >
            <Text style={[styles.chipText, selected && styles.chipTextActive]}>{chip.label}</Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

function RecordRow({
  chat,
  showType,
  onFollow,
  onPress,
  onPressIn,
  styles,
  colors,
}: Readonly<{
  chat: RecordChatListItem;
  /** No type chosen: say which kind of record it is. */
  showType: boolean;
  onFollow: () => void;
  onPress?: () => void;
  onPressIn?: () => void;
  styles: Styles;
  colors: ThemeColors;
}>) {
  const { t } = useI18n();
  const unread = chat.isFollowing && (isUnreadRecordChat(chat) || hasUnreadMentions(chat));
  const Icon = recordChatIcon(chat.entityType) ?? Hash;
  const mentions = chat.unreadMentionCount ?? 0;
  const time = formatMessageTime(chat.lastMessageAt ?? undefined);
  const preview = chat.lastMessagePreview || t.recordChats.noMessages;
  const typeLabel = showType && isRecordChatType(chat.entityType) ? recordTypeLabel(t, chat.entityType) : null;

  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} onPress={onPress} onPressIn={onPressIn}>
      <View style={styles.rowIcon}>
        <Icon size={18} color={colors.text} strokeWidth={2} />
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={[styles.rowName, unread && styles.rowNameUnread]} numberOfLines={1}>
            {recordChatName(chat)}
          </Text>
          {time !== '' && <Text style={[styles.rowTime, unread && styles.rowTimeUnread]}>{time}</Text>}
        </View>
        <View style={styles.rowBottom}>
          <Text style={[styles.rowPreview, unread && styles.rowPreviewUnread]} numberOfLines={1}>
            {typeLabel ? `${typeLabel} · ${preview}` : preview}
          </Text>
          {chat.isMuted && <BellOff size={13} color={colors.mutedForeground} strokeWidth={2} />}
          {mentions > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{mentions}</Text>
            </View>
          )}
          {!chat.isFollowing && (
            <Pressable
              style={({ pressed }) => [styles.followPill, pressed && styles.followPillPressed]}
              onPress={onFollow}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`${t.recordChats.follow} ${recordChatName(chat)}`}
            >
              <Text style={styles.followPillText}>{t.recordChats.follow}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Pressable>
  );
}

const makeStyles = (c: ThemeColors, topInset: number, bottomInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingTop: topInset + 8,
      paddingHorizontal: 12,
      paddingBottom: 8,
      gap: 6,
      backgroundColor: c.background,
    },
    backBtn: { padding: 4 },
    headerTitle: { flexShrink: 1, fontSize: 18, fontWeight: '700', color: c.text },
    // The menu trigger sizes to the title; the title truncates first.
    titleMenu: { flexShrink: 1 },
    titleBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
    list: { paddingBottom: 24 + bottomInset },
    search: { marginHorizontal: 16, marginTop: 4 },
    chipRow: { paddingHorizontal: 16, paddingTop: 10, gap: 8 },
    chip: {
      paddingHorizontal: 14,
      height: 32,
      borderRadius: 10,
      backgroundColor: c.background,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      justifyContent: 'center',
      alignItems: 'center',
    },
    chipActive: { backgroundColor: c.text, borderColor: c.text },
    chipText: { fontSize: 14, fontWeight: '500', color: c.text },
    chipTextActive: { color: c.background, fontWeight: '600' },

    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: c.background,
    },
    rowPressed: { backgroundColor: c.secondary },
    rowIcon: {
      width: 36,
      height: 36,
      borderRadius: 12,
      borderCurve: 'continuous',
      backgroundColor: c.secondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowBody: { flex: 1, minWidth: 0, gap: 2 },
    rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    rowName: { flex: 1, fontSize: 16, fontWeight: '500', color: c.text },
    rowNameUnread: { fontWeight: '700' },
    rowTime: { fontSize: 13, color: c.mutedForeground },
    rowTimeUnread: { color: BRAND, fontWeight: '600' },
    rowBottom: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 22 },
    rowPreview: { flex: 1, fontSize: 14, color: c.mutedForeground },
    rowPreviewUnread: { color: c.text },
    badge: {
      minWidth: 20,
      height: 20,
      borderRadius: 10,
      paddingHorizontal: 6,
      backgroundColor: BRAND,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badgeText: { fontSize: 11, fontWeight: '700', color: '#fff' },
    followPill: {
      paddingHorizontal: 12,
      height: 26,
      borderRadius: 13,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    followPillPressed: { backgroundColor: c.secondary },
    followPillText: { fontSize: 13, fontWeight: '600', color: c.text },

    swipeActions: { flexDirection: 'row' },
    swipeAction: { width: 80, justifyContent: 'center', alignItems: 'center' },
    swipeActionText: { fontSize: 11, fontWeight: '600', color: '#fff', marginTop: 4 },
    swipeFollow: { backgroundColor: BRAND },
    swipeUnfollow: { backgroundColor: c.destructive },
    swipeMute: { backgroundColor: c.muted },

    loader: { marginVertical: 24 },
    empty: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 48, gap: 16 },
    emptyText: { fontSize: 14, color: c.mutedForeground, textAlign: 'center', lineHeight: 20, maxWidth: 300 },
    retryBtn: {
      paddingHorizontal: 18,
      height: 38,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      justifyContent: 'center',
    },
    retryText: { fontSize: 14, fontWeight: '600', color: c.text },
  });
