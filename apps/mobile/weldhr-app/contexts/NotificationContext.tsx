import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, useRef } from 'react';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useRouter, type Href } from 'expo-router';
import { notificationTarget } from '@/lib/notification-route';

const EAS_PROJECT_ID =
  Constants.expoConfig?.extra?.eas?.projectId || process.env.EXPO_PUBLIC_EAS_PROJECT_ID || '';
const APP_CODE = 'weldhr';

/**
 * Absent or still-placeholder EAS project ids. Treating those as "absent"
 * keeps a fresh clone from firing doomed token requests at Expo's push service
 * on every cold start (each one an error banner in a dev build).
 */
const PLACEHOLDER_PROJECT_ID = '00000000-0000-0000-0000-000000000000';
const hasProjectId = !!EAS_PROJECT_ID && EAS_PROJECT_ID !== PLACEHOLDER_PROJECT_ID;

// Push notifications are not supported in Expo Go (SDK 53+).
// Only import when running in a dev build or standalone app.
const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
let Notifications: typeof import('expo-notifications') | null = null;
let notifUtils: {
  registerForPushNotificationsAsync: (id: string) => Promise<string | null>;
  registerDeviceToken: (token: string, accessToken: string, orgId: string, appCode: string) => Promise<void>;
  setupNotificationListeners: (onReceive: (n: any) => void, onTap: (r: any) => void) => () => void;
  setBadgeCount: (count: number) => Promise<void>;
  createNotificationChannels: (channels: Array<{ id: string; name: string; description: string }>) => Promise<void>;
  addPushTokenRefreshListener: (onTokenChange: (deviceToken: string) => void) => () => void;
} | null = null;

if (!isExpoGo) {
  try {
    Notifications = require('expo-notifications');
    notifUtils = require('@weldsuite/mobile-ui/services/notifications');
  } catch {
    // Not available
  }
}

interface NotificationContextType {
  unreadCount: number;
  isConnected: boolean;
  isPermissionGranted: boolean;
  requestPermissions: () => Promise<boolean>;
  openNotificationSettings: () => Promise<void>;
  refreshBadgeCount: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType>({
  unreadCount: 0, isConnected: false, isPermissionGranted: false,
  requestPermissions: () => Promise.resolve(false), openNotificationSettings: async () => {},
  refreshBadgeCount: async () => {},
});

export const useNotifications = () => useContext(NotificationContext);

export function NotificationProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const { user, getCredentials, organizationId } = useClerkAuth();
  const router = useRouter();
  const [unreadCount, setUnreadCount] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [isPermissionGranted, setIsPermissionGranted] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  // Notifications already followed, so the one that launched the app is not followed again when this re-runs.
  const followed = useRef(new Set<string>());

  const requestPermissions = useCallback(async (): Promise<boolean> => {
    if (!notifUtils || !hasProjectId) return false;
    try {
      const token = await notifUtils.registerForPushNotificationsAsync(EAS_PROJECT_ID);
      if (token) {
        setIsPermissionGranted(true);
        const credentials = await getCredentials();
        if (credentials?.accessToken && credentials?.organizationId) {
          await notifUtils.registerDeviceToken(token, credentials.accessToken, credentials.organizationId, APP_CODE);
        }
        return true;
      }
      return false;
    } catch (error) {
      console.error('[Notifications] Error:', error);
      return false;
    }
  }, [getCredentials]);

  const openNotificationSettings = useCallback(async () => {
    if (Platform.OS === 'ios') await Linking.openURL('app-settings:');
    else await Linking.openSettings();
  }, []);

  const refreshBadgeCount = useCallback(async () => {}, []);

  const value = useMemo(
    () => ({ unreadCount, isConnected, isPermissionGranted, requestPermissions, openNotificationSettings, refreshBadgeCount }),
    [unreadCount, isConnected, isPermissionGranted, requestPermissions, openNotificationSettings, refreshBadgeCount],
  );

  useEffect(() => {
    if (!user || !organizationId) {
      if (!user && cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null; }
      return;
    }

    const init = async () => {
      if (!Notifications || !notifUtils) {
        setIsConnected(false);
        return;
      }

      try {
        await notifUtils.createNotificationChannels([
          { id: 'default', name: 'WeldHR Notifications', description: 'General notifications' },
        ]);

        // Request permission whenever the OS will still show the prompt. Gate on
        // `canAskAgain`, not `status === 'undetermined'`: on Android 13+
        // expo-notifications reports 'denied' until POST_NOTIFICATIONS is granted
        // (it checks areNotificationsEnabled()), so an undetermined check never
        // prompted there and those devices never got a push token.
        if (hasProjectId) {
          const { status, canAskAgain } = await Notifications.getPermissionsAsync();
          if (status === 'granted' || canAskAgain) {
            const token = await notifUtils.registerForPushNotificationsAsync(EAS_PROJECT_ID);
            if (token) {
              setIsPermissionGranted(true);
              const credentials = await getCredentials();
              if (credentials?.accessToken && credentials?.organizationId) {
                await notifUtils.registerDeviceToken(token, credentials.accessToken, credentials.organizationId, APP_CODE);
              }
            }
          }
        }

        // Announcements open their page; anything else with a `route` goes there; the rest stays on Home.
        const follow = (response: any) => {
          const id: string | undefined = response?.notification?.request?.identifier;
          if (id) {
            if (followed.current.has(id)) return;
            followed.current.add(id);
          }
          const target = notificationTarget(response?.notification?.request?.content?.data);
          if (target) router.push(target as Href);
        };

        const cleanup = notifUtils.setupNotificationListeners(
          (notification: any) => {
            const data = notification.request.content.data;
            if (data?.unreadCount !== undefined) { setUnreadCount(data.unreadCount); void notifUtils!.setBadgeCount(data.unreadCount); }
          },
          (response: any) => follow(response),
        );

        // A tap that launched the app arrives before this listener exists.
        const launched = await Notifications.getLastNotificationResponseAsync();
        if (launched) follow(launched);

        // Re-register when the device token rotates so pushes don't silently
        // stop between cold starts.
        const removeTokenRefresh = notifUtils.addPushTokenRefreshListener(() => {
          if (!hasProjectId) return;
          notifUtils!
            .registerForPushNotificationsAsync(EAS_PROJECT_ID)
            .then(async (refreshed) => {
              if (!refreshed) return;
              const credentials = await getCredentials();
              if (credentials?.accessToken && credentials?.organizationId) {
                await notifUtils!.registerDeviceToken(refreshed, credentials.accessToken, credentials.organizationId, APP_CODE);
              }
            })
            .catch(() => {});
        });

        cleanupRef.current = () => { cleanup(); removeTokenRefresh(); };
        setIsConnected(true);
      } catch (error) {
        console.error('Error initializing notifications:', error);
      }
    };

    void init();
    return () => { if (cleanupRef.current) cleanupRef.current(); };
  }, [user, organizationId, getCredentials]);

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}
