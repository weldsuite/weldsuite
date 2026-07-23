
/**
 * Unified Notification Context
 * Provides real-time notifications via @weldsuite/realtime with workspace-scoped channels
 * Fire-and-forget architecture - notifications are pushed from backend
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
} from 'react';
import { useUser, useOrganization } from '@clerk/clerk-react';
import { useNotificationStore } from '@/lib/notifications/notification-store';
import type { ConnectionStatus } from '@/lib/notifications/types';
import { useAppApi } from '@/lib/api/use-app-api';
import type { NotificationActor } from '@weldsuite/core-api-client/schemas';
import { useTopic } from '@weldsuite/realtime/react';
import { topics } from '@weldsuite/realtime/topics';

// Re-export UnifiedNotification type for backwards compatibility
export interface UnifiedNotification {
  id: string;
  notificationType: string;
  category: string;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
  actionUrl?: string;
  data?: Record<string, unknown>;
  createdAt: string;
  isRead?: boolean;
  /** Hydrated server-side; null for legacy rows / system events with no actor. */
  actor?: NotificationActor | null;
}

interface UnifiedNotificationContextValue {
  // Connection state
  status: ConnectionStatus;
  isConnected: boolean;

  // Notification data (from store)
  notifications: UnifiedNotification[];
  unreadCount: number;
  isLoading: boolean;
  hasMore: boolean;

  // Real-time subscription
  subscribe: (handler: (notification: UnifiedNotification) => void) => () => void;
  subscribeToCategory: (category: string, handler: (notification: UnifiedNotification) => void) => () => void;

  // Email account subscriptions (for mail module)
  subscribeToEmailAccount: (accountId: string) => Promise<void>;
  unsubscribeFromEmailAccount: (accountId: string) => Promise<void>;

