import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import * as Linking from 'expo-linking';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useRouter } from 'expo-router';
import { appApi } from '@/services/app-api';
import {
  incomingCallPayloadFromNotificationData,
  presentIncomingCallFromPush,
} from '@/lib/incoming-call-bridge';

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
async function registerPushToken(token: string): Promise<boolean> {
  const deviceId = await getDeviceId();
  const isExpoToken = token.startsWith('ExponentPushToken[');
  const tokenType = isExpoToken ? 'expo' : Platform.OS === 'android' ? 'fcm' : 'apns';
  const body = {
    token,
    platform: Platform.OS as 'ios' | 'android',
    deviceId,
    appCode: APP_CODE,
    tokenType: tokenType as 'expo' | 'fcm' | 'apns',
    deviceModel: Device.modelName || undefined,
    osVersion: Device.osVersion || undefined,
    appVersion: Application.nativeApplicationVersion || undefined,
  };

  // Org JWT can lag briefly after sign-in / workspace switch — retry a few times
  // so a transient ORG_REQUIRED does not leave the device permanently unregistered.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await appApi.pushTokens.register(body);
      return true;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  console.error('[Notifications] Failed to register push token:', lastError);
  return false;
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
  createNotificationChannels: (channels: { id: string; name: string; description?: string; importance?: number; sound?: string }[]) => Promise<void>;
  addPushTokenRefreshListener: (cb: (token: string) => void) => () => void;
  dismissAllPresentedNotifications: () => Promise<void>;
} | null = null;

if (!isExpoGo) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native module is absent in Expo Go; probed synchronously inside try/catch
    const expoNotifications = require('expo-notifications') as typeof import('expo-notifications');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native module is absent in Expo Go; probed synchronously inside try/catch
    notifUtils = require('@weldsuite/mobile-ui/services/notifications');
    Notifications = expoNotifications;

    // Override the shared mobile-ui silent foreground handler so chat banners
    // remain visible when the app is open but the user is in another channel.
    expoNotifications.setNotificationHandler({
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
  unregisterDevice: () => Promise<void>;
  prepareWorkspaceSwitch: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType>({
  unreadCount: 0,
  isConnected: false,
  isPermissionGranted: false,
  requestPermissions: async () => false,
  openNotificationSettings: async () => {},
  unregisterDevice: async () => {},
  prepareWorkspaceSwitch: async () => {},
});

export const useNotifications = () => useContext(NotificationContext);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user, organizationId } = useClerkAuth();
  const router = useRouter();
  const [unreadCount, setUnreadCount] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [isPermissionGranted, setIsPermissionGranted] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const navigateFromNotificationData = useCallback(
    (data: Record<string, unknown>) => {
      const notificationType: string | undefined =
        typeof data.notificationType === 'string' ? data.notificationType : undefined;

      // Present Accept/Decline (IncomingCallModal) instead of silently
      // auto-joining — the user needs to see that someone is calling.
      const incoming = incomingCallPayloadFromNotificationData(data);
      if (incoming) {
        presentIncomingCallFromPush(incoming);
        return;
      }

      if (notificationType === 'chat_missed_call') {
        const channelId = channelIdFromActionUrl(data.actionUrl);
        if (channelId) router.push(`/dm/${channelId}` as never);
        return;
      }

      const channelId =
        (typeof data.channelId === 'string' ? data.channelId : null) ??
        channelIdFromActionUrl(data.actionUrl);
      if (channelId) {
        const path =
          typeof data.actionUrl === 'string' && data.actionUrl.includes('/dm/')
            ? `/dm/${channelId}`
            : `/channel/${channelId}`;
        router.push(path as never);
      }
    },
    [router],
  );

  const requestPermissions = async (): Promise<boolean> => {
    if (!notifUtils || !EAS_PROJECT_ID) return false;
    try {
      const token = await notifUtils.registerForPushNotificationsAsync(EAS_PROJECT_ID);
      if (token) {
        const registered = await registerPushToken(token);
        setIsPermissionGranted(registered);
        return registered;
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
    setIsPermissionGranted(false);
    setIsConnected(false);
  }, []);

  // Deactivate the workspace-scoped token while the JWT still points at the
  // leaving org; NotificationProvider re-registers after organizationId changes.
  const prepareWorkspaceSwitch = useCallback(async () => {
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
          { id: 'chat', name: 'Chat Messages', description: 'New messages and mentions' },
          {
            id: 'incoming_call',
            name: 'Incoming Calls',
            description: 'Ringing for incoming voice and video calls',
            importance: Notifications.AndroidImportance?.MAX,
          },
        ]);

        // Request permission on first launch (undetermined) — previously we only
        // registered when already granted, so most users never got a push token
        // and DM/call notifications silently never arrived.
        if (EAS_PROJECT_ID) {
          const { status } = await Notifications.getPermissionsAsync();
          if (status === 'granted' || status === 'undetermined') {
            const token = await notifUtils.registerForPushNotificationsAsync(EAS_PROJECT_ID);
            if (token) {
              const registered = await registerPushToken(token);
              setIsPermissionGranted(registered);
            } else {
              // Common on Android when the native binary was built without
              // google-services.json / the Google Services Gradle plugin.
              console.warn(
                '[Notifications] No Expo push token — on Android this usually means the build lacks FCM (google-services.json).',
              );
              setIsPermissionGranted(status === 'granted');
            }
          } else {
            setIsPermissionGranted(false);
          }
        }

        const cleanupListeners = notifUtils.setupNotificationListeners(
          (notification: { request: { content: { data?: Record<string, unknown> } } }) => {
            const data = notification.request.content.data ?? {};
            if (typeof data.unreadCount === 'number') {
              setUnreadCount(data.unreadCount);
              void notifUtils!.setBadgeCount(data.unreadCount);
            }
            // Foreground push: WS may be down after background — still ring.
            const incoming = incomingCallPayloadFromNotificationData(data);
            if (incoming) presentIncomingCallFromPush(incoming);
          },
          (response: { notification: { request: { content: { data?: Record<string, unknown> } } } }) => {
            navigateFromNotificationData(response.notification.request.content.data ?? {});
          },
        );

        // Native FCM/APNs can rotate; re-mint an Expo push token rather than
        // registering the raw device token (Expo push would reject it).
        const cleanupTokenRefresh = notifUtils.addPushTokenRefreshListener(() => {
          if (!EAS_PROJECT_ID) return;
          void notifUtils!
            .registerForPushNotificationsAsync(EAS_PROJECT_ID)
            .then(async (refreshed) => {
              if (!refreshed) return;
              const ok = await registerPushToken(refreshed);
              if (ok) setIsPermissionGranted(true);
            })
            .catch(() => {});
        });

        // Cold start: if the app was launched by tapping a notification, navigate once.
        const last = await Notifications.getLastNotificationResponseAsync();
        if (last?.notification?.request?.content?.data) {
          navigateFromNotificationData(
            (last.notification.request.content.data ?? {}) as Record<string, unknown>,
          );
        }

        cleanupRef.current = () => {
          cleanupListeners();
          cleanupTokenRefresh();
        };
        setIsConnected(true);
      } catch (error) {
        console.error('[Notifications] Error initializing:', error);
      }
    };

    void init();
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, [user, organizationId, navigateFromNotificationData]);

  return (
    <NotificationContext.Provider
      value={{
        unreadCount,
        isConnected,
        isPermissionGranted,
        requestPermissions,
        openNotificationSettings,
        unregisterDevice,
        prepareWorkspaceSwitch,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}
