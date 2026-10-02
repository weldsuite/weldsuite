import type { ComponentProps } from 'react';
import type { ColorValue } from 'react-native';
import { Tabs } from 'expo-router';
import { Inbox, Settings } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  FloatingTabBar,
  floatingTabBarBottomInset,
  floatingTabBarScreenOptions,
  type FloatingTabBarProps,
} from '@/components/floating-tab-bar';
import { useI18n } from '@/lib/i18n';

const renderTabBar: ComponentProps<typeof Tabs>['tabBar'] = (props) => (
  <FloatingTabBar {...(props as unknown as FloatingTabBarProps)} />
);

const InboxTabIcon = ({ color, size }: { color: ColorValue; size: number }) => (
  <Inbox size={size} color={color} strokeWidth={2.2} />
);

const SettingsTabIcon = ({ color, size }: { color: ColorValue; size: number }) => (
  <Settings size={size} color={color} strokeWidth={2.2} />
);

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
          title: t.tabs.inbox,
          tabBarIcon: InboxTabIcon,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t.tabs.settings,
          tabBarIcon: SettingsTabIcon,
        }}
      />
    </Tabs>
  );
}
