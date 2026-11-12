import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, useRef } from 'react';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { useAuthSession } from '@weldsuite/mobile-ui/contexts/AuthContext';
import { onLeaveServer } from '@weldsuite/mobile-platform/runtime';
import { isNotificationForThisServer, isPushAvailable } from '@weldsuite/mobile-platform/edition';
import { useRouter } from 'expo-router';

const EAS_PROJECT_ID =
  Constants.expoConfig?.extra?.eas?.projectId || process.env.EXPO_PUBLIC_EAS_PROJECT_ID || '';
const APP_CODE = 'welddesk';

// Push notifications are not supported in Expo Go (SDK 53+).
// Only import when running in a dev build or standalone app.
const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
let Notifications: typeof import('expo-notifications') | null = null;
let notifUtils: {
  registerForPushNotificationsAsync: (id: string) => Promise<string | null>;
  registerDeviceToken: (token: string, accessToken: string, orgId: string, appCode: string) => Promise<unknown>;
  unregisterDeviceToken: (accessToken: string, apiBaseUrl?: string) => Promise<boolean>;
  setupNotificationListeners: (onReceive: (n: any) => void, onTap: (r: any) => void) => () => void;
  setBadgeCount: (count: number) => Promise<void>;
  createNotificationChannels: (channels: { id: string; name: string; description: string }[]) => Promise<void>;
} | null = null;

if (!isExpoGo) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native module is absent in Expo Go; probed synchronously inside try/catch
    Notifications = require('expo-notifications');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native module is absent in Expo Go; probed synchronously inside try/catch
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
  const { user, getCredentials, organizationId } = useAuthSession();
  const router = useRouter();
  const [unreadCount, setUnreadCount] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [isPermissionGranted, setIsPermissionGranted] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Leaving this server (switching to another): stop it pushing to this device.
  useEffect(
    () =>
      onLeaveServer('push-token', async (runtime) => {
        if (!runtime.pushEnabled || !notifUtils) return;
        const credentials = await getCredentials();
        if (credentials?.accessToken) await notifUtils.unregisterDeviceToken(credentials.accessToken, runtime.apiOrigin);
      }),
    [getCredentials],
  );

  const requestPermissions = useCallback(async (): Promise<boolean> => {
    // Push reaches the apps on WeldSuite cloud only, until the content-free relay.
    if (!notifUtils || !EAS_PROJECT_ID || !isPushAvailable()) return false;
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

  const contextValue = useMemo(
    () => ({ unreadCount, isConnected, isPermissionGranted, requestPermissions, openNotificationSettings, refreshBadgeCount }),
    [unreadCount, isConnected, isPermissionGranted, requestPermissions, openNotificationSettings, refreshBadgeCount],
  );

  useEffect(() => {
    if (!user || !organizationId) {
      if (!user && cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null; }
      return;
    }

    const init = async () => {
      if (!Notifications || !notifUtils || !isPushAvailable()) {
        // Expo Go or notifications not available — skip
        setIsConnected(false);
        return;
      }

      try {
        await notifUtils.createNotificationChannels([
          { id: 'helpdesk', name: 'Helpdesk Notifications', description: 'New conversations and messages' },
        ]);

        // Request permission whenever the OS will still show the prompt. Gate on
        // `canAskAgain`, not `status === 'undetermined'`: on Android 13+
        // expo-notifications reports 'denied' until POST_NOTIFICATIONS is granted
        // (it checks areNotificationsEnabled()), so an undetermined check never
        // prompted there and those devices never got a push token.
        if (EAS_PROJECT_ID) {
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

        const cleanup = notifUtils.setupNotificationListeners(
          (notification: any) => {
            const data = notification.request.content.data;
            if (data?.unreadCount !== undefined) { setUnreadCount(data.unreadCount); void notifUtils!.setBadgeCount(data.unreadCount); }
          },
          (response: any) => {
            const data = response.notification.request.content.data;
            // A notification left over from another server points at records this one doesn't have.
            if (!isNotificationForThisServer(data)) return;
            if (data?.conversationId) {
              router.push(`/conversation/${data.conversationId}` as never);
            }
          }
        );
        cleanupRef.current = cleanup;
        setIsConnected(true);
      } catch (error) {
        console.error('Error initializing notifications:', error);
      }
    };

    void init();
    return () => { if (cleanupRef.current) cleanupRef.current(); };
  }, [user, organizationId, getCredentials]);

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
    </NotificationContext.Provider>
  );
}
