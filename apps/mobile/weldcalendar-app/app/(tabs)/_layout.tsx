import { Tabs } from 'expo-router';
import { CalendarDays, CalendarRange, LayoutGrid, MoreHorizontal } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  FloatingTabBar,
  floatingTabBarBottomInset,
  floatingTabBarScreenOptions,
  type FloatingTabBarProps,
} from '@/components/floating-tab-bar';
import { useI18n } from '@/lib/i18n';

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const tabBarInset = floatingTabBarBottomInset(insets.bottom);
  const { t } = useI18n();

  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...(props as unknown as FloatingTabBarProps)} />}
      screenOptions={{
        ...floatingTabBarScreenOptions,
        headerShown: false,
        tabBarShowLabel: false,
        sceneStyle: {
          paddingBottom: tabBarInset,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t.tabs.agenda,
          tabBarIcon: ({ color, size }) => (
            <CalendarRange size={size} color={color} strokeWidth={2.2} />
          ),
        }}
      />
      <Tabs.Screen
        name="month"
        options={{
          title: t.tabs.month,
          tabBarIcon: ({ color, size }) => (
            <LayoutGrid size={size} color={color} strokeWidth={2.2} />
          ),
        }}
      />
      <Tabs.Screen
        name="calendars"
        options={{
          title: t.tabs.calendars,
          tabBarIcon: ({ color, size }) => (
            <CalendarDays size={size} color={color} strokeWidth={2.2} />
          ),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: t.tabs.more,
          tabBarIcon: ({ color, size }) => (
            <MoreHorizontal size={size} color={color} strokeWidth={2.2} />
          ),
        }}
      />
    </Tabs>
  );
}
