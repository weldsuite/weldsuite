import { Tabs } from "expo-router";
import React, { useState, useEffect } from "react";
import { Home, FolderKanban, ListTodo, BarChart3 } from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TouchableOpacity, Text, View, StyleSheet, Dimensions, Platform } from 'react-native';
import { router } from 'expo-router';

// Hook for iPad detection
function useIsTablet() {
  const [isTablet, setIsTablet] = useState(false);

  useEffect(() => {
    const checkTablet = () => {
      const { width } = Dimensions.get('window');
      setIsTablet(Platform.OS === 'ios' && width >= 768);
    };

    checkTablet();
    const subscription = Dimensions.addEventListener('change', checkTablet);
    return () => subscription.remove();
  }, []);

  return isTablet;
}

export default function ProjectsTabsLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const isTablet = useIsTablet();

  const HeaderLeft = () => (
    <TouchableOpacity
      onPress={() => router.replace('/(tabs)')}
      style={styles.homeButton}
    >
      <Home size={18} color="#374151" strokeWidth={2} />
      <Text style={styles.homeButtonText}>Home</Text>
    </TouchableOpacity>
  );

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.muted,
        headerShown: !isTablet,
        headerStyle: {
          backgroundColor: colors.background,
          borderBottomWidth: 0.5,
          borderBottomColor: '#E5E7EB',
          height: 100,
        },
        headerShadowVisible: false,
        headerTintColor: colors.text,
        headerLeft: HeaderLeft,
        headerTitle: '',
        headerLeftContainerStyle: {
          paddingLeft: 16,
        },
        tabBarStyle: isTablet ? { display: 'none' } : {
          backgroundColor: colors.cardBackground,
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
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Projects",
          tabBarIcon: ({ color }) => (
            <FolderKanban size={20} color={color} strokeWidth={2} />
          ),
        }}
      />

      <Tabs.Screen
        name="tasks"
        options={{
          title: "Tasks",
          tabBarIcon: ({ color }) => (
            <ListTodo size={20} color={color} strokeWidth={2} />
          ),
        }}
      />

      <Tabs.Screen
        name="reports"
        options={{
          title: "Reports",
          tabBarIcon: ({ color }) => (
            <BarChart3 size={20} color={color} strokeWidth={2} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
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
});
