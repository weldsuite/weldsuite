import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  Pressable,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import Svg, { Path, Line } from 'react-native-svg';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  Package,
  Receipt,
  CheckSquare,
  Mail,
  Calendar,
  Shield,
  Info,
  Bell,
  Trash2,
} from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api from '@/services/api';
import { haptics } from '@/utils/haptics';

interface NotificationItem {
  id: string;
  title: string;
  body: string | null;
  category: string;
  notificationType: string;
  entityType: string | null;
  entityId: string | null;
  actionUrl: string | null;
  severity: string;
  isRead: boolean;
  createdAt: string;
  data?: Record<string, unknown>;
}

// Category-based icons (matches platform app)
function getCategoryIcon(category: string) {
  switch (category) {
    case 'commerce':
      return Package;
    case 'accounting':
      return Receipt;
    case 'projects':
    case 'task':
      return CheckSquare;
    case 'mail':
    case 'helpdesk':
      return Mail;
    case 'meeting':
      return Calendar;
    case 'security':
      return Shield;
    case 'system':
      return Info;
    default:
      return Bell;
  }
}

// Category-based colors (matches platform app)
function getCategoryColor(category: string): string {
  switch (category) {
    case 'commerce':
      return '#3B82F6'; // blue
    case 'accounting':
      return '#10B981'; // green
    case 'projects':
    case 'task':
      return '#8B5CF6'; // purple
    case 'mail':
    case 'helpdesk':
      return '#06B6D4'; // cyan
    case 'security':
      return '#EF4444'; // red
    case 'system':
      return '#F59E0B'; // amber
    default:
      return '#6B7280'; // gray
  }
}

// Navigation path from entity (matches platform app)
function getNotificationRoute(notification: NotificationItem): string | null {
  if (notification.actionUrl) {
    return notification.actionUrl;
  }

  if (!notification.entityType || !notification.entityId) {
    return null;
  }

  switch (notification.entityType.toLowerCase()) {
    case 'order':
      return `/order/${notification.entityId}`;
    case 'invoice':
      return `/invoice/${notification.entityId}`;
    case 'projecttask':
    case 'task':
      return `/task/task/${notification.entityId}`;
    case 'emailmessage':
      return `/mail/${notification.entityId}`;
    case 'project':
      return `/projects/project/${notification.entityId}`;
    case 'ticket':
      return `/helpdesk/ticket/${notification.entityId}`;
    case 'customer':
      return `/customer/${notification.entityId}`;
    default:
      return null;
  }
}

// Format timestamp (relative)
function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// Group notifications by date
function groupNotifications(notifications: NotificationItem[]) {
  const today: NotificationItem[] = [];
  const yesterday: NotificationItem[] = [];
  const earlier: NotificationItem[] = [];

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86400000);

  for (const n of notifications) {
    const date = new Date(n.createdAt);
    if (date >= startOfToday) {
      today.push(n);
    } else if (date >= startOfYesterday) {
      yesterday.push(n);
    } else {
      earlier.push(n);
    }
  }

  return { today, yesterday, earlier };
}

