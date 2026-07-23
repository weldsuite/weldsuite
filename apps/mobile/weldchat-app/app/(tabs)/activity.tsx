import { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  Pressable,
  SectionList,
  Image,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import {
  AtSign,
  Bell,
  MessageSquare,
  Mail,
  PhoneMissed,
  MailCheck,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';
import appApi from '@/services/app-api';
import { useChatUserEvents } from '@/hooks/useChatUserEvents';

interface ActivityNotification {
  id: string;
  title: string;
  body: string | null;
  notificationType: string;
  entityType: string | null;
  entityId: string | null;
  actionUrl: string | null;
  isRead: boolean;
  createdAt: string;
  actorName: string | null;
  actorAvatar: string | null;
}

function getDateLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  today.setHours(0, 0, 0, 0);
  yesterday.setHours(0, 0, 0, 0);
  const dd = new Date(d);
  dd.setHours(0, 0, 0, 0);

  if (dd.getTime() === today.getTime()) return 'Today';
  if (dd.getTime() === yesterday.getTime()) return 'Yesterday';

  const diffDays = Math.floor((today.getTime() - dd.getTime()) / 86400000);
  if (diffDays < 7) return 'This week';
  if (diffDays < 30) return 'Earlier this month';
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

function getNotificationIcon(type: string, color: string) {
  switch (type) {
    case 'chat_mention':
      return <AtSign size={18} color={color} strokeWidth={2} />;
    case 'chat_thread_reply':
      return <MessageSquare size={18} color={color} strokeWidth={2} />;
    case 'chat_dm':
      return <Mail size={18} color={color} strokeWidth={2} />;
    case 'chat_missed_call':
      return <PhoneMissed size={18} color={color} strokeWidth={2} />;
    default:
      return <Bell size={18} color={color} strokeWidth={2} />;
  }
}

export default function ActivityTab() {
  const [notifications, setNotifications] = useState<ActivityNotification[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.top), [colors, insets.top]);

  const loadNotifications = useCallback(async () => {
    try {
      const res = await appApi.notifications.list({ limit: 50 });
      const mapped: ActivityNotification[] = (res.data ?? []).map((n) => ({
        id: n.id,
        title: n.title ?? '',
        body: n.body,
        notificationType: n.category ?? 'default',
        entityType: n.entityType,
        entityId: n.entityId,
        actionUrl: n.actionUrl,
        isRead: n.isRead ?? false,
        createdAt: n.createdAt,
        actorName: n.actorName ?? null,
        actorAvatar: n.actorAvatar ?? null,
      }));
      setNotifications(mapped);
    } catch (err) {
      console.error('Failed to load notifications:', err);
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadNotifications();
    setRefreshing(false);
  }, [loadNotifications]);

  useFocusEffect(
    useCallback(() => {
      loadNotifications();
    }, [loadNotifications]),
  );

  useChatUserEvents(loadNotifications);

  const handleTap = useCallback(
    async (item: ActivityNotification) => {
      if (!item.isRead) {
        setNotifications((prev) =>
          prev.map((n) => (n.id === item.id ? { ...n, isRead: true } : n)),
        );
        appApi.notifications.markRead(item.id).catch(() => {});
      }

      if (item.actionUrl) {
        const channelMatch = item.actionUrl.match(/\/weldchat\/([^?/]+)/);
        const dmMatch = item.actionUrl.match(/\/weldchat\/dm\/([^?/]+)/);
        if (dmMatch) {
          router.push(`/dm/${dmMatch[1]}` as any);
        } else if (channelMatch) {
          router.push(`/channel/${channelMatch[1]}` as any);
        }
      }
    },
    [router],
  );

  const handleMarkAllRead = useCallback(async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    appApi.notifications.markAllRead().catch(() => {});
  }, []);

  const hasUnread = notifications.some((n) => !n.isRead);

  const sections = useMemo(() => {
    const groups = new Map<string, ActivityNotification[]>();
    const order: string[] = [];
    for (const n of notifications) {
      const label = getDateLabel(n.createdAt);
      if (!groups.has(label)) {
        groups.set(label, []);
        order.push(label);
      }
      groups.get(label)!.push(n);
    }
    return order.map((label) => ({
      title: label,
      data: groups.get(label) ?? [],
    }));
  }, [notifications]);

  const renderItem = useCallback(
    ({ item }: { item: ActivityNotification }) => {
      const hasUnread = !item.isRead;
      return (
        <Pressable
          style={({ pressed }) => [
            styles.dmItem,
            hasUnread && styles.dmItemUnread,
            pressed && styles.dmItemPressed,
          ]}
          onPress={() => handleTap(item)}
          android_ripple={{ color: colors.bgTertiary }}
        >
          <View style={styles.dmItemInner}>
            <View style={styles.avatarOuter}>
              <View style={styles.avatar}>
                {item.actorAvatar ? (
                  <Image source={{ uri: item.actorAvatar }} style={styles.avatarImage} />
                ) : item.actorName ? (
                  <Text style={styles.avatarText}>{item.actorName[0].toUpperCase()}</Text>
                ) : (
                  getNotificationIcon(item.notificationType, '#fff')
                )}
              </View>
            </View>
            <View style={styles.dmInfo}>
              <View style={styles.dmTopRow}>
                <Text style={styles.dmName} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={[styles.dmTime, hasUnread && styles.dmTimeUnread]}>
                  {formatTime(item.createdAt)}
                </Text>
              </View>
              <View style={styles.dmBottomRow}>
                <Text
                  style={[styles.dmLastMessage, hasUnread && styles.dmLastMessageUnread]}
                  numberOfLines={2}
                >
                  {item.body || ''}
                </Text>
                {hasUnread && <View style={styles.unreadDot} />}
              </View>
            </View>
          </View>
        </Pressable>
      );
    },
    [styles, colors.bgTertiary, handleTap],
  );

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.headerRow}>
        <View style={styles.headerTitleWrap} pointerEvents="none">
          <Text style={styles.headerTitle}>Inbox</Text>
        </View>

        <View style={styles.headerRightGroup}>
          <TouchableOpacity
            style={styles.headerSquareBtn}
            activeOpacity={0.7}
            onPress={handleMarkAllRead}
            disabled={!hasUnread}
          >
            <MailCheck size={20} color={hasUnread ? colors.textPrimary : colors.textMuted} />
          </TouchableOpacity>
        </View>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeaderText}>{section.title}</Text>
        )}
        stickySectionHeadersEnabled
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textMuted} />
        }
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          !refreshing ? (
            <View style={styles.emptyContent}>
              <Text style={styles.emptyTitle}>No notifications yet</Text>
              <Text style={styles.emptyText}>Mentions and replies will appear here</Text>
            </View>
          ) : null
        }
      />
    </View>
  );
}

