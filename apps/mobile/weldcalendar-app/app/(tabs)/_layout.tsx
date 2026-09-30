import type { ComponentProps } from 'react';
import { Tabs } from 'expo-router';
import { CalendarDays, CalendarRange, LayoutGrid, MoreHorizontal } from 'lucide-react-native';
import type { ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  FloatingTabBar,
  floatingTabBarBottomInset,
  floatingTabBarScreenOptions,
  type FloatingTabBarProps,
} from '@/components/floating-tab-bar';
import { useI18n } from '@/lib/i18n';

type TabBarRenderer = NonNullable<ComponentProps<typeof Tabs>['tabBar']>;
type TabIconProps = { color: ColorValue; size: number };

const renderTabBar: TabBarRenderer = (props) => (
  <FloatingTabBar {...(props as unknown as FloatingTabBarProps)} />
);

function AgendaIcon({ color, size }: Readonly<TabIconProps>) {
  return <CalendarRange size={size} color={color} strokeWidth={2.2} />;
}

function MonthIcon({ color, size }: Readonly<TabIconProps>) {
  return <LayoutGrid size={size} color={color} strokeWidth={2.2} />;
}

function CalendarsIcon({ color, size }: Readonly<TabIconProps>) {
  return <CalendarDays size={size} color={color} strokeWidth={2.2} />;
}

function MoreIcon({ color, size }: Readonly<TabIconProps>) {
  return <MoreHorizontal size={size} color={color} strokeWidth={2.2} />;
}

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const tabBarInset = floatingTabBarBottomInset(insets.bottom);
  const { t } = useI18n();

  return (
    <Tabs
      tabBar={renderTabBar}
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
          tabBarIcon: AgendaIcon,
        }}
      />
      <Tabs.Screen
        name="month"
        options={{
          title: t.tabs.month,
          tabBarIcon: MonthIcon,
        }}
      />
      <Tabs.Screen
        name="calendars"
        options={{
          title: t.tabs.calendars,
          tabBarIcon: CalendarsIcon,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: t.tabs.more,
          tabBarIcon: MoreIcon,
        }}
      />
    </Tabs>
  );
}
