import { Tabs, useRouter } from 'expo-router';
import { LayoutDashboard, Bot, Sparkles, Activity, MoreHorizontal } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  FloatingTabBar,
  floatingTabBarBottomInset,
  type FloatingTabBarProps,
} from '@/components/floating-tab-bar';
import { useI18n } from '@/lib/i18n';

export default function TabLayout() {
  const router = useRouter();
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
          title: t.tabs.home,
          tabBarIcon: ({ color, size }) => <LayoutDashboard size={size} color={color} strokeWidth={2.2} />,
        }}
      />
      <Tabs.Screen
        name="agents"
        options={{
          title: t.tabs.agents,
          tabBarIcon: ({ color, size }) => <Bot size={size} color={color} strokeWidth={2.2} />,
        }}
      />
      <Tabs.Screen
        name="new-placeholder"
        options={{
          title: t.tabs.newChat,
          tabBarIcon: ({ color, size }) => <Sparkles size={size} color={color} strokeWidth={2.2} />,
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
          tabBarIcon: ({ color, size }) => <Activity size={size} color={color} strokeWidth={2.2} />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: t.tabs.more,
          tabBarIcon: ({ color, size }) => <MoreHorizontal size={size} color={color} strokeWidth={2.2} />,
        }}
      />
    </Tabs>
  );
}