const makeStyles = (c: ColorScheme, topInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bgPrimary },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: topInset + 6,
      paddingHorizontal: 16,
      paddingBottom: 8,
      backgroundColor: c.bgPrimary,
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
    headerTitle: {
      fontSize: 19,
      fontWeight: '700',
      color: c.textPrimary,
    },
    headerRightGroup: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    listContent: { paddingBottom: 32 },
    sectionHeaderText: {
      fontSize: 12,
      fontWeight: '600',
      color: c.textMuted,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      backgroundColor: c.bgPrimary,
      paddingHorizontal: 16,
      paddingTop: 18,
      paddingBottom: 8,
    },
    dmItem: { backgroundColor: c.bgPrimary },
    dmItemUnread: { backgroundColor: c.bgTertiary },
    dmItemPressed: { backgroundColor: c.bgTertiary },
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
      overflow: 'hidden',
    },
    avatarText: { fontSize: 15, fontWeight: '600', color: '#fff' },
    avatarImage: { width: 36, height: 36, borderRadius: 13 },
    dmInfo: { flex: 1, gap: 3, marginTop: -1 },
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
    dmTime: { fontSize: 13, color: c.textMuted },
    dmTimeUnread: { color: c.brand, fontWeight: '600' },
    dmBottomRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    dmLastMessage: {
      flex: 1,
      fontSize: 15,
      color: c.textPrimary,
      opacity: 0.6,
      fontWeight: '400',
      lineHeight: 19,
    },
    dmLastMessageUnread: { color: c.textPrimary, opacity: 1, fontWeight: '500' },
    unreadDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: c.brand,
    },
    emptyContent: {
      paddingTop: 80,
      paddingHorizontal: 32,
      alignItems: 'center',
      gap: 6,
    },
    emptyTitle: { fontSize: 16, fontWeight: '600', color: c.textPrimary },
    emptyText: {
      fontSize: 14,
      color: c.textMuted,
      textAlign: 'center',
      maxWidth: 280,
      lineHeight: 20,
    },
  });
