import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import * as Notifications from 'expo-notifications';
import * as Linking from 'expo-linking';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useRouter, useRootNavigationState } from 'expo-router';
import {
  registerForPushNotificationsAsync,
  setupNotificationListeners,
  setBadgeCount,
  createNotificationChannels,
  addPushTokenRefreshListener,
} from '@weldsuite/mobile-ui/services/notifications';
import appApi from '@/services/app-api';

async function getDeviceId(): Promise<string> {
  if (Platform.OS === 'android') {
    return Application.getAndroidId() || `android_${Date.now()}`;
  } else if (Platform.OS === 'ios') {
    const installTime = await Application.getInstallationTimeAsync();
    return `ios_${installTime?.getTime() || Date.now()}`;
  }
  return `device_${Date.now()}`;
}

const EAS_PROJECT_ID = Constants.expoConfig?.extra?.eas?.projectId || '';
const APP_CODE = 'weldmail';
// Persisted id of the last notification response we navigated for. Guards the
// cold-start replay so a *normal* relaunch — which still reports the same
// "last response" — doesn't reopen an old email.
const HANDLED_NOTIF_KEY = '@weldmail_handled_notification_id';

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
  unreadCount: 0, isConnected: false, isPermissionGranted: false,
  requestPermissions: async () => false, openNotificationSettings: async () => {},
  refreshBadgeCount: async () => {}, unregisterDevice: async () => {},
});

/**
 * Canonical accessor for the notification context. Currently unconsumed —
 * the provider drives push registration on its own — but kept as the public
 * API for screens that want to surface unread/connection state.
 * @expected-unused
 */
