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

async function saveStorage(storage: NotificationStorage): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
  } catch (error) {
    console.error('[NotificationStorage] Error saving storage:', error);
  }
}

export async function addNotification(notification: StoredNotification): Promise<void> {
  try {
    const storage = await getNotificationStorage();
    if (storage.notifications.some((n) => n.id === notification.id)) return;
    storage.notifications = [notification, ...storage.notifications].slice(0, MAX_STORED_NOTIFICATIONS);
    if (!notification.isRead) storage.unreadCount++;
    await saveStorage(storage);
  } catch (error) {
    console.error('[NotificationStorage] Error adding notification:', error);
  }
}

export async function setNotifications(notifications: StoredNotification[], workspaceId: string): Promise<void> {
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

export async function markAllNotificationsAsRead(): Promise<void> {
  try {
    const storage = await getNotificationStorage();
    const now = new Date().toISOString();
    storage.notifications = storage.notifications.map((n) => ({
      ...n, isRead: true, readAt: n.readAt || now,
    }));
    storage.unreadCount = 0;
    await saveStorage(storage);
  } catch (error) {
    console.error('[NotificationStorage] Error marking all as read:', error);
  }
}

export async function getUnreadCount(): Promise<number> {
  try {
    const storage = await getNotificationStorage();
    return storage.unreadCount;
  } catch (error) {
    console.error('[NotificationStorage] Error getting unread count:', error);
    return 0;
  }
}

export async function clearNotifications(): Promise<void> {
  try {
    await saveStorage(DEFAULT_STORAGE);
  } catch (error) {
    console.error('[NotificationStorage] Error clearing notifications:', error);
  }
}