export default function NotificationsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { showToast } = useToast();

  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const fetchNotifications = useCallback(async () => {
    try {
      const [listRes, countRes] = await Promise.all([
        api.listNotifications(1, 50),
        api.getSettingsUnreadCount(),
      ]);

      if (listRes.data) {
        // The endpoint returns { success, data: items[], pagination }
        const items = Array.isArray(listRes.data) ? listRes.data : [];
        setNotifications(items);
      }

      if (countRes.data?.count != null) {
        setUnreadCount(countRes.data.count);
      }
    } catch (error) {
      console.error('Failed to fetch notifications:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchNotifications();
  }, [fetchNotifications]);

  const handleNotificationPress = async (notification: NotificationItem) => {
    // Mark as read
    if (!notification.isRead) {
      try {
        await api.markNotificationRead(notification.id);
        setNotifications((prev) =>
          prev.map((n) => (n.id === notification.id ? { ...n, isRead: true } : n))
        );
        setUnreadCount((prev) => Math.max(0, prev - 1));
      } catch (error) {
        console.error('Failed to mark notification as read:', error);
      }
    }

    // Navigate based on entity
    const route = getNotificationRoute(notification);
    if (route) {
      router.push(route as any);
    }
  };

  const handleMarkAllAsRead = async () => {
    haptics.light();
    try {
      await api.markAllNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      setUnreadCount(0);
      showToast('All notifications marked as read', 'success');
    } catch (error) {
      console.error('Failed to mark all as read:', error);
      showToast('Failed to mark all as read', 'error');
    }
  };

  const handleDelete = async (notificationId: string) => {
    haptics.medium();
    try {
      await api.deleteNotification(notificationId);
      setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
    } catch (error) {
      console.error('Failed to delete notification:', error);
    }
  };

  const groups = groupNotifications(notifications);
  const hasNotifications =
    groups.today.length > 0 || groups.yesterday.length > 0 || groups.earlier.length > 0;

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.text} />
          <Text style={[styles.loadingText, { color: colors.muted }]}>Loading notifications...</Text>
        </View>
      </SafeAreaView>
    );
  }

  const renderNotification = (notification: NotificationItem) => {
    const IconComponent = getCategoryIcon(notification.category);
    const categoryColor = getCategoryColor(notification.category);

    return (
      <Pressable
        key={notification.id}
        style={({ pressed }) => [
          styles.notificationRow,
          {
            backgroundColor: pressed
              ? colors.pressed
              : notification.isRead
                ? 'transparent'
                : `${categoryColor}08`,
          },
        ]}
        onPress={() => handleNotificationPress(notification)}
      >
        {/* Unread indicator */}
        {!notification.isRead && (
          <View style={[styles.unreadDot, { backgroundColor: categoryColor }]} />
        )}

        {/* Icon */}
        <View style={[styles.iconContainer, { backgroundColor: `${categoryColor}15` }]}>
          <IconComponent size={18} color={categoryColor} strokeWidth={1.5} />
        </View>

        {/* Content */}
        <View style={styles.textContent}>
          <Text
            style={[
              styles.notificationTitle,
              { color: colors.text, fontWeight: notification.isRead ? '400' : '600' },
            ]}
            numberOfLines={1}
          >
            {notification.title}
          </Text>
          {notification.body ? (
            <Text style={[styles.notificationBody, { color: colors.muted }]} numberOfLines={2}>
              {notification.body}
            </Text>
          ) : null}
          <Text style={[styles.notificationTime, { color: colors.muted }]}>
            {formatTime(notification.createdAt)}
          </Text>
        </View>
      </Pressable>
    );
  };

  const renderGroup = (title: string, items: NotificationItem[]) => {
    if (items.length === 0) return null;
    return (
      <View style={styles.group}>
        <Text style={[styles.groupTitle, { color: colors.muted }]}>{title}</Text>
        <View style={[styles.groupCard, { backgroundColor: colors.cardBackground }]}>
          {items.map((notification, index) => (
            <View key={notification.id}>
              {renderNotification(notification)}
              {index < items.length - 1 && (
                <View style={[styles.separator, { backgroundColor: colors.divider, marginLeft: 60 }]} />
              )}
            </View>
          ))}
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Notifications</Text>
          {unreadCount > 0 && (
            <View style={[styles.badge, { backgroundColor: '#EF4444' }]}>
              <Text style={styles.badgeText}>{unreadCount}</Text>
            </View>
          )}
        </View>
        {unreadCount > 0 && (
          <View style={styles.headerActions}>
            <TouchableOpacity onPress={handleMarkAllAsRead}>
              <Text style={[styles.markAllRead, { color: '#007AFF' }]}>Mark all read</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {!hasNotifications ? (
        <View style={styles.emptyState}>
          <View style={styles.illustrationContainer}>
            <Svg width={240} height={170} style={StyleSheet.absoluteFill}>
              {Array.from({ length: 10 }, (_, i) => (
                <Line
                  key={`v${i}`}
                  x1={i * 28}
                  y1={0}
                  x2={i * 28}
                  y2={170}
                  stroke={colors.divider}
                  strokeWidth={0.5}
                  strokeDasharray="3 3"
                />
              ))}
              {Array.from({ length: 7 }, (_, i) => (
                <Line
                  key={`h${i}`}
                  x1={0}
                  y1={i * 28}
                  x2={240}
                  y2={i * 28}
                  stroke={colors.divider}
                  strokeWidth={0.5}
                  strokeDasharray="3 3"
                />
              ))}
            </Svg>
            <Svg width={120} height={120} viewBox="0 0 120 120">
              <Path
                d="M36 58C36 44.7 46.7 34 60 34C73.3 34 84 44.7 84 58V72C84 74.2 85.2 76.2 87 77.5C88 78.2 88 79 88 79C88 80.7 86.7 82 85 82H35C33.3 82 32 80.7 32 79C32 79 32 78.2 33 77.5C34.8 76.2 36 74.2 36 72V58Z"
                fill="white"
                stroke="#D1D5DB"
                strokeWidth={1}
              />
              <Path
                d="M50 82H70C70 87.5 65.5 92 60 92C54.5 92 50 87.5 50 82Z"
                fill="white"
                stroke="#D1D5DB"
                strokeWidth={1}
              />
            </Svg>
          </View>
          <Text style={[styles.emptyStateTitle, { color: colors.text }]}>No notifications</Text>
          <Text style={[styles.emptyStateText, { color: colors.muted }]}>
            You're all caught up! Check back later for updates.
          </Text>
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.text} />
          }
        >
          {renderGroup('Today', groups.today)}
          {renderGroup('Yesterday', groups.yesterday)}
          {renderGroup('Earlier', groups.earlier)}
          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 15,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 10,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  markAllRead: {
    fontSize: 15,
    fontWeight: '400',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
    minWidth: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  group: {
    marginTop: 16,
    paddingHorizontal: 16,
  },
  groupTitle: {
    fontSize: 13,
    fontWeight: '400',
    textTransform: 'uppercase',
    marginBottom: 8,
    marginLeft: 16,
  },
  groupCard: {
    borderRadius: 10,
    overflow: 'hidden',
  },
  notificationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    paddingLeft: 16,
    minHeight: 64,
  },
  unreadDot: {
    position: 'absolute',
    left: 4,
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  textContent: {
    flex: 1,
  },
  notificationTitle: {
    fontSize: 15,
  },
  notificationBody: {
    fontSize: 14,
    lineHeight: 19,
    marginTop: 2,
  },
  notificationTime: {
    fontSize: 13,
    marginTop: 3,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
    paddingBottom: 100,
  },
  illustrationContainer: {
    width: 240,
    height: 170,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  emptyStateTitle: {
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 6,
  },
  emptyStateText: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    maxWidth: 280,
  },
});
