import type { ComponentProps } from 'react';
import type { ColorValue } from 'react-native';
import { Tabs, useRouter } from 'expo-router';
import { LayoutDashboard, Bot, Sparkles, Activity, MoreHorizontal } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  FloatingTabBar,
  floatingTabBarBottomInset,
  floatingTabBarScreenOptions,
  type FloatingTabBarProps,
} from '@/components/floating-tab-bar';
import { useI18n } from '@/lib/i18n';

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];
type TabIconProps = { color: ColorValue; size: number };

const renderTabBar = (props: TabBarProps) => (
  <FloatingTabBar {...(props as unknown as FloatingTabBarProps)} />
);
const renderHomeIcon = ({ color, size }: TabIconProps) => (
  <LayoutDashboard size={size} color={color} strokeWidth={2.2} />
);
const renderAgentsIcon = ({ color, size }: TabIconProps) => <Bot size={size} color={color} strokeWidth={2.2} />;
const renderNewChatIcon = ({ color, size }: TabIconProps) => (
  <Sparkles size={size} color={color} strokeWidth={2.2} />
);
const renderActivityIcon = ({ color, size }: TabIconProps) => (
  <Activity size={size} color={color} strokeWidth={2.2} />
);
const renderMoreIcon = ({ color, size }: TabIconProps) => (
  <MoreHorizontal size={size} color={color} strokeWidth={2.2} />
);

export default function TabLayout() {
  const router = useRouter();
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
          title: t.tabs.home,
          tabBarIcon: renderHomeIcon,
        }}
      />
      <Tabs.Screen
        name="agents"
        options={{
          title: t.tabs.agents,
          tabBarIcon: renderAgentsIcon,
        }}
      />
      <Tabs.Screen
        name="new-placeholder"
        options={{
          title: t.tabs.newChat,
          tabBarIcon: renderNewChatIcon,
        }}
        listeners={{
          tabPress: (e) => {
            e.preventDefault();
            router.push('/chat/new');
          },
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: t.tabs.activity,
          tabBarIcon: renderActivityIcon,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: t.tabs.more,
          tabBarIcon: renderMoreIcon,
        }}
      />
    </Tabs>
  );
}
