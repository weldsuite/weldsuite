/**
 * Notification Storage
 * AsyncStorage-based persistence for notifications in the mobile app
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = '@weldsuite/notifications';
const MAX_STORED_NOTIFICATIONS = 100;

export interface StoredNotification {
  id: string;
  notificationType: string;
  category: string;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
  actionUrl?: string;
  data?: Record<string, unknown>;
  isRead: boolean;
  readAt?: string;
  createdAt: string;
  workspaceId: string;
}

interface NotificationStorage {
  notifications: StoredNotification[];
  unreadCount: number;
  workspaceId: string | null;
  lastSync: string | null;
}

const DEFAULT_STORAGE: NotificationStorage = {
  notifications: [],
  unreadCount: 0,
  workspaceId: null,
  lastSync: null,
};

/**
 * Get all stored notifications
 */
export async function getStoredNotifications(): Promise<StoredNotification[]> {
  try {
    const data = await AsyncStorage.getItem(STORAGE_KEY);
    if (data) {
      const storage: NotificationStorage = JSON.parse(data);
      return storage.notifications;
    }
    return [];
  } catch (error) {
    console.error('[NotificationStorage] Error getting notifications:', error);
    return [];
  }
}

/**
 * Get current storage state
 */
export async function getNotificationStorage(): Promise<NotificationStorage> {
  try {
    const data = await AsyncStorage.getItem(STORAGE_KEY);
    if (data) {
      return JSON.parse(data);
    }
    return DEFAULT_STORAGE;
  } catch (error) {
    console.error('[NotificationStorage] Error getting storage:', error);
    return DEFAULT_STORAGE;
  }
}

/**
 * Save storage state
 */
async function saveStorage(storage: NotificationStorage): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
  } catch (error) {
    console.error('[NotificationStorage] Error saving storage:', error);
  }
}

/**
 * Add a new notification
 */
export async function addNotification(notification: StoredNotification): Promise<void> {
  try {
    const storage = await getNotificationStorage();

    // Avoid duplicates
    if (storage.notifications.some((n) => n.id === notification.id)) {
      return;
    }

    // Add to the beginning and limit total
    storage.notifications = [notification, ...storage.notifications].slice(0, MAX_STORED_NOTIFICATIONS);

    if (!notification.isRead) {
      storage.unreadCount++;
    }

    await saveStorage(storage);
  } catch (error) {
    console.error('[NotificationStorage] Error adding notification:', error);
  }
}

/**
 * Set notifications (replace all)
 */
export async function setNotifications(
  notifications: StoredNotification[],
  workspaceId: string
): Promise<void> {
  try {
    const unreadCount = notifications.filter((n) => !n.isRead).length;

    await saveStorage({
      notifications: notifications.slice(0, MAX_STORED_NOTIFICATIONS),
      unreadCount,
      workspaceId,
      lastSync: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[NotificationStorage] Error setting notifications:', error);
  }
}

/**
 * Mark a notification as read
 */
export async function markNotificationAsRead(notificationId: string): Promise<void> {
  try {
    const storage = await getNotificationStorage();

    const notification = storage.notifications.find((n) => n.id === notificationId);
    if (notification && !notification.isRead) {
      notification.isRead = true;
      notification.readAt = new Date().toISOString();
      storage.unreadCount = Math.max(0, storage.unreadCount - 1);
      await saveStorage(storage);
    }
  } catch (error) {
    console.error('[NotificationStorage] Error marking as read:', error);
  }
}

/**
 * Mark all notifications as read
 */
export async function markAllNotificationsAsRead(): Promise<void> {
  try {
    const storage = await getNotificationStorage();
    const now = new Date().toISOString();

    storage.notifications = storage.notifications.map((n) => ({
      ...n,
      isRead: true,
      readAt: n.readAt || now,
    }));
    storage.unreadCount = 0;

    await saveStorage(storage);
  } catch (error) {
    console.error('[NotificationStorage] Error marking all as read:', error);
  }
}

/**
 * Delete a notification
 */
export async function deleteNotification(notificationId: string): Promise<void> {
  try {
    const storage = await getNotificationStorage();

    const notification = storage.notifications.find((n) => n.id === notificationId);
    if (notification) {
      storage.notifications = storage.notifications.filter((n) => n.id !== notificationId);
      if (!notification.isRead) {
        storage.unreadCount = Math.max(0, storage.unreadCount - 1);
      }
      await saveStorage(storage);
    }
  } catch (error) {
    console.error('[NotificationStorage] Error deleting notification:', error);
  }
}

/**
 * Get unread count
 */
export async function getUnreadCount(): Promise<number> {
  try {
    const storage = await getNotificationStorage();
    return storage.unreadCount;
  } catch (error) {
    console.error('[NotificationStorage] Error getting unread count:', error);
    return 0;
  }
}

/**
 * Set unread count
 */
export async function setUnreadCount(count: number): Promise<void> {
  try {
    const storage = await getNotificationStorage();
    storage.unreadCount = count;
    await saveStorage(storage);
  } catch (error) {
    console.error('[NotificationStorage] Error setting unread count:', error);
  }
}

/**
 * Sync with server notifications
 */
export async function syncWithServer(
  serverNotifications: StoredNotification[],
  workspaceId: string
): Promise<void> {
  try {
    const storage = await getNotificationStorage();

    // If workspace changed, replace all
    if (storage.workspaceId !== workspaceId) {
      await setNotifications(serverNotifications, workspaceId);
      return;
    }

    // Merge: keep local read status but update with server data
    const serverIds = new Set(serverNotifications.map((n) => n.id));
    const localMap = new Map(storage.notifications.map((n) => [n.id, n]));

    const merged: StoredNotification[] = [];

    // Add server notifications, preserving local read status
    for (const serverNotification of serverNotifications) {
      const local = localMap.get(serverNotification.id);
      if (local && local.isRead && !serverNotification.isRead) {
        // Keep local read status
        merged.push({ ...serverNotification, isRead: true, readAt: local.readAt });
      } else {
        merged.push(serverNotification);
      }
    }

    // Add any local notifications not on server (recent ones)
    for (const local of storage.notifications) {
      if (!serverIds.has(local.id)) {
        // Keep local notification if it's recent (within last hour)
        const createdAt = new Date(local.createdAt);
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
        if (createdAt > hourAgo) {
          merged.push(local);
        }
      }
    }

    // Sort by createdAt descending
    merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    await setNotifications(merged.slice(0, MAX_STORED_NOTIFICATIONS), workspaceId);
  } catch (error) {
    console.error('[NotificationStorage] Error syncing with server:', error);
  }
}

/**
 * Clear all notifications
 */
export async function clearNotifications(): Promise<void> {
  try {
    await saveStorage(DEFAULT_STORAGE);
  } catch (error) {
    console.error('[NotificationStorage] Error clearing notifications:', error);
  }
}

/**
 * Get notifications grouped by date
 */
export async function getGroupedNotifications(): Promise<{
  today: StoredNotification[];
  yesterday: StoredNotification[];
  earlier: StoredNotification[];
}> {
  const notifications = await getStoredNotifications();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const groups = {
    today: [] as StoredNotification[],
    yesterday: [] as StoredNotification[],
    earlier: [] as StoredNotification[],
  };

  for (const n of notifications) {
    const date = new Date(n.createdAt);
    date.setHours(0, 0, 0, 0);

    if (date.getTime() === today.getTime()) {
      groups.today.push(n);
    } else if (date.getTime() === yesterday.getTime()) {
      groups.yesterday.push(n);
    } else {
      groups.earlier.push(n);
    }
  }

  return groups;
}
