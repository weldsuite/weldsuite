import { useState, useCallback, useMemo, useRef, type ReactElement } from 'react';
import {
  View,
  Text,
  Image,
  FlatList,
  TouchableOpacity,
  TouchableHighlight,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { ArrowDownLeft, ArrowUpRight, Hash, Phone, PhoneCall, Users, Video } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUser } from '@clerk/expo';
import { useTopic } from '@weldsuite/realtime/react';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import type { ActiveCallSummary, ChatCallHistoryItem } from '@weldsuite/app-api-client/domains/chat-calls';
import { differenceInCalendarDays, format, isToday, isYesterday, type Locale } from 'date-fns';
import { enGB } from 'date-fns/locale/en-GB';
import { nl as nlDateLocale } from 'date-fns/locale/nl';

import type { ThemeColors } from '@/lib/theme-colors';

import { BRAND } from '@/lib/brand';
import { useCall } from '@/contexts/CallContext';
import { appApi } from '@/services/app-api';
import { useI18n, type AppLanguage, type Translations } from '@/lib/i18n';

const PAGE_SIZE = 30;

const DATE_LOCALES: Record<AppLanguage, Locale> = { en: enGB, nl: nlDateLocale };

/** Phone-style recents time: the time today, "Yesterday", the weekday this week, else the date. */
function formatCallTime(iso: string, locale: Locale, yesterday: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (isToday(date)) return format(date, 'p', { locale });
  if (isYesterday(date)) return yesterday;
  if (differenceInCalendarDays(new Date(), date) < 7) return format(date, 'EEEE', { locale });
  return format(date, 'P', { locale });
}

/** 65 → "1:05", 3725 → "1:02:05". */
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const isDm = (item: ChatCallHistoryItem) => item.channelType === 'dm';
const isGroupDm = (item: ChatCallHistoryItem) => isDm(item) && item.otherMembers.length > 1;

/** The person (DM), the people (group DM) or `#channel` the call was with. */
function callTitle(item: ChatCallHistoryItem, t: Translations): string {
  if (isGroupDm(item)) return item.otherMembers.map((m) => m.name || t.calls.unknown).join(', ');
  if (isDm(item)) return item.counterpart?.name || item.channelName || t.calls.unknown;
  return `#${item.channelName ?? ''}`;
}

/** "Missed" / "No answer" / "Declined" / "Incoming" / "Outgoing" / "Ongoing". */
function outcomeLabel(item: ChatCallHistoryItem, t: Translations): string {
  const incoming = item.direction === 'incoming';
  switch (item.outcome) {
    case 'ongoing':
      return t.calls.ongoing;
    case 'missed':
      return incoming ? t.calls.missed : t.calls.noAnswer;
    case 'declined':
      return t.calls.declined;
    default:
      return incoming ? t.calls.incoming : t.calls.outgoing;
  }
}

