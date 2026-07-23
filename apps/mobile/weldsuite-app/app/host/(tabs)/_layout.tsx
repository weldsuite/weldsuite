import { Tabs } from "expo-router";
import React from "react";
import { Globe, Plus, ExternalLink, Home } from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TouchableOpacity, Text, View, StyleSheet, Platform, UIManager } from 'react-native';
import { router } from 'expo-router';
import { useShouldShowMiniSidebar } from '@/components/layout/MiniSidebar';
import { CollapsibleHeaderProvider, useCollapsibleHeader } from '@/contexts/CollapsibleHeaderContext';

// LayoutAnimation on Android is handled by CollapsibleHeaderContext

function HostTabsContent() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const isTablet = useShouldShowMiniSidebar();
  const { isCollapsed } = useCollapsibleHeader();
  const HEADER_HEIGHT = 44;

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
          <Text style={[styles.headerTitle, { color: colors.text }]}>Host</Text>
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
          tabBarActiveTintColor: colors.text,
          tabBarInactiveTintColor: colors.muted,
          headerShown: false,
          tabBarStyle: {
            backgroundColor: colors.cardBackground,
            height: 50 + insets.bottom,
            paddingBottom: insets.bottom,
          },
          tabBarLabelStyle: {
            fontSize: 10,
            fontWeight: '600',
            marginTop: 2,
          },
          tabBarIconStyle: {
            marginBottom: 2,
          },
        }}
      >
        <Tabs.Screen
          name="domains"
          options={{
            title: "My Domains",
            tabBarIcon: ({ color }) => (
              <Globe size={20} color={color} strokeWidth={2} />
            ),
          }}
        />

        <Tabs.Screen
          name="register"
          options={{
            title: "Register",
            tabBarIcon: ({ color }) => (
              <Plus size={20} color={color} strokeWidth={2} />
            ),
          }}
        />

        <Tabs.Screen
          name="external"
          options={{
            title: "External",
            tabBarIcon: ({ color }) => (
              <ExternalLink size={20} color={color} strokeWidth={2} />
            ),
          }}
        />
      </Tabs>
    </View>
  );
}

export default function HostTabsLayout() {
  return (
    <CollapsibleHeaderProvider>
      <HostTabsContent />
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
