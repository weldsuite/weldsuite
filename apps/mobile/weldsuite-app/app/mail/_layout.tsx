import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { MailProvider } from '@/contexts/MailContext';
import MiniSidebar, { useShouldShowMiniSidebar } from '@/components/layout/MiniSidebar';

export default function MailLayout() {
  const showMiniSidebar = useShouldShowMiniSidebar();

  const stackContent = (
    <Stack
      screenOptions={{
        headerShown: false,
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen
        name="compose"
        options={{
          headerShown: false,
          presentation: 'modal',
          animation: 'slide_from_bottom',
          gestureEnabled: false,
        }}
      />
      <Stack.Screen
        name="[id]"
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
        name="search"
        options={{
          headerShown: false,
          presentation: 'card',
          animation: 'fade',
          animationDuration: 150,
        }}
      />
    </Stack>
  );

  if (showMiniSidebar) {
    return (
      <MailProvider>
        <View style={styles.container}>
          <MiniSidebar currentApp="mail" />
          <View style={styles.content}>
            {stackContent}
          </View>
        </View>
      </MailProvider>
    );
  }

  return (
    <MailProvider>
      {stackContent}
    </MailProvider>
  );
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
