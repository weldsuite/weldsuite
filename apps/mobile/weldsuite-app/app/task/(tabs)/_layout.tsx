import { Tabs } from "expo-router";
import React from "react";
import { Home, CheckSquare, FolderKanban, Star } from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TouchableOpacity, Text, View, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useShouldShowMiniSidebar } from '@/components/layout/MiniSidebar';
import { CollapsibleHeaderProvider, useCollapsibleHeader } from '@/contexts/CollapsibleHeaderContext';

const HEADER_HEIGHT = 44;

function TaskTabsContent() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const isTablet = useShouldShowMiniSidebar();
  const { isCollapsed } = useCollapsibleHeader();

  const renderHeader = () => {
    // On mobile, make header collapsible
    if (!isTablet) {
      return (
        <View style={[
          styles.collapsibleHeader,
          {
            backgroundColor: colors.background,
            height: isCollapsed ? 0 : HEADER_HEIGHT,
          }
        ]}>
          {!isCollapsed && (
            <View style={styles.headerRow}>
              <TouchableOpacity
                onPress={() => router.replace('/(tabs)')}
                style={styles.homeButton}
              >
                <Home size={18} color="#374151" strokeWidth={2} />
                <Text style={styles.homeButtonText}>Home</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      );
    }

    // Tablet header (not collapsible)
    return (
      <View style={[styles.header, { backgroundColor: colors.background, paddingTop: insets.top + 12, borderBottomWidth: 1, borderBottomColor: '#ebebeb' }]}>
        <View style={styles.headerRow}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Tasks</Text>
        </View>
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: !isTablet ? insets.top : 0 }}>
      {/* Custom Header */}
      {renderHeader()}

      <Tabs
        screenOptions={{
          tabBarActiveTintColor: '#8B5CF6',
          tabBarInactiveTintColor: colors.muted,
          headerShown: false,
          tabBarStyle: {
            backgroundColor: colors.cardBackground,
            height: 50 + insets.bottom,
            paddingBottom: insets.bottom,
            display: isTablet ? 'none' : 'flex',
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
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Dashboard",
            tabBarIcon: ({ color }) => (
              <Home size={20} color={color} strokeWidth={2} />
            ),
          }}
        />

        <Tabs.Screen
          name="tasks"
          options={{
            title: "Tasks",
            tabBarIcon: ({ color }) => (
              <CheckSquare size={20} color={color} strokeWidth={2} />
            ),
          }}
        />

        <Tabs.Screen
          name="projects"
          options={{
            title: "Projects",
            tabBarIcon: ({ color }) => (
              <FolderKanban size={20} color={color} strokeWidth={2} />
            ),
          }}
        />

        <Tabs.Screen
          name="important"
          options={{
            title: "Important",
            tabBarIcon: ({ color }) => (
              <Star size={20} color={color} strokeWidth={2} />
            ),
          }}
        />
      </Tabs>
    </View>
  );
}

export default function TaskTabsLayout() {
  return (
    <CollapsibleHeaderProvider>
      <TaskTabsContent />
    </CollapsibleHeaderProvider>
  );
}

const styles = StyleSheet.create({
  collapsibleHeader: {
    overflow: 'hidden',
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  header: {
    borderBottomWidth: 0.5,
    borderBottomColor: '#E5E7EB',
    paddingBottom: 12,
    paddingHorizontal: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  homeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 9,
    gap: 6,
  },
  homeButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
});
