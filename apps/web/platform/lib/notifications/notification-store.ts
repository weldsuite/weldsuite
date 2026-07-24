/**
 * Zustand store for notification state management
 * Manages notification history, unread counts, and real-time updates
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { UnifiedNotification } from './signalr-notification-client';

const MAX_STORED_NOTIFICATIONS = 100;

interface NotificationState {
  // Notification data
  notifications: UnifiedNotification[];
  unreadCount: number;

  // Workspace context
  workspaceId: string | null;

  // Loading states
  isLoading: boolean;
  hasMore: boolean;

  // Actions
  addNotification: (notification: UnifiedNotification) => void;
  setNotifications: (notifications: UnifiedNotification[]) => void;
  appendNotifications: (notifications: UnifiedNotification[]) => void;
  markAsRead: (notificationId: string) => void;
  markAllAsRead: () => void;
  deleteNotification: (notificationId: string) => void;
  setUnreadCount: (count: number) => void;
  decrementUnreadCount: () => void;
  /** Merge `dataPatch` into the `data` field of every notification matching the given entity. */
  patchNotificationsByEntity: (
    entityType: string,
    entityId: string,
    dataPatch: Record<string, unknown>,
  ) => void;
  setWorkspace: (workspaceId: string) => void;
  setLoading: (loading: boolean) => void;
  setHasMore: (hasMore: boolean) => void;
  clearNotifications: () => void;
  reset: () => void;
}

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set) => ({
      // Initial state
      notifications: [],
      unreadCount: 0,
      workspaceId: null,
      isLoading: false,
      hasMore: true,

      // Add a new notification (from real-time)
      addNotification: (notification) =>
        set((state) => {
          // Avoid duplicates
          if (state.notifications.some((n) => n.id === notification.id)) {
            return state;
          }

          const updated = [notification, ...state.notifications];
          return {
            notifications: updated.slice(0, MAX_STORED_NOTIFICATIONS),
            unreadCount: state.unreadCount + 1,
          };
        }),

      // Set notifications (replace all)
      setNotifications: (notifications) =>
        set({
          notifications,
          hasMore: notifications.length >= 50,
        }),

      // Append notifications (for pagination)
      appendNotifications: (notifications) =>
        set((state) => {
          const existingIds = new Set(state.notifications.map((n) => n.id));
          const newNotifications = notifications.filter((n) => !existingIds.has(n.id));

          return {
            notifications: [...state.notifications, ...newNotifications],
            hasMore: notifications.length >= 50,
          };
        }),

      // Mark a notification as read
      markAsRead: (notificationId) =>
        set((state) => {
          const notification = state.notifications.find((n) => n.id === notificationId);
          if (!notification) return state;

          // Only decrement if not already read
          const wasUnread = !notification.isRead;

          return {
            notifications: state.notifications.map((n) =>
              n.id === notificationId
                ? { ...n, isRead: true, readAt: new Date().toISOString() }
                : n
            ),
            unreadCount: wasUnread ? Math.max(0, state.unreadCount - 1) : state.unreadCount,
          };
        }),

      // Mark all notifications as read
      markAllAsRead: () =>
        set((state) => ({
          notifications: state.notifications.map((n) => ({
            ...n,
            isRead: true,
            readAt: new Date().toISOString(),
          })),
          unreadCount: 0,
        })),

      // Delete a notification
      deleteNotification: (notificationId) =>
        set((state) => ({
          notifications: state.notifications.filter((n) => n.id !== notificationId),
        })),

      // Set unread count (from server)
      setUnreadCount: (count) => set({ unreadCount: count }),

      // Decrement unread count
      decrementUnreadCount: () =>
        set((state) => ({
          unreadCount: Math.max(0, state.unreadCount - 1),
        })),

      // Patch the `data` field of every notification matching the given entity.
      patchNotificationsByEntity: (entityType, entityId, dataPatch) =>
        set((state) => ({
          notifications: state.notifications.map((n) =>
            n.entityType === entityType && n.entityId === entityId
              ? { ...n, data: { ...(n.data ?? {}), ...dataPatch } }
              : n,
          ),
        })),

      // Set workspace (clears notifications if workspace changes)
      setWorkspace: (workspaceId) =>
        set((state) => {
          if (state.workspaceId === workspaceId) return state;

          return {
            workspaceId,
            notifications: [],
            unreadCount: 0,
            hasMore: true,
          };
        }),

      // Set loading state
      setLoading: (loading) => set({ isLoading: loading }),

      // Set hasMore for pagination
      setHasMore: (hasMore) => set({ hasMore }),

      // Clear all notifications
      clearNotifications: () =>
        set({
          notifications: [],
          unreadCount: 0,
          hasMore: true,
        }),

      // Reset store
      reset: () =>
        set({
          notifications: [],
          unreadCount: 0,
          workspaceId: null,
          isLoading: false,
          hasMore: true,
        }),
    }),
    {
      name: 'weldsuite-notifications',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        // Only persist notifications and unread count
        notifications: state.notifications.slice(0, 50), // Limit persisted notifications
        unreadCount: state.unreadCount,
        workspaceId: state.workspaceId,
      }),
    }
  )
);