export default function CallsScreen() {
  const { t, plural, language } = useI18n();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.top), [colors, insets.top]);
  const router = useRouter();
  const { user } = useUser();
  const { joinCall, startCall } = useCall();
  const dateLocale = DATE_LOCALES[language];

  const [active, setActive] = useState<ActiveCallSummary[]>([]);
  const [history, setHistory] = useState<ChatCallHistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [callingId, setCallingId] = useState<string | null>(null);

  // A page that lands after a reload belongs to the old list: drop it.
  const generationRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const focusedRef = useRef(false);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    try {
      const [activeRes, historyRes] = await Promise.allSettled([
        appApi.chatCalls.active(),
        appApi.chatCalls.history({ limit: PAGE_SIZE }),
      ]);
      if (generation !== generationRef.current) return;
      if (activeRes.status === 'fulfilled') {
        setActive(activeRes.value.data ?? []);
      } else {
        console.error('[WeldChat] Failed to load active calls:', activeRes.reason);
      }
      if (historyRes.status === 'fulfilled') {
        setHistory(historyRes.value.data ?? []);
        setCursor(historyRes.value.pagination?.hasMore ? historyRes.value.pagination.cursor : null);
      } else {
        console.error('[WeldChat] Failed to load call history:', historyRes.reason);
      }
    } finally {
      if (generation === generationRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const generation = generationRef.current;
    try {
      const res = await appApi.chatCalls.history({ limit: PAGE_SIZE, cursor });
      if (generation !== generationRef.current) return;
      setHistory((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...(res.data ?? []).filter((c) => !seen.has(c.id))];
      });
      setCursor(res.pagination?.hasMore ? res.pagination.cursor : null);
    } catch (err) {
      console.error('[WeldChat] Failed to load more calls:', err);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [cursor]);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      setLoading(true);
      load();
      return () => {
        focusedRef.current = false;
      };
    }, [load]),
  );

  // A call starting or ending in one of your conversations while you look at the list.
  useTopic<Record<string, unknown>>(user?.id ? `chat.user.${user.id}` : '', (event) => {
    if (!focusedRef.current) return;
    if (event.event === 'call_started' || event.event === 'call_ended') load();
  });

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const handleJoin = useCallback(
    async (callId: string) => {
      setJoiningId(callId);
      try {
        await joinCall(callId);
      } catch (err) {
        console.error('[WeldChat] Failed to join call:', err);
      } finally {
        setJoiningId(null);
      }
    },
    [joinCall],
  );

  const openConversation = useCallback(
    (item: ChatCallHistoryItem) => {
      if (isDm(item)) {
        router.push({
          pathname: '/dm/[channelId]',
          params: { channelId: item.channelId, name: callTitle(item, t), type: 'dm' },
        });
      } else {
        router.push({
          pathname: '/channel/[channelId]',
          params: { channelId: item.channelId, name: item.channelName ?? '', type: item.channelType ?? 'public' },
        });
      }
    },
    [router, t],
  );

  const handleCallBack = useCallback(
    async (item: ChatCallHistoryItem) => {
      setCallingId(item.id);
      try {
        // Same peer as the conversation's own call button, for the "calling" screen.
        const peer = isDm(item)
          ? {
              name: callTitle(item, t),
              avatar: isGroupDm(item) ? null : item.counterpart?.avatar,
              isDirect: true,
            }
          : undefined;
        await startCall(item.channelId, item.callType, peer);
      } catch (err) {
        console.error('[WeldChat] Failed to call back:', err);
      } finally {
        setCallingId(null);
      }
    },
    [startCall, t],
  );

  // Ongoing calls get their own Join rows above the list, so leave them out of it.
  const recent = useMemo(() => {
    const live = new Set(active.map((c) => c.callId));
    return history.filter((c) => !live.has(c.id));
  }, [active, history]);

  // The history row of an ongoing call says who it is with.
  const historyById = useMemo(() => new Map(history.map((c) => [c.id, c])), [history]);

  const renderAvatar = (item: ChatCallHistoryItem) => {
    if (!isDm(item)) {
      return (
        <View style={[styles.avatar, styles.avatarChannel]}>
          <Hash size={20} color={colors.mutedForeground} strokeWidth={2} />
        </View>
      );
    }
    if (isGroupDm(item)) {
      return (
        <View style={styles.avatar}>
          <Users size={20} color="#fff" strokeWidth={2} />
        </View>
      );
    }
    const avatar = item.counterpart?.avatar;
    return (
      <View style={styles.avatar}>
        {avatar ? (
          <Image source={{ uri: avatar }} style={styles.avatarImage} />
        ) : (
          <Text style={styles.avatarText}>{(callTitle(item, t) || '?')[0].toUpperCase()}</Text>
        )}
      </View>
    );
  };

  const renderActive = (call: ActiveCallSummary) => {
    const isVideo = call.callType === 'video';
    const known = historyById.get(call.callId);
    const participants = plural(call.participantCount, t.calls.participantCount);
    return (
      <View key={call.callId} style={styles.row} testID={`calls-ongoing-${call.callId}`}>
        <View style={styles.iconWrap}>
          {isVideo ? (
            <Video size={22} color={colors.success} strokeWidth={2} />
          ) : (
            <Phone size={22} color={colors.success} strokeWidth={2} />
          )}
        </View>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {isVideo ? t.calls.ongoingVideoCall : t.calls.ongoingVoiceCall}
          </Text>
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {known ? `${callTitle(known, t)} · ${participants}` : participants}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.joinBtn}
          activeOpacity={0.85}
          onPress={() => handleJoin(call.callId)}
          disabled={joiningId === call.callId}
        >
          {joiningId === call.callId ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.joinBtnText}>{t.calls.join}</Text>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  const renderItem = ({ item }: { item: ChatCallHistoryItem }) => {
    const incoming = item.direction === 'incoming';
    // Red like a phone's recents: a call that rang you and you never picked up.
    const missed = item.outcome === 'missed' && incoming;
    const arrowColor = missed ? colors.destructive : colors.mutedForeground;
    const Arrow = incoming ? ArrowDownLeft : ArrowUpRight;
    const isVideo = item.callType === 'video';
    const parts = [outcomeLabel(item, t), isVideo ? t.calls.videoCall : t.calls.voiceCall];
    if (item.outcome === 'answered' && item.duration) parts.push(formatDuration(item.duration));
    const CallBackIcon = isVideo ? Video : Phone;

    return (
      <TouchableHighlight
        underlayColor={colors.secondary}
        onPress={() => openConversation(item)}
        testID={`calls-row-${item.id}`}
      >
        <View style={styles.row}>
          {renderAvatar(item)}
          <View style={styles.rowText}>
            <Text style={[styles.rowTitle, missed && { color: colors.destructive }]} numberOfLines={1}>
              {callTitle(item, t)}
            </Text>
            <View style={styles.subtitleRow}>
              <Arrow size={14} color={arrowColor} strokeWidth={2.2} />
              <Text style={[styles.rowSubtitle, styles.subtitleText]} numberOfLines={1}>
                {parts.join(' · ')}
              </Text>
            </View>
          </View>
          <Text style={styles.time}>{formatCallTime(item.createdAt, dateLocale, t.calls.yesterday)}</Text>
          <TouchableOpacity
            style={styles.callBackBtn}
            activeOpacity={0.7}
            onPress={() => handleCallBack(item)}
            disabled={callingId !== null}
            accessibilityRole="button"
            accessibilityLabel={`${t.calls.callBack}: ${callTitle(item, t)}`}
            hitSlop={8}
          >
            {callingId === item.id ? (
              <ActivityIndicator size="small" color={BRAND} />
            ) : (
              <CallBackIcon size={20} color={BRAND} strokeWidth={2} />
            )}
          </TouchableOpacity>
        </View>
      </TouchableHighlight>
    );
  };

  const listHeader =
    active.length > 0 ? (
      <View>
        <Text style={styles.sectionTitle}>{t.calls.ongoing}</Text>
        {active.map(renderActive)}
        {recent.length > 0 && <Text style={styles.sectionTitle}>{t.calls.recent}</Text>}
      </View>
    ) : null;

  const isEmpty = recent.length === 0 && active.length === 0;
  let listEmpty: ReactElement | null = null;
  if (loading) {
    listEmpty = (
      <View style={styles.center}>
        <ActivityIndicator color={colors.muted} />
      </View>
    );
  } else if (isEmpty) {
    listEmpty = (
      <View style={styles.empty} testID="calls-empty">
        <View style={styles.emptyIcon}>
          <PhoneCall size={30} color={colors.muted} strokeWidth={1.8} />
        </View>
        <Text style={styles.emptyTitle}>{t.calls.emptyTitle}</Text>
        <Text style={styles.emptyText}>{t.calls.emptyHint}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.headerTitleWrap} pointerEvents="none">
          <Text style={styles.headerTitle}>{t.tabs.calls}</Text>
        </View>
      </View>

      <FlatList
        testID="calls-list"
        data={recent}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={listEmpty}
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.footer}>
              <ActivityIndicator color={colors.muted} />
            </View>
          ) : null
        }
        contentContainerStyle={isEmpty && styles.emptyContainer}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted} />
        }
      />
    </View>
  );
}

