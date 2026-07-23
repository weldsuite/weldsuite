import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { TaskProvider } from '@/contexts/TaskContext';
import { SidebarProvider } from '@/contexts/SidebarContext';
import MiniSidebar, { useShouldShowMiniSidebar } from '@/components/layout/MiniSidebar';
import TaskPagesSidebar from '@/components/task/TaskPagesSidebar';

export default function TaskLayout() {
  const { colors } = useTheme();
  const showMiniSidebar = useShouldShowMiniSidebar();
  const [sidebarsCollapsed, setSidebarsCollapsed] = useState(false);

  const stackContent = (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="task/[id]"
        options={{
          headerShown: false,
          presentation: 'card',
        }}
      />
      <Stack.Screen
        name="project/[id]"
        options={{
          headerShown: false,
          presentation: 'card',
        }}
      />
      <Stack.Screen
        name="create"
        options={{
          headerShown: false,
          presentation: 'modal',
        }}
      />
      <Stack.Screen name="workflows/index" options={{ headerShown: false }} />
      <Stack.Screen name="workflows/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="workflows/create" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="executions/index" options={{ headerShown: false }} />
      <Stack.Screen name="executions/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="schedules/index" options={{ headerShown: false }} />
      <Stack.Screen name="templates/index" options={{ headerShown: false }} />
      <Stack.Screen name="integrations/index" options={{ headerShown: false }} />
      <Stack.Screen name="logs/index" options={{ headerShown: false }} />
      <Stack.Screen name="analytics" options={{ headerShown: false }} />
    </Stack>
  );

  if (showMiniSidebar) {
    return (
      <TaskProvider>
        <SidebarProvider isCollapsed={sidebarsCollapsed} expand={() => setSidebarsCollapsed(false)}>
          <View style={styles.container}>
            {!sidebarsCollapsed && (
              <>
                <MiniSidebar currentApp="task" />
                <TaskPagesSidebar onCollapse={() => setSidebarsCollapsed(true)} />
              </>
            )}
            <View style={styles.content}>
              {stackContent}
            </View>
          </View>
        </SidebarProvider>
      </TaskProvider>
    );
  }

  return (
    <TaskProvider>
      {stackContent}
    </TaskProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'row',
  },
  content: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
});
