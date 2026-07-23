import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import { Platform } from 'react-native';

// Configure how notifications are displayed when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: false,
    shouldPlaySound: false,
    shouldSetBadge: true,
    shouldShowBanner: false,
    shouldShowList: false,
  }),
});

/**
 * Request notification permissions and get an EXPO push token.
 *
 * Delivery is routed through Expo's push service (`exp.host`) — the only
 * transport the backend uses — so we register an Expo push token
 * (`ExponentPushToken[…]`) and deliberately do NOT fall back to a raw native
 * FCM/APNs device token: the Expo push service would reject it and the backend
 * would deactivate it. Android delivery still relies on FCM under the hood, so
 * the EAS project must have FCM credentials configured (a `google-services.json`
 * in the build + the FCM V1 service-account key uploaded via `eas credentials`);
 * Expo relays to FCM on our behalf — we never call FCM directly.
 *
 * @param projectId - EAS project ID (unique per app)
 */
export async function registerForPushNotificationsAsync(projectId: string): Promise<string | undefined> {
  if (!Device.isDevice) {
    console.log('[PushToken] NOT a physical device — skipping push token registration');
    return undefined;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    return undefined;
  }

  try {
    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    return tokenData.data;
  } catch (expoError) {
    console.error(
      '[PushToken] Could not obtain an Expo push token. On Android this usually means the EAS project has no FCM credentials configured (missing google-services.json in the build or no FCM V1 key uploaded via `eas credentials`).',
      expoError,
    );
    return undefined;
  }
}

/**
 * Get a unique device identifier
 */
async function getDeviceId(): Promise<string> {
  if (Platform.OS === 'android') {
    return Application.getAndroidId() || `android_${Date.now()}`;
  } else if (Platform.OS === 'ios') {
    const installId = await Application.getInstallationTimeAsync();
    return `ios_${installId?.getTime() || Date.now()}`;
  }
  return `device_${Date.now()}`;
}

/**
 * Register this device's push token with the unified app-api.
 *
 * Targets `POST /api/push-tokens` (app-api) — the legacy `/v1/user/push-token`
 * route lived on the obsolete mobile-api-worker and is being retired. app-api
 * derives the tenant from the Clerk JWT's active organization, so the org is
 * carried by `accessToken`, not a header. Prefer the typed
 * `@weldsuite/app-api-client` `pushTokens` domain client where available
 * (e.g. weldmail-app); this raw helper exists for apps that only have an access
 * token + base URL (the scaffold template).
 *
 * @param token - Push token (Expo or native FCM/APNs)
 * @param accessToken - Clerk session token (must carry the active org)
 * @param organizationId - Current org ID (sent as a hint header; app-api reads the JWT)
 * @param appCode - App identifier ('weldsuite' | 'welddesk' | 'weldmail' | …)
 * @param apiBaseUrl - app-api base URL
 */
export async function registerDeviceToken(
  token: string,
  accessToken: string,
  organizationId: string | undefined,
  appCode: string = 'weldsuite',
  apiBaseUrl: string = process.env.EXPO_PUBLIC_APP_API_URL || process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8789'
): Promise<boolean> {
  try {
    const deviceId = await getDeviceId();

    const isExpoToken = token.startsWith('ExponentPushToken[');
    const tokenType = isExpoToken ? 'expo' : (Platform.OS === 'android' ? 'fcm' : 'apns');

    // Matches the app-api `/api/push-tokens` register schema.
    const body = {
      token,
      platform: Platform.OS as 'ios' | 'android',
      deviceId,
      tokenType: tokenType as 'expo' | 'fcm' | 'apns',
      appCode,
      deviceModel: Device.modelName || undefined,
      osVersion: Device.osVersion || undefined,
      appVersion: Application.nativeApplicationVersion || undefined,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    };
    if (organizationId) {
      // app-api ignores this (org comes from the JWT); harmless hint for other backends.
      headers['x-organization-id'] = organizationId;
    }

    const response = await fetch(`${apiBaseUrl}/api/push-tokens`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) return false;
    const data = await response.json().catch(() => null);
    // app-api envelope: { data: { deviceId, platform, registered: true } }
    return Boolean(data?.data?.registered);
  } catch (error) {
    console.error('[PushToken] Error registering device token:', error);
    return false;
  }
}

/**
 * Setup notification listeners
 */
export function setupNotificationListeners(
  onNotificationReceived?: (notification: Notifications.Notification) => void,
  onNotificationTapped?: (response: Notifications.NotificationResponse) => void
) {
  const foregroundSubscription = Notifications.addNotificationReceivedListener((notification) => {
    onNotificationReceived?.(notification);
  });

  const responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
    onNotificationTapped?.(response);
  });

  return () => {
    foregroundSubscription.remove();
    responseSubscription.remove();
  };
}

/**
 * Subscribe to device push-token rotations.
 *
 * The underlying FCM/APNs token can rotate (reinstall, restore-from-backup,
 * periodic refresh). When it does, the token previously stored on the backend
 * goes stale and pushes silently stop arriving until the next cold start
 * re-registers. Callers should re-register the fresh token from `onTokenChange`.
 * Returns an unsubscribe function.
 */
export function addPushTokenRefreshListener(onTokenChange: (deviceToken: string) => void): () => void {
  const subscription = Notifications.addPushTokenListener((tokenData) => {
    onTokenChange(String(tokenData.data));
  });
  return () => subscription.remove();
}

/**
 * Set badge count
 */
export async function setBadgeCount(count: number): Promise<void> {
  try {
    await Notifications.setBadgeCountAsync(count);
  } catch (error) {
    console.error('Error setting badge count:', error);
  }
}

/**
 * Get badge count
 */
export async function getBadgeCount(): Promise<number> {
  try {
    return await Notifications.getBadgeCountAsync();
  } catch (error) {
    console.error('Error getting badge count:', error);
    return 0;
  }
}

/**
 * Create Android notification channels
 */
export async function createNotificationChannels(
  channels: Array<{ id: string; name: string; description?: string; importance?: Notifications.AndroidImportance; sound?: string }>
): Promise<void> {
  if (Platform.OS !== 'android') return;

  for (const channel of channels) {
    await Notifications.setNotificationChannelAsync(channel.id, {
      name: channel.name,
      description: channel.description,
      importance: channel.importance ?? Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      // Use the system default sound unless the caller supplies a bundled custom
      // sound. (Previously hardcoded 'notification.wav', which was never bundled
      // in any app and silently fell back to the default anyway.)
      sound: channel.sound ?? 'default',
    });
  }
}