export const useNotifications = () => useContext(NotificationContext);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user, getCredentials, organizationId } = useClerkAuth();
  const router = useRouter();
  // Defined once the root navigator is mounted — `?.key` is our "safe to
  // navigate" signal. On a cold start the provider's effects run before the
  // Stack mounts, so navigation is queued until this flips ready.
  const rootNavigationState = useRootNavigationState();
  const navReady = !!rootNavigationState?.key;
  const [unreadCount, setUnreadCount] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [isPermissionGranted, setIsPermissionGranted] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  // A notification target held until the router is ready (cold start).
  const [pendingNav, setPendingNav] = useState<{ emailId?: string; inbox?: boolean } | null>(null);
  // Session-local dedupe so a single tap never navigates twice (live listener
  // + cold-start replay can both surface the same response).
  const handledNotifIds = useRef<Set<string>>(new Set());

  // Turn a notification tap into a queued navigation target. Dedupes by the
  // notification identifier — in memory for this session and persisted for the
  // cold-start guard — so the same tap is only ever acted on once.
  const queueNavigationFromResponse = useCallback((response: Notifications.NotificationResponse) => {
    const notifId = response.notification.request.identifier;
    if (notifId) {
      if (handledNotifIds.current.has(notifId)) return;
      handledNotifIds.current.add(notifId);
      AsyncStorage.setItem(HANDLED_NOTIF_KEY, notifId).catch(() => {});
    }
    const data = response.notification.request.content.data;
    const emailId = typeof data?.emailId === 'string' ? data.emailId : '';
    // Only navigate to an id that matches our generateId() shape — never
    // interpolate a raw push payload into the route path (path injection).
    if (emailId && /^[A-Za-z0-9_-]{1,40}$/.test(emailId)) {
      setPendingNav({ emailId });
    } else if (data?.emailAccountId) {
      setPendingNav({ inbox: true });
    }
  }, []);

  // Fire the queued navigation once the root navigator is mounted. This is what
  // makes a cold start (app launched by tapping a push while killed) land
  // directly on the email with the normal slide animation, instead of dropping
  // the navigation because the router wasn't ready yet.
  useEffect(() => {
    if (!navReady || !pendingNav) return;
    if (pendingNav.emailId) {
      router.push({ pathname: '/[id]', params: { id: pendingNav.emailId } });
    } else if (pendingNav.inbox) {
      router.push('/');
    }
    setPendingNav(null);
  }, [navReady, pendingNav, router]);

  // Register this device's push token with the backend. Shared by
  // requestPermissions (awaited) and the init effect (fire-and-forget).
  const registerDeviceToken = async (token: string) => {
    const deviceId = await getDeviceId();
    const isExpoToken = token.startsWith('ExponentPushToken[');
    const tokenType = isExpoToken ? 'expo' : (Platform.OS === 'android' ? 'fcm' : 'apns');
    await appApi.pushTokens
      .register({
        token,
        platform: Platform.OS as 'ios' | 'android',
        deviceId,
        appCode: APP_CODE,
        tokenType: tokenType as 'expo' | 'fcm' | 'apns',
        deviceModel: Device.modelName || undefined,
        osVersion: Device.osVersion || undefined,
        appVersion: Application.nativeApplicationVersion || undefined,
      })
      .catch(() => {});
  };

  const requestPermissions = async (): Promise<boolean> => {
    if (!EAS_PROJECT_ID) {
      console.warn('[Notifications] EAS project ID is not configured; skipping push registration');
      return false;
    }
    try {
      const token = await registerForPushNotificationsAsync(EAS_PROJECT_ID);
      if (token) {
        setIsPermissionGranted(true);
        await registerDeviceToken(token);
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

  // Deactivate this device's token on the backend and clear local badge state.
  // Call this before signing out so the server stops pushing this user's mail
  // to a device that no longer has an active session. Never throws — logout
  // must proceed even if the network call fails.
  const unregisterDevice = async () => {
    try {
      const deviceId = await getDeviceId();
      await appApi.pushTokens.unregister(deviceId).catch(() => {});
    } catch {
      // ignore — best-effort cleanup
    }
    await setBadgeCount(0);
  };

  useEffect(() => {
    if (!user || !organizationId) {
      if (!user && cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null; }
      return;
    }

    const init = async () => {
      try {
        await createNotificationChannels([
          { id: 'email', name: 'Email Notifications', description: 'New email notifications' },
        ]);

        const { status } = await Notifications.getPermissionsAsync();
        if (EAS_PROJECT_ID && (status === 'granted' || status === 'undetermined')) {
          const token = await registerForPushNotificationsAsync(EAS_PROJECT_ID);
          if (token) {
            setIsPermissionGranted(true);
            registerDeviceToken(token);
          }
        } else if (!EAS_PROJECT_ID) {
          console.warn('[Notifications] EAS project ID is not configured; push notifications disabled');
        }

        const cleanup = setupNotificationListeners(
          (notification) => {
            const data = notification.request.content.data as { unreadCount?: number };
            if (data?.unreadCount !== undefined) { setUnreadCount(data.unreadCount); setBadgeCount(data.unreadCount); }
          },
          // Warm / backgrounded tap. The navigator is already mounted, but we
          // still route through the same queue so navigation is deduped and
          // behaves identically to the cold-start path.
          queueNavigationFromResponse,
        );

        // Cold start: a tap that launched the app from a killed state never
        // reaches the listener above. Replay that launch response once, guarded
        // by a persisted id so a later normal relaunch (same "last response")
        // doesn't reopen the old email.
        try {
          const lastResponse = await Notifications.getLastNotificationResponseAsync();
          if (lastResponse) {
            const lastId = lastResponse.notification.request.identifier;
            const alreadyHandled = await AsyncStorage.getItem(HANDLED_NOTIF_KEY);
            if (lastId && lastId !== alreadyHandled) {
              queueNavigationFromResponse(lastResponse);
            }
          }
        } catch {}

        // Re-register when the device token rotates so pushes don't silently
        // stop between cold starts.
        const removeTokenRefresh = addPushTokenRefreshListener(() => {
          if (!EAS_PROJECT_ID) return;
          registerForPushNotificationsAsync(EAS_PROJECT_ID)
            .then((refreshed) => { if (refreshed) registerDeviceToken(refreshed); })
            .catch(() => {});
        });

        cleanupRef.current = () => { cleanup(); removeTokenRefresh(); };
        setIsConnected(true);
      } catch (error) {
        console.error('Error initializing notifications:', error);
      }
    };

    init();
    return () => { if (cleanupRef.current) cleanupRef.current(); };
  }, [user, organizationId, getCredentials]);

  return (
    <NotificationContext.Provider value={{ unreadCount, isConnected, isPermissionGranted, requestPermissions, openNotificationSettings, refreshBadgeCount, unregisterDevice }}>
      {children}
    </NotificationContext.Provider>
  );
}
