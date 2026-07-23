import React, { useState } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Stack } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PanelLeftOpen } from 'lucide-react-native';
import MiniSidebar, { useShouldShowMiniSidebar } from '@/components/layout/MiniSidebar';
import CrmPagesSidebar from '@/components/crm/CrmPagesSidebar';

export default function CrmLayout() {
  const { colors } = useTheme();
  const showMiniSidebar = useShouldShowMiniSidebar();
  const [sidebarsCollapsed, setSidebarsCollapsed] = useState(false);
  const insets = useSafeAreaInsets();

  const stackContent = (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="pipeline/[id]"
        options={{
          headerShown: false,
          presentation: 'card',
        }}
      />
      <Stack.Screen name="companies" options={{ headerShown: false }} />
      <Stack.Screen name="contacts" options={{ headerShown: false }} />
      <Stack.Screen name="emails" options={{ headerShown: false }} />
      <Stack.Screen name="analytics" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ headerShown: false }} />
      <Stack.Screen name="calls/index" options={{ headerShown: false }} />
    </Stack>
  );

  if (showMiniSidebar) {
    return (
      <SidebarProvider isCollapsed={sidebarsCollapsed} expand={() => setSidebarsCollapsed(false)}>
        <View style={styles.container}>
          {!sidebarsCollapsed && (
            <>
              <MiniSidebar currentApp="crm" />
              <CrmPagesSidebar onCollapse={() => setSidebarsCollapsed(true)} />
            </>
          )}
          <View style={styles.content}>
            <View style={[styles.contentHeader, { paddingTop: insets.top + 12, paddingBottom: 12 }]}>
              {sidebarsCollapsed && (
                <TouchableOpacity
                  style={styles.expandButton}
                  onPress={() => setSidebarsCollapsed(false)}
                >
                  <PanelLeftOpen size={20} color="#6B7280" strokeWidth={2} />
                </TouchableOpacity>
              )}
            </View>
            {stackContent}
          </View>
        </View>
      </SidebarProvider>
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
  contentHeader: {
    borderBottomWidth: 1,
    borderBottomColor: '#ebebeb',
    minHeight: 77,
    paddingHorizontal: 16,
    justifyContent: 'flex-end',
  },
  expandButton: {
    padding: 4,
  },
});