function makeStyles(c: ThemeColors, topInset: number) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    // Same header as Home / Direct messages / Activity: centred 19pt title.
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      minHeight: topInset + 6 + 40 + 8,
      paddingTop: topInset + 6,
      paddingHorizontal: 16,
      paddingBottom: 8,
      backgroundColor: c.background,
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
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 100 },
    sectionTitle: {
      fontSize: 15,
      fontWeight: '700',
      color: c.text,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      gap: 12,
    },
    iconWrap: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: c.cardBackground,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // Same rounded-square avatar as the Direct messages list, a little larger.
    avatar: {
      width: 44,
      height: 44,
      borderRadius: 16,
      backgroundColor: BRAND,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    avatarChannel: { backgroundColor: c.secondary },
    avatarImage: { width: 44, height: 44, borderRadius: 16 },
    avatarText: { fontSize: 17, fontWeight: '600', color: '#fff' },
    rowText: { flex: 1 },
    rowTitle: { fontSize: 15, fontWeight: '600', color: c.text },
    rowSubtitle: { fontSize: 13, color: c.mutedForeground, marginTop: 2 },
    subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
    subtitleText: { flexShrink: 1, marginTop: 0 },
    time: { fontSize: 13, color: c.mutedForeground },
    callBackBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
    },
    joinBtn: {
      backgroundColor: c.success,
      borderRadius: 999,
      paddingHorizontal: 20,
      paddingVertical: 8,
      minWidth: 64,
      alignItems: 'center',
      justifyContent: 'center',
    },
    joinBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
    footer: { paddingVertical: 16, alignItems: 'center' },
    emptyContainer: { flexGrow: 1 },
    empty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 40,
      paddingTop: 100,
    },
    emptyIcon: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: c.cardBackground,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 16,
    },
    emptyTitle: { fontSize: 17, fontWeight: '600', color: c.text, marginBottom: 6 },
    emptyText: { fontSize: 14, color: c.muted, textAlign: 'center', lineHeight: 20 },
  });
}
