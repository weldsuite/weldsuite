import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import * as Linking from 'expo-linking';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useRouter } from 'expo-router';
import { appApi } from '@/services/app-api';
import { resolveWeldAgentDeepLink, routeForDeepLink } from '@/utils/deep-links';

async function getDeviceId(): Promise<string> {
  if (Platform.OS === 'android') {
    return Application.getAndroidId() || `android_${Date.now()}`;
  }
  if (Platform.OS === 'ios') {
    const installTime = await Application.getInstallationTimeAsync();
    return `ios_${installTime?.getTime() || Date.now()}`;
  }
  return `device_${Date.now()}`;
}

const EAS_PROJECT_ID =
  Constants.expoConfig?.extra?.eas?.projectId || process.env.EXPO_PUBLIC_EAS_PROJECT_ID || '';
const APP_CODE = 'weldagent';

const isExpoGo = Constants.appOwnership === 'expo';
let Notifications: typeof import('expo-notifications') | null = null;
let notifUtils: {
  registerForPushNotificationsAsync: (id: string) => Promise<string | undefined>;
  setupNotificationListeners: (
    onReceive: (n: unknown) => void,
    onTap: (r: unknown) => void,
  ) => () => void;
  setBadgeCount: (count: number) => Promise<void>;
  createNotificationChannels: (channels: {
    id: string;
    name: string;
    description?: string;
  }[]) => Promise<void>;
  addPushTokenRefreshListener: (onTokenChange: (deviceToken: string) => void) => () => void;
  dismissAllPresentedNotifications: () => Promise<void>;
} | null = null;

if (!isExpoGo) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native module absent in Expo Go
    Notifications = require('expo-notifications');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native module absent in Expo Go
    notifUtils = require('@weldsuite/mobile-ui/services/notifications');
    Notifications?.setNotificationHandler({
      handleNotification: async () => {
        const active = AppState.currentState === 'active';
        return {
          shouldShowAlert: !active,
          shouldShowBanner: !active,
          shouldShowList: true,
          shouldPlaySound: !active,
          shouldSetBadge: true,
        };
      },
    });
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
  unregisterDevice: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType>({
  unreadCount: 0,
  isConnected: false,
  isPermissionGranted: false,
  requestPermissions: async () => false,
  openNotificationSettings: async () => {},
  refreshBadgeCount: async () => {},
  unregisterDevice: async () => {},
});

export const useNotifications = () => useContext(NotificationContext);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user, organizationId } = useClerkAuth();
  const router = useRouter();
  const [unreadCount, setUnreadCount] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [isPermissionGranted, setIsPermissionGranted] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const registerPushToken = useCallback(async (token: string) => {
    const deviceId = await getDeviceId();
    const isExpoToken = token.startsWith('ExponentPushToken[');
    const tokenType = isExpoToken ? 'expo' : Platform.OS === 'android' ? 'fcm' : 'apns';
    try {
      await appApi.pushTokens.register({
        token,
        platform: Platform.OS as 'ios' | 'android',
        deviceId,
        appCode: APP_CODE,
        tokenType: tokenType as 'expo' | 'fcm' | 'apns',
        deviceModel: Device.modelName || undefined,
        osVersion: Device.osVersion || undefined,
        appVersion: Application.nativeApplicationVersion || undefined,
      });
    } catch (err) {
      console.error('[Notifications] Failed to register push token:', err);
    }
  }, []);

  const requestPermissions = async (): Promise<boolean> => {
    if (!notifUtils || !EAS_PROJECT_ID) {
      console.warn('[Notifications] EAS project ID is not configured; skipping push registration');
      return false;
    }
    try {
      const token = await notifUtils.registerForPushNotificationsAsync(EAS_PROJECT_ID);
      if (token) {
        setIsPermissionGranted(true);
        await registerPushToken(token);
        return true;
      }
      return false;
    } catch (error) {
      console.error('[Notifications] Error:', error);
      return false;
    }
  };

  const openNotificationSettings = async () => {
    if (Platform.OS === 'ios') await Linking.openURL('app-settings:');
    else await Linking.openSettings();
  };

  const refreshBadgeCount = useCallback(async () => {
    try {
      const res = await appApi.notifications.unreadCount();
      const count = res.data?.count ?? 0;
      setUnreadCount(count);
      await notifUtils?.setBadgeCount(count);
    } catch {
      // non-fatal
    }
  }, []);

  const unregisterDevice = useCallback(async () => {
    try {
      const deviceId = await getDeviceId();
      await appApi.pushTokens.unregister(deviceId).catch(() => {});
    } catch {
      // best-effort
    }
    await notifUtils?.dismissAllPresentedNotifications();
    await notifUtils?.setBadgeCount(0);
    setUnreadCount(0);
  }, []);

  useEffect(() => {
    if (!user || !organizationId) {
      if (!user && cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      return;
    }

    const init = async () => {
      if (!Notifications || !notifUtils) {
        setIsConnected(false);
        return;
      }

      try {
        await notifUtils.createNotificationChannels([
          {
            id: 'weldagent',
            name: 'WeldAgent',
            description: 'Agent runs and chat replies',
          },
        ]);

        if (EAS_PROJECT_ID) {
          const { status } = await Notifications.getPermissionsAsync();
          if (status === 'granted') {
            const token = await notifUtils.registerForPushNotificationsAsync(EAS_PROJECT_ID);
            if (token) {
              setIsPermissionGranted(true);
              await registerPushToken(token);
            }
          }
        } else {
          console.warn('[Notifications] EAS project ID is not configured; push notifications disabled');
        }

        const cleanup = notifUtils.setupNotificationListeners(
          (notification: unknown) => {
            const data = (notification as { request?: { content?: { data?: Record<string, unknown> } } })
              ?.request?.content?.data;
            if (data?.unreadCount !== undefined) {
              const count = Number(data.unreadCount) || 0;
              setUnreadCount(count);
              notifUtils!.setBadgeCount(count);
            } else {
              setUnreadCount((c) => {
                const next = c + 1;
                notifUtils!.setBadgeCount(next);
                return next;
              });
            }
          },
          (response: unknown) => {
            const data = (
              response as { notification?: { request?: { content?: { data?: Record<string, unknown> } } } }
            )?.notification?.request?.content?.data;
            const target = resolveWeldAgentDeepLink(data);
            if (target) {
              router.push(routeForDeepLink(target) as never);
            }
          },
        );

        const removeTokenRefresh = notifUtils.addPushTokenRefreshListener(() => {
          if (!EAS_PROJECT_ID) return;
          notifUtils!
            .registerForPushNotificationsAsync(EAS_PROJECT_ID)
            .then((refreshed) => {
              if (refreshed) return registerPushToken(refreshed);
            })
            .catch(() => {});
        });

        cleanupRef.current = () => {
          cleanup();
          removeTokenRefresh();
        };
        setIsConnected(true);
        void refreshBadgeCount();
      } catch (error) {
        console.error('[Notifications] Error initializing:', error);
      }
    };

    init();
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, [user, organizationId, registerPushToken, refreshBadgeCount, router]);

  return (
    <NotificationContext.Provider
      value={{
        unreadCount,
        isConnected,
        isPermissionGranted,
        requestPermissions,
        openNotificationSettings,
        refreshBadgeCount,
        unregisterDevice,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}
