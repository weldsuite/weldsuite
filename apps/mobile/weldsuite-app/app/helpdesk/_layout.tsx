import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import MiniSidebar, { useShouldShowMiniSidebar } from '@/components/layout/MiniSidebar';

export default function HelpdeskLayout() {
  const { colors } = useTheme();
  const showMiniSidebar = useShouldShowMiniSidebar();

  const stackContent = (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="ticket/[id]"
        options={{
          headerShown: false,
          presentation: 'card',
          gestureEnabled: true,
          gestureDirection: 'horizontal',
          fullScreenGestureEnabled: true,
          animation: 'slide_from_right',
        }}
      />
      <Stack.Screen
        name="ticket/new"
        options={{
          headerShown: false,
          presentation: 'modal',
        }}
      />
      <Stack.Screen
        name="contact/[id]"
        options={{
          headerShown: false,
          presentation: 'card',
        }}
      />
    </Stack>
  );

  if (showMiniSidebar) {
    return (
      <View style={styles.container}>
        <MiniSidebar currentApp="helpdesk" />
        <View style={styles.content}>
          {stackContent}
        </View>
      </View>
    );
  }

  return stackContent;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'row',
  },
  content: {
    flex: 1,
  },
});
