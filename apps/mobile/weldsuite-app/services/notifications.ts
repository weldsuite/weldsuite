import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import api from './api';

// Configure how notifications are displayed when app is in foreground
// Suppress visual/sound alerts when the app is active; only update the badge
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
 * Request notification permissions
 */
export async function registerForPushNotificationsAsync(): Promise<string | undefined> {
  console.log('[PushToken] registerForPushNotificationsAsync called');
  console.log('[PushToken] Platform:', Platform.OS, '| isDevice:', Device.isDevice);

  if (Platform.OS === 'android') {
    // Create notification channels for Android
    // `sound: 'default'` plays the system notification sound. A prior
    // 'notification.wav' reference was never bundled in the app and silently
    // fell back to default anyway — swap a bundled asset here if a custom
    // sound is desired.
    await Notifications.setNotificationChannelAsync('email', {
      name: 'Email Notifications',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF231F7C',
      sound: 'default',
    });

    await Notifications.setNotificationChannelAsync('helpdesk', {
      name: 'Helpdesk Notifications',
      description: 'Notifications for new conversations and messages',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#3B82F6',
      sound: 'default',
    });
  }

  if (!Device.isDevice) {
    console.log('[PushToken] NOT a physical device — skipping push token registration');
    return undefined;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  console.log('[PushToken] Existing permission status:', existingStatus);
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
    console.log('[PushToken] Requested permission, new status:', finalStatus);
  }

  if (finalStatus !== 'granted') {
    console.log('[PushToken] Permission NOT granted — aborting');
    return;
  }

  // Register an EXPO push token only. Delivery is routed through Expo's push
  // service (exp.host) — the transport the backend uses — so we do NOT fall
  // back to a raw native FCM/APNs device token (Expo would reject it and the
  // backend would deactivate it). Android delivery still needs FCM credentials
  // configured on the EAS project (google-services.json + FCM V1 key); Expo
  // relays to FCM for us — we never call FCM directly.
  try {
    console.log('[PushToken] Attempting to get Expo push token...');
    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: '6c2b366b-5406-4174-bdb0-b75b1f886d65',
    });
    console.log('[PushToken] Got Expo push token:', tokenData.data);
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
  // Try to get a unique device identifier
  if (Platform.OS === 'android') {
    return Application.getAndroidId() || `android_${Date.now()}`;
  } else if (Platform.OS === 'ios') {
    // For iOS, use installation ID as a stable identifier
    const installId = await Application.getInstallationTimeAsync();
    return `ios_${installId?.getTime() || Date.now()}`;
  }
  return `device_${Date.now()}`;
}

/**
 * Register device token with backend
 */
export async function registerDeviceToken(token: string, accessToken: string, organizationId?: string): Promise<boolean> {
  console.log('[PushToken] registerDeviceToken called');
  console.log('[PushToken] token:', token?.substring(0, 30) + '...');
  console.log('[PushToken] accessToken present:', !!accessToken);
  console.log('[PushToken] organizationId:', organizationId);

  try {
    // Set the access token and organization ID before making the request
    api.setAccessToken(accessToken);
    if (organizationId) {
      api.setOrganizationId(organizationId);
    }

    const deviceId = await getDeviceId();
    console.log('[PushToken] deviceId:', deviceId);

    // Detect token type: ExponentPushToken[...] = expo, otherwise fcm/apns
    const isExpoToken = token.startsWith('ExponentPushToken[');
    const tokenType = isExpoToken ? 'expo' : (Platform.OS === 'android' ? 'fcm' : 'apns');
    console.log('[PushToken] tokenType:', tokenType);

    const deviceInfo = {
      deviceId,
      token,
      platform: Platform.OS as 'ios' | 'android',
      tokenType: tokenType as 'expo' | 'fcm' | 'apns',
      deviceModel: Device.modelName || 'Unknown',
      osVersion: Device.osVersion || 'Unknown',
      appVersion: Application.nativeApplicationVersion || '1.0.0',
    };

    console.log('[PushToken] Calling api.registerDevice with:', JSON.stringify(deviceInfo, null, 2));
    const response = await api.registerDevice(deviceInfo);
    console.log('[PushToken] API response:', JSON.stringify(response, null, 2));

    if (response.success && response.data?.registered) {
      console.log('[PushToken] Device token registered successfully!');
      return true;
    }

    console.warn('[PushToken] Device token registration failed:', JSON.stringify(response.error));
    return false;
  } catch (error) {
    console.error('[PushToken] Error registering device token:', error);
    return false;
  }
}

/**
 * Unregister device token from backend
 */
export async function unregisterDeviceToken(accessToken: string): Promise<boolean> {
  try {
    // Set the access token before making the request
    api.setAccessToken(accessToken);

    const deviceId = await getDeviceId();
    const response = await api.unregisterDevice(deviceId);

    if (response.success && response.data?.unregistered) {
      return true;
    }

    return false;
  } catch (error) {
    console.error('Error unregistering device token:', error);
    return false;
  }
}

/**
 * Get notification preferences
 */
export async function getNotificationPreferences(accessToken: string, emailAccountId?: string) {
  try {
    const response = await api.getNotificationPreferences(emailAccountId);
    return response.data;
  } catch (error) {
    console.error('Error getting notification preferences:', error);
    return null;
  }
}

/**
 * Update notification preferences
 */
export async function updateNotificationPreferences(
  preferences: any,
  accessToken: string
): Promise<boolean> {
  try {
    const response = await api.updateNotificationPreferences(preferences);

    if (response.success && response.data?.success) {
      return true;
    }

    return false;
  } catch (error) {
    console.error('Error updating notification preferences:', error);
    return false;
  }
}

/**
 * Send test notification
 */
export async function sendTestNotification(accessToken: string): Promise<boolean> {
  try {
    const response = await api.sendTestNotification();

    if (response.success && response.data?.success) {
      return true;
    }

    return false;
  } catch (error) {
    console.error('Error sending test notification:', error);
    return false;
  }
}

/**
 * Get notification history
 */
export async function getNotificationHistory(accessToken: string, limit: number = 50) {
  try {
    const response = await api.getNotificationHistory(limit);
    return response.data?.notifications || [];
  } catch (error) {
    console.error('Error getting notification history:', error);
    return [];
  }
}

/**
 * Mark notification as read
 */
export async function markNotificationAsRead(
  notificationId: string,
  accessToken: string
): Promise<boolean> {
  try {
    const response = await api.markNotificationAsRead(notificationId);
    return response.success && response.data?.success || false;
  } catch (error) {
    console.error('Error marking notification as read:', error);
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
  // Listener for notifications received while app is in foreground
  const foregroundSubscription = Notifications.addNotificationReceivedListener((notification) => {
    onNotificationReceived?.(notification);
  });

  // Listener for when a notification is tapped
  const responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
    onNotificationTapped?.(response);
  });

  // Return cleanup function
  return () => {
    foregroundSubscription.remove();
    responseSubscription.remove();
  };
}

/**
 * Get badge count from server
 */
export async function getBadgeCount(accessToken: string): Promise<number> {
  try {
    // Set the access token before making the request
    api.setAccessToken(accessToken);
    const response = await api.getUnreadNotificationCount();
    if (response.data?.count !== undefined) {
      return response.data.count;
    }
    return 0;
  } catch (error) {
    console.error('Error getting badge count:', error);
    return 0;
  }
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
