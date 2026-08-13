import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import * as Notifications from 'expo-notifications';
import * as Linking from 'expo-linking';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useRouter, useRootNavigationState, useSegments } from 'expo-router';
import {
  registerForPushNotificationsAsync,
  setupNotificationListeners,
  setBadgeCount,
  createNotificationChannels,
  addPushTokenRefreshListener,
} from '@weldsuite/mobile-ui/services/notifications';
import { appApi } from '@/services/app-api';
import { useMail } from '@/contexts/MailContext';
import {
  parseNotificationContent,
  emailOpenParams,
  type NotificationTarget,
} from '@/utils/notification-target';

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
  /**
   * False until we've inspected the OS "last notification response". The
   * inbox stays unpainted until then so a cold-start tap never flashes the
   * list before we replace it with the email.
   */
  launchReady: boolean;
  /** Email we're opening from a tap; inbox renders nothing while this is set. */
  openingEmailId: string | null;
}

const NotificationContext = createContext<NotificationContextType>({
  unreadCount: 0, isConnected: false, isPermissionGranted: false,
  requestPermissions: async () => false, openNotificationSettings: async () => {},
  refreshBadgeCount: async () => {}, unregisterDevice: async () => {},
  launchReady: true, openingEmailId: null,
});

export const useNotifications = () => useContext(NotificationContext);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user, getCredentials, organizationId, isLoading: authLoading } = useClerkAuth();
  const { selectAccountById, setSelectedLabel, refreshMail, expectNotificationEmail } = useMail();
  const router = useRouter();
  const segments = useSegments();
  const rootNavigationState = useRootNavigationState();
  const navReady = !!rootNavigationState?.key;
  const [unreadCount, setUnreadCount] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [isPermissionGranted, setIsPermissionGranted] = useState(false);
  const [launchReady, setLaunchReady] = useState(false);
  const [openingEmailId, setOpeningEmailId] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [pendingNav, setPendingNav] = useState<NotificationTarget | null>(null);
  const handledNotifIds = useRef<Set<string>>(new Set());

  const queueNavigationFromResponse = useCallback((response: Notifications.NotificationResponse) => {
    const notifId = response.notification.request.identifier;
    if (notifId) {
      if (handledNotifIds.current.has(notifId)) return;
      handledNotifIds.current.add(notifId);
      AsyncStorage.setItem(HANDLED_NOTIF_KEY, notifId).catch(() => {});
    }
    const target = parseNotificationContent(response.notification.request.content);
    if (!target) return;
    if (target.emailId) setOpeningEmailId(target.emailId);
    setPendingNav(target);
  }, []);

  // Inbox can paint once the email screen is actually on the stack (it sits
  // underneath and loads in the background). Clearing too early flashes the list.
  useEffect(() => {
    if (openingEmailId && segments[0] === '[id]') {
      setOpeningEmailId(null);
    }
  }, [segments, openingEmailId]);

  useEffect(() => {
    if (!navReady || !pendingNav || authLoading || !user) return;
    if (pendingNav.accountId) selectAccountById(pendingNav.accountId);
    setSelectedLabel('INBOX');
    expectNotificationEmail(pendingNav.emailId);
    refreshMail();
    const params = emailOpenParams(pendingNav);
    if (params) {
      router.push({ pathname: '/[id]', params });
    } else {
      router.push('/');
    }
    setPendingNav(null);
  }, [
    navReady, pendingNav, authLoading, user, router,
    selectAccountById, setSelectedLabel, expectNotificationEmail, refreshMail,
  ]);

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

  const unregisterDevice = async () => {
    try {
      const deviceId = await getDeviceId();
      await appApi.pushTokens.unregister(deviceId).catch(() => {});
    } catch {
      // ignore — best-effort cleanup
    }
    await setBadgeCount(0);
  };

  // Cold-start replay + tap listener: do this on mount, not after org hydrates.
  // Waiting for organizationId was what left the inbox on screen first.
  useEffect(() => {
    let cancelled = false;
    const initLaunch = async () => {
      try {
        const cleanup = setupNotificationListeners(
          (notification) => {
            const data = notification.request.content.data as { unreadCount?: number };
            if (data?.unreadCount !== undefined) {
              setUnreadCount(data.unreadCount);
              setBadgeCount(data.unreadCount);
            }
          },
          queueNavigationFromResponse,
        );
        cleanupRef.current = cleanup;

        const lastResponse = await Notifications.getLastNotificationResponseAsync();
        if (cancelled) return;
        if (lastResponse) {
          const lastId = lastResponse.notification.request.identifier;
          const alreadyHandled = await AsyncStorage.getItem(HANDLED_NOTIF_KEY);
          if (lastId && lastId !== alreadyHandled) {
            queueNavigationFromResponse(lastResponse);
          }
        }
      } catch {
        // Launch still has to settle so the inbox isn't blocked forever.
      } finally {
        if (!cancelled) setLaunchReady(true);
      }
    };
    initLaunch();
    return () => {
      cancelled = true;
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, [queueNavigationFromResponse]);

  // Device token registration still needs a signed-in user + org-scoped JWT.
  useEffect(() => {
    if (!user || !organizationId) return;
    let removeTokenRefresh: (() => void) | undefined;

    const initToken = async () => {
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

        removeTokenRefresh = addPushTokenRefreshListener(() => {
          if (!EAS_PROJECT_ID) return;
          registerForPushNotificationsAsync(EAS_PROJECT_ID)
            .then((refreshed) => { if (refreshed) registerDeviceToken(refreshed); })
            .catch(() => {});
        });
        setIsConnected(true);
      } catch (error) {
        console.error('Error initializing notifications:', error);
      }
    };

    initToken();
    return () => { removeTokenRefresh?.(); };
  }, [user, organizationId, getCredentials]);

  return (
    <NotificationContext.Provider value={{
      unreadCount, isConnected, isPermissionGranted,
      requestPermissions, openNotificationSettings, refreshBadgeCount, unregisterDevice,
      launchReady, openingEmailId,
    }}>
      {children}
    </NotificationContext.Provider>
  );
}
