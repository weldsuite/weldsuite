import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import * as Linking from 'expo-linking';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useRouter } from 'expo-router';
import { appApi } from '@/services/app-api';

/**
 * Extract the chat channel id from a notification `actionUrl`. The backend
 * emits `/weldchat/dm/${channelId}` and `/weldchat/${channelId}?messageId=…`.
 */
function channelIdFromActionUrl(actionUrl: unknown): string | null {
  if (typeof actionUrl !== 'string') return null;
  const match = actionUrl.match(/\/weldchat\/(?:dm\/)?([^/?#]+)/);
  return match?.[1] ?? null;
}

async function getDeviceId(): Promise<string> {
  if (Platform.OS === 'android') {
    return Application.getAndroidId() || `android_${Date.now()}`;
  } else if (Platform.OS === 'ios') {
    const installTime = await Application.getInstallationTimeAsync();
    return `ios_${installTime?.getTime() || Date.now()}`;
  }
  return `device_${Date.now()}`;
}

/** Register the Expo push token with app-api's push-tokens endpoint. */
async function registerPushToken(token: string): Promise<void> {
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
}

const EAS_PROJECT_ID = Constants.expoConfig?.extra?.eas?.projectId || '';
const APP_CODE = 'weldchat';

// Push notifications are not supported in Expo Go (SDK 53+).
// Only import when running in a dev build or standalone app.
const isExpoGo = Constants.appOwnership === 'expo';
let Notifications: typeof import('expo-notifications') | null = null;
let notifUtils: {
  registerForPushNotificationsAsync: (id: string) => Promise<string | undefined>;
  setupNotificationListeners: (onReceive: (n: any) => void, onTap: (r: any) => void) => () => void;
  setBadgeCount: (count: number) => Promise<void>;
  createNotificationChannels: (channels: Array<{ id: string; name: string; description?: string }>) => Promise<void>;
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
}

const NotificationContext = createContext<NotificationContextType>({
  unreadCount: 0,
  isConnected: false,
  isPermissionGranted: false,
  requestPermissions: async () => false,
  openNotificationSettings: async () => {},
});

export const useNotifications = () => useContext(NotificationContext);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user, organizationId } = useClerkAuth();
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
        // Expo Go or notifications not available — skip silently
        setIsConnected(false);
        return;
      }

      try {
        await notifUtils.createNotificationChannels([
          { id: 'chat', name: 'Chat Messages', description: 'New messages and mentions' },
          { id: 'incoming_call', name: 'Incoming Calls', description: 'Ringing for incoming voice and video calls' },
        ]);

        if (EAS_PROJECT_ID) {
          // Only register when permission is ALREADY granted. We must not call
          // registerForPushNotificationsAsync on 'undetermined' — that triggers
          // the OS permission prompt on every cold start. The deliberate prompt
          // lives in requestPermissions(), invoked from a user action.
          const { status } = await Notifications.getPermissionsAsync();
          if (status === 'granted') {
            const token = await notifUtils.registerForPushNotificationsAsync(EAS_PROJECT_ID);
            if (token) {
              setIsPermissionGranted(true);
              await registerPushToken(token);
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
            const data = response.notification.request.content.data ?? {};
            const notificationType: string | undefined = data.notificationType;

            // Incoming call → open the call room and join by callId (entityId).
            // This is the background / locked-screen path; foregrounded calls
            // ring via the realtime `call_incoming` event + IncomingCallModal.
            if (notificationType === 'chat_incoming_call' && data.entityId) {
              // Push payloads are not signed end-to-end — only navigate when the
              // callId looks like a real id, never a smuggled path/query.
              const callId = typeof data.entityId === 'string' ? data.entityId : '';
              if (/^[A-Za-z0-9_-]+$/.test(callId)) {
                router.push(`/call-room?callId=${encodeURIComponent(callId)}` as any);
              }
              return;
            }

            // Missed call → open the conversation so the user can call back.
            if (notificationType === 'chat_missed_call') {
              const channelId = channelIdFromActionUrl(data.actionUrl);
              if (channelId) router.push(`/dm/${channelId}` as any);
              return;
            }

            // Generic chat notification → open the channel/DM.
            const channelId = data.channelId ?? channelIdFromActionUrl(data.actionUrl);
            if (channelId) {
              const path = typeof data.actionUrl === 'string' && data.actionUrl.includes('/dm/')
                ? `/dm/${channelId}`
                : `/channel/${channelId}`;
              router.push(path as any);
            }
          },
        );
        cleanupRef.current = cleanup;
        setIsConnected(true);
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
  }, [user, organizationId]);

  return (
    <NotificationContext.Provider
      value={{ unreadCount, isConnected, isPermissionGranted, requestPermissions, openNotificationSettings }}
    >
      {children}
    </NotificationContext.Provider>
  );
}