  // Actions
  markAsRead: (notificationId: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  deleteNotification: (notificationId: string) => Promise<void>;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;

  // Legacy compatibility
  clearNotifications: () => void;
}

const UnifiedNotificationContext = createContext<UnifiedNotificationContextValue | null>(null);

interface UnifiedNotificationProviderProps {
  children: React.ReactNode;
}

export function UnifiedNotificationProvider({ children }: UnifiedNotificationProviderProps) {
  const { user, isLoaded: userLoaded } = useUser();
  const { organization, isLoaded: orgLoaded } = useOrganization();
  const { notifications: notificationsApi } = useAppApi();

  const [status] = useState<ConnectionStatus>('disconnected');
  const initialized = useRef(false);
  const notificationHandlers = useRef<Set<(notification: UnifiedNotification) => void>>(new Set());
  const categoryHandlers = useRef<Map<string, Set<(notification: UnifiedNotification) => void>>>(new Map());

  // Get store values
  const notifications = useNotificationStore((state) => state.notifications);
  const unreadCount = useNotificationStore((state) => state.unreadCount);
  const isLoading = useNotificationStore((state) => state.isLoading);
  const hasMore = useNotificationStore((state) => state.hasMore);
  const storeWorkspaceId = useNotificationStore((state) => state.workspaceId);

  // Store actions
  const {
    addNotification,
    setNotifications,
    appendNotifications,
    markAsRead: storeMarkAsRead,
    markAllAsRead: storeMarkAllAsRead,
    deleteNotification: storeDeleteNotification,
    setUnreadCount,
    setWorkspace,
    setLoading,
    setHasMore,
    clearNotifications,
    patchNotificationsByEntity,
  } = useNotificationStore();

  // Bootstrap: set workspace and load initial notifications
  useEffect(() => {
    if (!userLoaded || !orgLoaded) return;
    if (!user?.id || !organization?.id) return;
    if (initialized.current) return;

    initialized.current = true;

    if (organization.id !== storeWorkspaceId) {
      setWorkspace(organization.id);
    }

    loadNotificationsFromServer(false).catch((error) => {
      console.error('[UnifiedNotification] Failed to load initial notifications:', error);
    });
  }, [user?.id, organization?.id, userLoaded, orgLoaded, storeWorkspaceId, setWorkspace]);

  // ──────────────────────────────────────────────────────────────────────────
  // @weldsuite/realtime — subscribe to the user's notification topic so rows
  // published via RealtimePublisher show up in the bell live. The store
  // dedupes by id, so this safely coexists with the paginated fetch below.
  // ──────────────────────────────────────────────────────────────────────────
  const realtimeNotificationTopic = user?.id ? topics.notification(user.id) : '';
  useTopic<UnifiedNotification>(realtimeNotificationTopic, (event) => {
    if (!realtimeNotificationTopic) return;
    if (event.event !== 'created') return;
    const incoming = event.data;
    if (!incoming || typeof incoming !== 'object' || !('id' in incoming)) return;

    const notification: UnifiedNotification = {
      id: incoming.id,
      notificationType: incoming.notificationType,
      category: incoming.category,
      title: incoming.title,
      body: incoming.body ?? '',
      entityType: incoming.entityType ?? undefined,
      entityId: incoming.entityId ?? undefined,
      actionUrl: incoming.actionUrl ?? undefined,
      data: incoming.data ?? undefined,
      createdAt:
        typeof incoming.createdAt === 'string'
          ? incoming.createdAt
          : new Date(incoming.createdAt as unknown as number).toISOString(),
      isRead: incoming.isRead ?? false,
      actor: incoming.actor ?? null,
    };
    addNotification(notification);
    notificationHandlers.current.forEach((handler) => {
      try {
        handler(notification);
      } catch (error) {
        console.error('[UnifiedNotification] Handler error:', error);
      }
    });
    const handlers = categoryHandlers.current.get(notification.category);
    handlers?.forEach((handler) => {
      try {
        handler(notification);
      } catch (error) {
        console.error('[UnifiedNotification] Category handler error:', error);
      }
    });
  });

  // When ANY admin in the workspace resolves an access request, the server
  // publishes a workspace-scoped `access_request:resolved` event. Other admins
  // patch the matching notification's data so its row swaps from buttons →
  // status pill without needing a refresh.
  useTopic<{ accessRequestId: string; status: 'approved' | 'denied'; resolvedBy: string }>(
    'access_request',
    (event) => {
      if (event.event !== 'resolved') return;
      const data = event.data;
      if (!data?.accessRequestId) return;
      patchNotificationsByEntity('access_request', data.accessRequestId, {
        resolvedStatus: data.status,
        resolvedBy: data.resolvedBy,
      });
    },
  );

  // Cursor for keyset pagination (app-api). null = no more pages.
  const cursorRef = useRef<string | null>(null);

  // Load notifications from server (app-api, cursor-paginated)
  const loadNotificationsFromServer = async (append = false) => {
    try {
      setLoading(true);

      const result = await notificationsApi.list({
        limit: 50,
        ...(append && cursorRef.current ? { cursor: cursorRef.current } : {}),
      });

      const mapped: UnifiedNotification[] = result.data.map((n) => ({
        id: n.id,
        notificationType: n.notificationType,
        category: n.category ?? 'system',
        title: n.title ?? '',
        body: n.body || '',
        entityType: n.entityType ?? undefined,
        entityId: n.entityId ?? undefined,
        actionUrl: n.actionUrl ?? undefined,
        data: n.data ?? undefined,
        createdAt: n.createdAt,
        isRead: n.isRead ?? false,
        // app-api hydrates the actor as flat columns (actorName/actorAvatar)
        // instead of core-api's nested `actor` object — rebuild the shape the
        // notification UI expects.
        actor: n.actorType
          ? {
              type: n.actorType as NotificationActor['type'],
              id: n.actorId,
              name: n.actorName ?? '',
              imageUrl: n.actorAvatar,
            }
          : null,
      }));

      if (append) {
        appendNotifications(mapped);
      } else {
        setNotifications(mapped);
      }

      cursorRef.current = result.pagination.cursor;
      setHasMore(result.pagination.hasMore);

      if (!append) {
        try {
          const countResult = await notificationsApi.unreadCount();
          setUnreadCount(countResult.data.count);
        } catch (e) {
          console.error('[UnifiedNotification] Failed to load unread count:', e);
        }
      }
    } catch (error) {
      console.error('[UnifiedNotification] Failed to load notifications:', error);
    } finally {
      setLoading(false);
    }
  };

  // Subscribe to notifications
  const subscribe = useCallback((handler: (notification: UnifiedNotification) => void) => {
    notificationHandlers.current.add(handler);
    return () => {
      notificationHandlers.current.delete(handler);
    };
  }, []);

  // Subscribe to category
  const subscribeToCategory = useCallback(
    (category: string, handler: (notification: UnifiedNotification) => void) => {
      if (!categoryHandlers.current.has(category)) {
        categoryHandlers.current.set(category, new Set());
      }
      categoryHandlers.current.get(category)!.add(handler);
      return () => {
        categoryHandlers.current.get(category)?.delete(handler);
      };
    },
    []
  );

  // Email account subscriptions (no-op for now - can be implemented via user channel)
  const subscribeToEmailAccount = useCallback(async (accountId: string) => {
    // Email account subscriptions are handled via the user channel
    // The @weldsuite/realtime client already subscribes to the user channel
  }, []);

  const unsubscribeFromEmailAccount = useCallback(async (accountId: string) => {
    // Email account unsubscriptions are handled via the user channel
  }, []);

  // Mark as read
  const markAsRead = useCallback(async (notificationId: string) => {
    storeMarkAsRead(notificationId);
    try {
      await notificationsApi.markRead(notificationId);
    } catch (error) {
      console.error('[UnifiedNotification] Failed to mark as read:', error);
    }
  }, [storeMarkAsRead, notificationsApi]);

  // Mark all as read
  const markAllAsRead = useCallback(async () => {
    storeMarkAllAsRead();
    try {
      await notificationsApi.markAllRead();
    } catch (error) {
      console.error('[UnifiedNotification] Failed to mark all as read:', error);
    }
  }, [storeMarkAllAsRead, notificationsApi]);

  // Delete notification
  const deleteNotification = useCallback(async (notificationId: string) => {
    storeDeleteNotification(notificationId);
    try {
      await notificationsApi.delete(notificationId);
    } catch (error) {
      console.error('[UnifiedNotification] Failed to delete notification:', error);
    }
  }, [storeDeleteNotification, notificationsApi]);

  // Load more notifications (cursor-paginated)
  const loadMore = useCallback(async () => {
    if (!organization?.id || !user?.id || isLoading || !hasMore) return;
    await loadNotificationsFromServer(true);
  }, [organization?.id, user?.id, isLoading, hasMore]);

  // Refresh notifications
  const refresh = useCallback(async () => {
    if (!organization?.id || !user?.id) return;
    cursorRef.current = null;
    await loadNotificationsFromServer(false);
  }, [organization?.id, user?.id]);

  const value: UnifiedNotificationContextValue = {
    status,
    isConnected: status === 'connected',
    notifications,
    unreadCount,
    isLoading,
    hasMore,
    subscribe,
    subscribeToCategory,
    subscribeToEmailAccount,
    unsubscribeFromEmailAccount,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    loadMore,
    refresh,
    clearNotifications,
  };

  return (
    <UnifiedNotificationContext.Provider value={value}>
      {children}
    </UnifiedNotificationContext.Provider>
  );
}

/**
 * Hook to access unified notification context
 */
export function useUnifiedNotifications() {
  const context = useContext(UnifiedNotificationContext);
  if (!context) {
    throw new Error(
      'useUnifiedNotifications must be used within a UnifiedNotificationProvider'
    );
  }
  return context;
}

/**
 * Hook to get unread notification count
 */
function useUnreadCount() {
  return useNotificationStore((state) => state.unreadCount);
}
