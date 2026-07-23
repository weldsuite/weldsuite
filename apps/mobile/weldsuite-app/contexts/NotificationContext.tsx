import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';
import { useClerkAuth } from './ClerkAuthContext';
import { useRouter } from 'expo-router';
import {
  registerForPushNotificationsAsync,
  registerDeviceToken,
  setupNotificationListeners,
  setBadgeCount,
} from '@/services/notifications';

interface NotificationContextType {
  unreadCount: number;
  isConnected: boolean;
  isPermissionGranted: boolean;
  requestPermissions: () => Promise<boolean>;
  openNotificationSettings: () => Promise<void>;
  refreshBadgeCount: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType>({
  unreadCount: 0,
  isConnected: false,
  isPermissionGranted: false,
  requestPermissions: async () => false,
  openNotificationSettings: async () => {},
  refreshBadgeCount: async () => {},
});

export const useNotifications = () => useContext(NotificationContext);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user, getCredentials, organizationId } = useClerkAuth();
  const router = useRouter();
  const [unreadCount, setUnreadCount] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [isPermissionGranted, setIsPermissionGranted] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Request notification permissions
  const requestPermissions = async (): Promise<boolean> => {
    try {
      // First check current permission status
      const { status: existingStatus } = await Notifications.getPermissionsAsync();

      if (existingStatus === 'denied') {
        // Permissions were previously denied - can't show prompt again
        return false;
      }

      const token = await registerForPushNotificationsAsync();

      if (token) {
        setIsPermissionGranted(true);

        // Register token with backend (include organizationId)
        const credentials = await getCredentials();

        if (credentials?.accessToken && credentials?.organizationId) {
          await registerDeviceToken(token, credentials.accessToken, credentials.organizationId);
        }
        return true;
      }

      // No token - check if permissions are granted but no token (e.g., Expo Go)
      const { status } = await Notifications.getPermissionsAsync();
      if (status === 'granted') {
        setIsPermissionGranted(true);
        return true;
      }

      return false;
    } catch (error) {
      console.error('[Notifications] Error requesting permissions:', error);
      return false;
    }
  };

  // Open device notification settings
  const openNotificationSettings = async () => {
    if (Platform.OS === 'ios') {
      await Linking.openURL('app-settings:');
    } else {
      await Linking.openSettings();
    }
  };

  // Refresh badge count
  const refreshBadgeCount = async () => {
    // Badge count is updated via push notification data
  };

  // Initialize push notifications when user is authenticated and org is available
  useEffect(() => {
    console.log('[NotifContext] useEffect fired — user:', !!user, '| organizationId:', organizationId);

    if (!user || !organizationId) {
      if (!user) {
        console.log('[NotifContext] No user — cleaning up');
        // Clean up on logout
        if (cleanupRef.current) {
          cleanupRef.current();
          cleanupRef.current = null;
        }
        setIsConnected(false);
        setUnreadCount(0);
      } else {
        console.log('[NotifContext] User exists but no organizationId — waiting...');
      }
      return;
    }

    const initializeNotifications = async () => {
      try {
        // Check permission status
        const { status } = await Notifications.getPermissionsAsync();
        let hasPermission = status === 'granted';
        console.log('[NotifContext] Permission status:', status);

        // Request permissions on startup if not yet granted or determined
        if (status === 'undetermined') {
          console.log('[NotifContext] Status undetermined — requesting push token...');
          const token = await registerForPushNotificationsAsync();
          hasPermission = !!token;

          if (token) {
            const credentials = await getCredentials();
            console.log('[NotifContext] Credentials — accessToken:', !!credentials?.accessToken, '| orgId:', credentials?.organizationId);
            if (credentials?.accessToken && credentials?.organizationId) {
              await registerDeviceToken(token, credentials.accessToken, credentials.organizationId);
            } else {
              console.warn('[NotifContext] Missing accessToken or organizationId in credentials — skipping registration');
            }
          } else {
            console.log('[NotifContext] No push token returned');
          }
        } else if (hasPermission) {
          // Permissions already granted, register the device token
          console.log('[NotifContext] Permission granted — registering device token...');
          try {
            const token = await registerForPushNotificationsAsync();
            if (token) {
              const credentials = await getCredentials();
              console.log('[NotifContext] Credentials — accessToken:', !!credentials?.accessToken, '| orgId:', credentials?.organizationId);
              if (credentials?.accessToken && credentials?.organizationId) {
                await registerDeviceToken(token, credentials.accessToken, credentials.organizationId);
              } else {
                console.warn('[NotifContext] Missing accessToken or organizationId in credentials — skipping registration');
              }
            } else {
              console.log('[NotifContext] No push token returned (permission granted but no token)');
            }
          } catch (tokenError) {
            console.error('[NotifContext] Error auto-registering device token:', tokenError);
          }
        } else {
          console.log('[NotifContext] Permission denied — not registering');
        }

        setIsPermissionGranted(hasPermission);

        // Setup notification listeners
        const cleanup = setupNotificationListeners(
          // On notification received (foreground)
          (notification) => {
            const data = notification.request.content.data;

            // Update badge count if provided
            if (data?.unreadCount !== undefined) {
              setUnreadCount(data.unreadCount);
              setBadgeCount(data.unreadCount);
            }
          },
          // On notification tapped
          (response) => {
            const data = response.notification.request.content.data;
            console.log('[NotifContext] Notification tapped, data:', JSON.stringify(data));

            // Navigate based on notification type
            if (data?.type === 'helpdesk' && data?.conversationId) {
              // Helpdesk notifications - navigate to conversation/ticket
              router.push(`/helpdesk/ticket/${data.conversationId}`);
            } else if (data?.type === 'new_email' && data?.emailId) {
              router.push(`/mail/${data.emailId}`);
            } else if (data?.emailAccountId) {
              router.push('/mail');
            }
          }
        );

        cleanupRef.current = cleanup;
        setIsConnected(true);

        // Handle cold start: check if app was launched by tapping a notification
        const lastResponse = await Notifications.getLastNotificationResponseAsync();
        if (lastResponse) {
          const data = lastResponse.notification.request.content.data;
          console.log('[NotifContext] Cold start notification data:', JSON.stringify(data));
          if (data?.type === 'helpdesk' && data?.conversationId) {
            router.push(`/helpdesk/ticket/${data.conversationId}`);
          } else if (data?.type === 'new_email' && data?.emailId) {
            router.push(`/mail/${data.emailId}`);
          } else if (data?.emailAccountId) {
            router.push('/mail');
          }
        }
      } catch (error) {
        console.error('Error initializing notifications:', error);
      }
    };

    initializeNotifications();

    // Cleanup on unmount
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
      }
    };
  }, [user, organizationId, getCredentials]);

  return (
    <NotificationContext.Provider
      value={{
        unreadCount,
        isConnected,
        isPermissionGranted,
        requestPermissions,
        openNotificationSettings,
        refreshBadgeCount,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}
