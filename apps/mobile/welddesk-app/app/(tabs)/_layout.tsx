import { Tabs } from 'expo-router';
import { Inbox, Settings } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  FloatingTabBar,
  floatingTabBarBottomInset,
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
          tabBarIcon: ({ color, size }) => <Inbox size={size} color={color} strokeWidth={2.2} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t.tabs.settings,
          tabBarIcon: ({ color, size }) => <Settings size={size} color={color} strokeWidth={2.2} />,
        }}
      />
    </Tabs>
  );
}
