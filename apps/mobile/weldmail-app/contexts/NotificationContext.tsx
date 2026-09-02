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
  dismissAllPresentedNotifications,
  createNotificationChannels,
  addPushTokenRefreshListener,
} from '@weldsuite/mobile-ui/services/notifications';
import { appApi } from '@/services/app-api';
import { personalApi } from '@/services/personal-api';
import { useMail } from '@/contexts/MailContext';
import {
  parseNotificationContent,
  emailOpenParams,
  notificationMatchesWorkspace,
  type NotificationTarget,
} from '@/utils/notification-target';
import { hideAppSplash } from '@/utils/splash';

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
// If we queued a notification open but the email route never mounts, don't
// leave the inbox on `return null` forever (looks like a freeze on restart).
const OPENING_EMAIL_TIMEOUT_MS = 5000;

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
  /**
   * Deactivate this device's push token in the *current* tenant (JWT org),
   * dismiss presented OS banners, and clear the badge. Call this *before*
   * Clerk `setActive` when switching workspaces so the previous tenant stops
   * delivering mail pushes to this device.
   */
  prepareWorkspaceSwitch: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType>({
  unreadCount: 0, isConnected: false, isPermissionGranted: false,
  requestPermissions: async () => false, openNotificationSettings: async () => {},
  refreshBadgeCount: async () => {}, unregisterDevice: async () => {},
  launchReady: true, openingEmailId: null, prepareWorkspaceSwitch: async () => {},
});

