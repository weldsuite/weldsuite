import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import ProjectsSidebar from '@/components/ProjectsSidebar';
import MiniSidebar, { useShouldShowMiniSidebar } from '@/components/layout/MiniSidebar';
import { SidebarProvider } from '@/contexts/SidebarContext';

export default function ProjectsLayout() {
  const showMiniSidebar = useShouldShowMiniSidebar();
  const [sidebarsCollapsed, setSidebarsCollapsed] = useState(false);

  // iPad: Show mini sidebar + projects sidebar + main content
  if (showMiniSidebar) {
    return (
      <SidebarProvider isCollapsed={sidebarsCollapsed} expand={() => setSidebarsCollapsed(false)}>
        <View style={styles.container}>
          {!sidebarsCollapsed && (
            <>
              <MiniSidebar currentApp="projects" />
              <ProjectsSidebar onCollapse={() => setSidebarsCollapsed(true)} />
            </>
          )}
          <View style={styles.content}>
            <Stack
              screenOptions={{
                headerShown: false,
              }}
            >
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="new/index" />
              <Stack.Screen name="my-tasks/index" />
              <Stack.Screen name="all-projects/index" />
              <Stack.Screen name="workload/index" />
              <Stack.Screen name="project/[projectId]" />
              <Stack.Screen name="settings/index" />
            </Stack>
          </View>
        </View>
      </SidebarProvider>
    );
  }

  // iPhone: Pass through to existing tab layout
  return (
    <Stack
      screenOptions={{
        headerShown: false,
      }}
    />
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
