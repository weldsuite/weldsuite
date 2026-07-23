import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import MiniSidebar, { useShouldShowMiniSidebar } from '@/components/layout/MiniSidebar';

export default function CommerceLayout() {
  const { colors } = useTheme();
  const showMiniSidebar = useShouldShowMiniSidebar();

  if (showMiniSidebar) {
    return (
      <View style={styles.container}>
        <MiniSidebar currentApp="commerce" />
        <View style={styles.content}>
          <Stack
            screenOptions={{
              headerShown: false,
            }}
          >
            <Stack.Screen
              name="(tabs)"
              options={{
                headerShown: false,
              }}
            />
          </Stack>
        </View>
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
      }}
    >
      <Stack.Screen
        name="(tabs)"
        options={{
          headerShown: false,
        }}
      />
    </Stack>
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
