import { Tabs } from "expo-router";
import React from "react";
import { Platform } from "react-native";
import { Home, Grid3x3, Bell, Settings } from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShouldShowMiniSidebar } from '@/components/layout/MiniSidebar';
import { haptics } from '@/utils/haptics';

export default function TabLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const isTablet = useShouldShowMiniSidebar();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.muted,
        headerShown: false,
        // Hide tab bar on iPad/tablets since we use MiniSidebar
        tabBarStyle: isTablet ? { display: 'none' } : {
          backgroundColor: Platform.OS === 'ios' ? colors.cardBackground : colors.background,
          position: Platform.OS === 'ios' ? 'absolute' as const : undefined,
          height: 50 + insets.bottom,
          paddingBottom: insets.bottom,
        },
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '500',
          marginTop: 2,
        },
        tabBarIconStyle: {
          marginBottom: 2,
        },
      }}
      screenListeners={{
        tabPress: () => {
          haptics.light();
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => (
            <Home size={20} color={color} strokeWidth={2} />
          ),
        }}
      />

      <Tabs.Screen
        name="apps"
        options={{
          title: "Apps",
          tabBarIcon: ({ color, size }) => (
            <Grid3x3 size={20} color={color} strokeWidth={2} />
          ),
        }}
      />

      <Tabs.Screen
        name="notifications"
        options={{
          title: "Notifications",
          tabBarIcon: ({ color, size }) => (
            <Bell size={20} color={color} strokeWidth={2} />
          ),
        }}
      />

      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => (
            <Settings size={20} color={color} strokeWidth={2} />
          ),
        }}
      />

      {/* Hide unused tabs - these files still exist in (tabs) folder but are not used */}
    </Tabs>
  );
}