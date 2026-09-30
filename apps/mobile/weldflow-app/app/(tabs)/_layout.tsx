import { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import type { ColorValue } from 'react-native';
import {
  LayoutDashboard,
  FolderKanban,
  CheckSquare,
  MoreHorizontal,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  FloatingTabBar,
  floatingTabBarBottomInset,
  floatingTabBarScreenOptions,
  type FloatingTabBarProps,
} from '@/components/floating-tab-bar';
import { useI18n } from '@/lib/i18n';

type TabIconProps = { color: ColorValue; size: number };

type TabBarRenderProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

function renderTabBar(props: TabBarRenderProps) {
  return <FloatingTabBar {...(props as unknown as FloatingTabBarProps)} />;
}

function HomeTabIcon({ color, size }: TabIconProps) {
  return <LayoutDashboard size={size} color={color} strokeWidth={2.2} />;
}

function ProjectsTabIcon({ color, size }: TabIconProps) {
  return <FolderKanban size={size} color={color} strokeWidth={2.2} />;
}

function MyTasksTabIcon({ color, size }: TabIconProps) {
  return <CheckSquare size={size} color={color} strokeWidth={2.2} />;
}

function MoreTabIcon({ color, size }: TabIconProps) {
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
          title: t.tabs.home,
          tabBarIcon: HomeTabIcon,
        }}
      />
      <Tabs.Screen
        name="projects"
        options={{
          title: t.tabs.projects,
          tabBarIcon: ProjectsTabIcon,
        }}
      />
      <Tabs.Screen
        name="my-tasks"
        options={{
          title: t.tabs.myTasks,
          tabBarIcon: MyTasksTabIcon,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: t.tabs.more,
          tabBarIcon: MoreTabIcon,
        }}
      />
    </Tabs>
  );
}
