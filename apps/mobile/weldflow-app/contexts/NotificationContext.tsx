import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import * as Linking from 'expo-linking';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useRouter } from 'expo-router';
import { appApi } from '@/services/app-api';

/**
 * Parse WeldFlow deep-link targets from an Expo push payload.
 * Prefer explicit `projectId`/`taskId` (sent by the orchestrator); fall back
 * to scraping `/weldflow/project/{id}/…` from `actionUrl`.
 */
function resolveTaskDeepLink(data: Record<string, unknown> | undefined): {
  projectId: string;
  taskId?: string;
} | null {
  if (!data) return null;

  const projectId =
    typeof data.projectId === 'string' && data.projectId
      ? data.projectId
      : typeof data.actionUrl === 'string'
        ? data.actionUrl.match(/\/weldflow\/project\/([^/?#]+)/)?.[1]
        : undefined;

  if (!projectId || !/^[A-Za-z0-9_-]+$/.test(projectId)) return null;

  const taskId =
    typeof data.taskId === 'string' && data.taskId
      ? data.taskId
      : typeof data.entityId === 'string' && data.entityType === 'task'
        ? data.entityId
        : undefined;

  if (taskId && !/^[A-Za-z0-9_-]+$/.test(taskId)) {
    return { projectId };
  }

  return taskId ? { projectId, taskId } : { projectId };
}

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
const APP_CODE = 'weldflow';

// Push notifications are not supported in Expo Go (SDK 53+).
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
    // Show banners while foregrounded — shared handler suppresses them by default.
    Notifications?.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
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
      // non-fatal — badge is best-effort
    }
  }, []);

  const unregisterDevice = useCallback(async () => {
    try {
      const deviceId = await getDeviceId();
      await appApi.pushTokens.unregister(deviceId).catch(() => {});
    } catch {
      // best-effort cleanup
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
            id: 'weldflow',
            name: 'WeldFlow Notifications',
            description: 'Task assignments and updates',
          },
        ]);

        // Only re-register when permission is already granted — never prompt
        // on cold start. The deliberate prompt lives in requestPermissions().
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
          (notification: any) => {
            const data = notification.request.content.data;
            if (data?.unreadCount !== undefined) {
              setUnreadCount(data.unreadCount);
              notifUtils!.setBadgeCount(data.unreadCount);
            } else {
              // Bump local unread when a new push arrives without an explicit count.
              setUnreadCount((c) => {
                const next = c + 1;
                notifUtils!.setBadgeCount(next);
                return next;
              });
            }
          },
          (response: any) => {
            const data = (response.notification.request.content.data ?? {}) as Record<
              string,
              unknown
            >;
            const target = resolveTaskDeepLink(data);
            if (target?.taskId) {
              router.push(`/task/${target.projectId}/${target.taskId}`);
            } else if (target?.projectId) {
              router.push(`/project/${target.projectId}`);
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
