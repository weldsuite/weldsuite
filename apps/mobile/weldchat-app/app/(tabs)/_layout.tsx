import type { ComponentProps } from 'react';
import type { ColorValue } from 'react-native';
import { Tabs } from 'expo-router';
import { Home, MessagesSquare, AtSign, Phone, type LucideIcon } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  FloatingTabBar,
  floatingTabBarBottomInset,
  floatingTabBarScreenOptions,
  type FloatingTabBarProps,
} from '@/components/floating-tab-bar';
import { useIsTablet } from '@/hooks/useIsTablet';
import { useActivityUnreadCount } from '@/hooks/useActivityUnreadCount';
import { IPadLayout } from '@/components/IPadLayout';

type TabBarRenderer = NonNullable<ComponentProps<typeof Tabs>['tabBar']>;

const renderTabBar: TabBarRenderer = (props) => (
  <FloatingTabBar {...(props as unknown as FloatingTabBarProps)} />
);

type TabIconProps = { color: ColorValue; size: number };

function makeTabIcon(Icon: LucideIcon) {
  return function TabIcon({ color, size }: TabIconProps) {
    return <Icon size={size} color={color} strokeWidth={2.2} />;
  };
}

const HomeTabIcon = makeTabIcon(Home);
const DmsTabIcon = makeTabIcon(MessagesSquare);
const MentionsTabIcon = makeTabIcon(AtSign);
const CallsTabIcon = makeTabIcon(Phone);

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const tabBarInset = floatingTabBarBottomInset(insets.bottom);
  const isTablet = useIsTablet();
  const activityUnread = useActivityUnreadCount();

  if (isTablet) {
    return <IPadLayout />;
  }

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
          title: 'Home',
          tabBarIcon: HomeTabIcon,
        }}
      />
      <Tabs.Screen
        name="dms"
        options={{
          title: 'DMs',
          tabBarIcon: DmsTabIcon,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Mentions',
          tabBarIcon: MentionsTabIcon,
          tabBarBadge: activityUnread > 0 ? activityUnread : undefined,
        }}
      />
      <Tabs.Screen
        name="calls"
        options={{
          title: 'Calls',
          tabBarIcon: CallsTabIcon,
        }}
      />
    </Tabs>
  );
}
