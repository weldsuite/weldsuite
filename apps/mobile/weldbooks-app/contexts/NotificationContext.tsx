import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

const EAS_PROJECT_ID =
  Constants.expoConfig?.extra?.eas?.projectId || process.env.EXPO_PUBLIC_EAS_PROJECT_ID || '';

interface NotificationContextType {
  badgeCount: number;
  setBadgeCount: (count: number) => void;
  registerForPushNotifications: () => Promise<string | null>;
}

const NotificationContext = createContext<NotificationContextType>({
  badgeCount: 0,
  setBadgeCount: () => {},
  registerForPushNotifications: async () => null,
});

export const useNotifications = () => useContext(NotificationContext);

// expo-notifications on SDK 54 replaced `shouldShowAlert` with the explicit
// `shouldShowBanner` / `shouldShowList` pair. Omitting them leaves foreground
// notifications invisible, so both are set here alongside the legacy field
// (still accepted, and still what older Android builds read).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [badgeCount, setBadgeCount] = useState(0);

  const registerForPushNotifications = useCallback(async () => {
    if (!Device.isDevice) return null;

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') return null;

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'WeldBooks',
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#10B981',
      });
    }

    const token = await Notifications.getExpoPushTokenAsync(
      EAS_PROJECT_ID ? { projectId: EAS_PROJECT_ID } : undefined,
    );
    return token.data;
  }, []);

  useEffect(() => {
    registerForPushNotifications();
  }, [registerForPushNotifications]);

  return (
    <NotificationContext.Provider value={{ badgeCount, setBadgeCount, registerForPushNotifications }}>
      {children}
    </NotificationContext.Provider>
  );
}
