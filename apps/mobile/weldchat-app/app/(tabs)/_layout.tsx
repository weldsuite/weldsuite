import { Tabs } from 'expo-router';
import { Home, MessagesSquare, AtSign, Phone } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  FloatingTabBar,
  floatingTabBarBottomInset,
  type FloatingTabBarProps,
} from '@/components/floating-tab-bar';
import { useIsTablet } from '@/hooks/useIsTablet';
import { useActivityUnreadCount } from '@/hooks/useActivityUnreadCount';
import { IPadLayout } from '@/components/IPadLayout';

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
          title: 'Home',
          tabBarIcon: ({ color, size }) => (
            <Home size={size} color={color} strokeWidth={2.2} />
          ),
        }}
      />
      <Tabs.Screen
        name="dms"
        options={{
          title: 'DMs',
          tabBarIcon: ({ color, size }) => (
            <MessagesSquare size={size} color={color} strokeWidth={2.2} />
          ),
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Mentions',
          tabBarIcon: ({ color, size }) => (
            <AtSign size={size} color={color} strokeWidth={2.2} />
          ),
          tabBarBadge: activityUnread > 0 ? activityUnread : undefined,
        }}
      />
      <Tabs.Screen
        name="calls"
        options={{
          title: 'Calls',
          tabBarIcon: ({ color, size }) => (
            <Phone size={size} color={color} strokeWidth={2.2} />
          ),
        }}
      />
    </Tabs>
  );
}