export const useNotifications = () => useContext(NotificationContext);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user, getCredentials, organizationId, isLoading: authLoading } = useClerkAuth();
  const {
    selectAccountById,
    setSelectedLabel,
    refreshMail,
    expectNotificationEmail,
    hasPersonalAccount,
  } = useMail();
  const router = useRouter();
  const segments = useSegments();
  const rootNavigationState = useRootNavigationState();
  const navReady = !!rootNavigationState?.key;
  const [unreadCount, setUnreadCount] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [isPermissionGranted, setIsPermissionGranted] = useState(false);
  const [launchReady, setLaunchReady] = useState(true);
  const [openingEmailId, setOpeningEmailId] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [pendingNav, setPendingNav] = useState<NotificationTarget | null>(null);
  const pendingNotifIdRef = useRef<string | undefined>(undefined);
  const handledNotifIds = useRef<Set<string>>(new Set());

  // Latest org id for notification listeners (they are mounted once; ref avoids
  // stale closures when the user switches workspaces).
  const organizationIdRef = useRef(organizationId);
  organizationIdRef.current = organizationId;

  const markNotificationHandled = useCallback((notifId: string) => {
    if (!notifId || handledNotifIds.current.has(notifId)) return;
    handledNotifIds.current.add(notifId);
    AsyncStorage.setItem(HANDLED_NOTIF_KEY, notifId).catch(() => {});
  }, []);

  const queueNavigationFromResponse = useCallback((response: Notifications.NotificationResponse) => {
    const notifId = response.notification.request.identifier;
    if (notifId && handledNotifIds.current.has(notifId)) return;
    const target = parseNotificationContent(response.notification.request.content);
    if (!target) return;
    // Ignore taps for another workspace (payload may still arrive briefly after
    // a switch, or if unregister against the previous tenant failed).
    if (!notificationMatchesWorkspace(target, organizationIdRef.current)) return;
    if (target.emailId) setOpeningEmailId(target.emailId);
    pendingNotifIdRef.current = notifId || undefined;
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
    if (!openingEmailId) return;
    const timer = setTimeout(() => {
      setOpeningEmailId(null);
      setPendingNav(null);
      pendingNotifIdRef.current = undefined;
      hideAppSplash();
    }, OPENING_EMAIL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [openingEmailId]);

  useEffect(() => {
    if (!navReady || !pendingNav || authLoading || !user) return;
    // Re-check after org hydrates — cold-start may have queued a tap before
    // organizationId was known.
    if (!notificationMatchesWorkspace(pendingNav, organizationId)) {
      setPendingNav(null);
      pendingNotifIdRef.current = undefined;
      setOpeningEmailId(null);
      return;
    }
    if (pendingNav.accountId) selectAccountById(pendingNav.accountId);
    setSelectedLabel('INBOX');
    expectNotificationEmail(pendingNav.emailId);
    refreshMail();
    const params = emailOpenParams(pendingNav);
    if (params) {
      router.push({ pathname: '/[id]', params });
    } else {
      router.push('/');
      setOpeningEmailId(null);
    }
    if (pendingNotifIdRef.current) markNotificationHandled(pendingNotifIdRef.current);
    pendingNotifIdRef.current = undefined;
    setPendingNav(null);
  }, [
    navReady, pendingNav, authLoading, user, organizationId, router,
    selectAccountById, setSelectedLabel, expectNotificationEmail, refreshMail,
    markNotificationHandled,
  ]);

  const registerDeviceToken = async (token: string) => {
    const deviceId = await getDeviceId();
    const isExpoToken = token.startsWith('ExponentPushToken[');
    const tokenType = isExpoToken ? 'expo' : (Platform.OS === 'android' ? 'fcm' : 'apns');
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

    // Workspace addresses push from the tenant DB (app-api); a personal
    // @weldmail.com address has no tenant, so its token lives in the personal
    // DB behind personal-api. This app shows both side by side, so register
    // with whichever backends apply — registering with only one silently drops
    // notifications for the other tenancy.
    const registrations: Promise<unknown>[] = [
      appApi.pushTokens.register(payload).catch(() => {}),
    ];
    if (hasPersonalAccount) {
      registrations.push(personalApi.pushTokens.register(payload).catch(() => {}));
    }
    await Promise.all(registrations);
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
      await Promise.all([
        appApi.pushTokens.unregister(deviceId).catch(() => {}),
        // Always attempt the personal side too: on sign-out the account list
        // may already be cleared, so `hasPersonalAccount` can't be trusted to
        // decide whether there is a personal token to deactivate.
        personalApi.pushTokens.unregister(deviceId).catch(() => {}),
      ]);
    } catch {
      // ignore — best-effort cleanup
    }
    await dismissAllPresentedNotifications();
    await setBadgeCount(0);
  };

  // Same cleanup as sign-out, but keep the session: deactivate the token while
  // the JWT still points at the *leaving* workspace, then clear the shade.
  // NotificationContext re-registers against the new org after setActive.
  //
  // Deliberately NOT `unregisterDevice`: that also deactivates the personal
  // token, and the personal inbox is not workspace-scoped — switching orgs
  // must not silence @weldmail.com notifications.
  const prepareWorkspaceSwitch = async () => {
    try {
      const deviceId = await getDeviceId();
      await appApi.pushTokens.unregister(deviceId).catch(() => {});
    } catch {
      // ignore — best-effort cleanup
    }
    await dismissAllPresentedNotifications();
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
            const target = parseNotificationContent(notification.request.content);
            // Drop badge updates from pushes that belong to another workspace.
            if (target && !notificationMatchesWorkspace(target, organizationIdRef.current)) {
              return;
            }
            const data = notification.request.content.data as { unreadCount?: number };
            if (data?.unreadCount !== undefined) {
              setUnreadCount(data.unreadCount);
              setBadgeCount(data.unreadCount);
            }
          },
          queueNavigationFromResponse,
        );
        cleanupRef.current = cleanup;

        // Do not replay getLastNotificationResponseAsync on cold start. iOS keeps
        // the last response across relaunches; replaying it sets openingEmailId and
        // leaves the inbox on `return null` when navigation fails — feels like a
        // freeze on the 2nd open. Live taps still go through queueNavigationFromResponse.
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

  // Registration needs a signed-in user. It does NOT need an org: a
  // personal-only user has no Clerk org, and gating on one left them with no
  // token registered anywhere. `hasPersonalAccount` is in the deps so the
  // personal token registers as soon as the account list resolves — it is
  // usually still false on the first pass.
  useEffect(() => {
    if (!user) return;
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
  }, [user, organizationId, hasPersonalAccount, getCredentials]);

  return (
    <NotificationContext.Provider value={{
      unreadCount, isConnected, isPermissionGranted,
      requestPermissions, openNotificationSettings, refreshBadgeCount, unregisterDevice,
      launchReady, openingEmailId, prepareWorkspaceSwitch,
    }}>
      {children}
    </NotificationContext.Provider>
  );
}
