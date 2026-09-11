import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import * as Linking from 'expo-linking';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { useOrganizationList } from '@clerk/expo';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useRouter } from 'expo-router';
import { appApi } from '@/services/app-api';
import { personalApi } from '@/services/personal-api';

/**
 * Parse a WeldCalendar deep-link target from an Expo push payload.
 *
 * Prefers an explicit `eventId` (sent by the notification orchestrator); falls
 * back to `entityId` when `entityType` says this is a calendar event, and last
 * to scraping `/weldcalendar?event={id}` out of `actionUrl` — the link shape
 * the platform puts in its own notifications.
 *
 * Ids are whitelisted against `[A-Za-z0-9_-]` before they reach the router: a
 * push payload is attacker-influenceable input, and an unchecked value becomes
 * a path segment.
 */
function resolveEventDeepLink(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;

  const candidate =
    (typeof data.eventId === 'string' && data.eventId) ||
    (data.entityType === 'calendar_event' && typeof data.entityId === 'string'
      ? data.entityId
      : undefined) ||
    (typeof data.actionUrl === 'string'
      ? data.actionUrl.match(/[?&]event=([^&#]+)/)?.[1]
      : undefined);

  if (!candidate || !/^[A-Za-z0-9_-]+$/.test(candidate)) return null;
  return candidate;
}

function parseClerkOrgId(value: unknown): string | null {
  return typeof value === 'string' && /^org_[A-Za-z0-9]+$/.test(value) ? value : null;
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
const APP_CODE = 'weldcalendar';

/**
 * The placeholder `eas init` has not replaced yet. Treating it as "absent"
 * keeps a fresh clone from firing doomed token requests at Expo's push service
 * on every cold start.
 */
const PLACEHOLDER_PROJECT_ID = '00000000-0000-0000-0000-000000000000';
const hasProjectId = !!EAS_PROJECT_ID && EAS_PROJECT_ID !== PLACEHOLDER_PROJECT_ID;

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
  prepareWorkspaceSwitch: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType>({
  unreadCount: 0,
  isConnected: false,
  isPermissionGranted: false,
  requestPermissions: async () => false,
  openNotificationSettings: async () => {},
  refreshBadgeCount: async () => {},
  unregisterDevice: async () => {},
  prepareWorkspaceSwitch: async () => {},
});

export const useNotifications = () => useContext(NotificationContext);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user, organizationId } = useClerkAuth();
  const { setActive } = useOrganizationList();
  const router = useRouter();
  const [unreadCount, setUnreadCount] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [isPermissionGranted, setIsPermissionGranted] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const registerPushToken = useCallback(async (token: string) => {
    const deviceId = await getDeviceId();
    const isExpoToken = token.startsWith('ExponentPushToken[');
    const tokenType = isExpoToken ? 'expo' : Platform.OS === 'android' ? 'fcm' : 'apns';
    const payload = {
      token,
      platform: Platform.OS as 'ios' | 'android',
      deviceId,
      appCode: APP_CODE,
      tokenType: tokenType as 'expo' | 'fcm' | 'apns',
      deviceModel: Device.modelName || undefined,
      osVersion: Device.osVersion || undefined,
      appVersion: Application.nativeApplicationVersion || undefined,
    };
    // Workspace events push from the tenant DB (app-api); personal calendars
    // have no tenant, so their token lives behind personal-api. Register with
    // both — a personal-only user has no org, and gating on one left them
    // with no token registered anywhere.
    await Promise.all([
      appApi.pushTokens.register(payload).catch(() => {}),
      personalApi.pushTokens.register(payload).catch(() => {}),
    ]);
  }, []);

  const requestPermissions = async (): Promise<boolean> => {
    if (!notifUtils || !hasProjectId) {
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
      await Promise.all([
        appApi.pushTokens.unregister(deviceId).catch(() => {}),
        personalApi.pushTokens.unregister(deviceId).catch(() => {}),
      ]);
    } catch {
      // best-effort cleanup
    }
    await notifUtils?.dismissAllPresentedNotifications();
    await notifUtils?.setBadgeCount(0);
    setUnreadCount(0);
  }, []);

  // Same cleanup as sign-out, but keep the session: deactivate the token while
  // the JWT still points at the *leaving* workspace. Deliberately NOT
  // `unregisterDevice`: that also deactivates the personal token, and the
  // personal calendar is not workspace-scoped.
  const prepareWorkspaceSwitch = async () => {
    try {
      const deviceId = await getDeviceId();
      await appApi.pushTokens.unregister(deviceId).catch(() => {});
    } catch {
      // ignore — best-effort cleanup
    }
    await notifUtils?.dismissAllPresentedNotifications();
    await notifUtils?.setBadgeCount(0);
  };

  useEffect(() => {
    if (!user) {
      if (cleanupRef.current) {
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
            id: 'weldcalendar',
            name: 'WeldCalendar Notifications',
            description: 'Event reminders, invitations and changes',
          },
        ]);

        // Only re-register when permission is already granted — never prompt
        // on cold start. The deliberate prompt lives in requestPermissions().
        if (hasProjectId) {
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
            const eventId = resolveEventDeepLink(data);
            if (!eventId) return;
            const tapOrgId = parseClerkOrgId(data.clerkOrgId);
            if (tapOrgId && tapOrgId !== organizationId && setActive) {
              void setActive({ organization: tapOrgId }).then(() => {
                router.push(`/event/${eventId}`);
              });
              return;
            }
            router.push(`/event/${eventId}`);
          },
        );

        const removeTokenRefresh = notifUtils.addPushTokenRefreshListener(() => {
          if (!hasProjectId) return;
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
  }, [user, organizationId, registerPushToken, refreshBadgeCount, router, setActive]);

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
        prepareWorkspaceSwitch,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}
