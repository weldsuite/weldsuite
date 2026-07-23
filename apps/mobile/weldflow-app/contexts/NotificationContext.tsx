import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useRouter } from 'expo-router';

const EAS_PROJECT_ID = process.env.EXPO_PUBLIC_EAS_PROJECT_ID || '';
const APP_CODE = 'weldflow';

const isExpoGo = Constants.appOwnership === 'expo';
let Notifications: typeof import('expo-notifications') | null = null;
let notifUtils: {
  registerForPushNotificationsAsync: (id: string) => Promise<string | null>;
  registerDeviceToken: (token: string, accessToken: string, orgId: string, appCode: string) => Promise<void>;
  setupNotificationListeners: (
    onReceive: (n: unknown) => void,
    onTap: (r: unknown) => void,
  ) => () => void;
  setBadgeCount: (count: number) => Promise<void>;
  createNotificationChannels: (channels: Array<{ id: string; name: string; description: string }>) => Promise<void>;
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

  const requestPermissions = async (): Promise<boolean> => {
    if (!notifUtils || !EAS_PROJECT_ID) return false;
    try {
      const token = await notifUtils.registerForPushNotificationsAsync(EAS_PROJECT_ID);
      if (token) {
        setIsPermissionGranted(true);
        const credentials = await getCredentials();
        if (credentials?.accessToken && credentials?.organizationId) {
          await notifUtils.registerDeviceToken(
            token,
            credentials.accessToken,
            credentials.organizationId,
            APP_CODE,
          );
        }
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

  const refreshBadgeCount = async () => {};

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
          { id: 'weldflow', name: 'WeldFlow Notifications', description: 'Task assignments and updates' },
        ]);

        if (EAS_PROJECT_ID) {
          const { status } = await Notifications.getPermissionsAsync();
          if (status === 'granted' || status === 'undetermined') {
            const token = await notifUtils.registerForPushNotificationsAsync(EAS_PROJECT_ID);
            if (token) {
              setIsPermissionGranted(true);
              const credentials = await getCredentials();
              if (credentials?.accessToken && credentials?.organizationId) {
                await notifUtils.registerDeviceToken(
                  token,
                  credentials.accessToken,
                  credentials.organizationId,
                  APP_CODE,
                );
              }
            }
          }
        }

        const cleanup = notifUtils.setupNotificationListeners(
          (notification: any) => {
            const data = notification.request.content.data;
            if (data?.unreadCount !== undefined) {
              setUnreadCount(data.unreadCount);
              notifUtils!.setBadgeCount(data.unreadCount);
            }
          },
          (response: any) => {
            const data = response.notification.request.content.data;
            if (data?.taskId && data?.projectId) {
              router.push(`/task/${data.projectId}/${data.taskId}`);
            } else if (data?.projectId) {
              router.push(`/project/${data.projectId}`);
            }
          },
        );
        cleanupRef.current = cleanup;
        setIsConnected(true);
      } catch (error) {
        console.error('Error initializing notifications:', error);
      }
    };

    init();
    return () => {
      if (cleanupRef.current) cleanupRef.current();
    };
  }, [user, organizationId, getCredentials, router]);

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
