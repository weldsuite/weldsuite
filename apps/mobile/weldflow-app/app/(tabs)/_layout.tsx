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
import { RunningTimerBar, RUNNING_TIMER_BAR_SPACE } from '@/components/time-tracking';
import { useRunningTimer } from '@/hooks/use-weldflow';
import { useI18n } from '@/lib/i18n';

type TabIconProps = { color: ColorValue; size: number };

type TabBarRenderProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

/** The floating tab bar, with the running-timer pill above it while a timer runs. */
function TabBar(props: Readonly<TabBarRenderProps>) {
  const insets = useSafeAreaInsets();
  return (
    <>
      <RunningTimerBar bottom={floatingTabBarBottomInset(insets.bottom) + 8} />
      <FloatingTabBar {...(props as unknown as FloatingTabBarProps)} />
    </>
  );
}

function renderTabBar(props: TabBarRenderProps) {
  return <TabBar {...props} />;
}

function HomeTabIcon({ color, size }: Readonly<TabIconProps>) {
  return <LayoutDashboard size={size} color={color} strokeWidth={2.2} />;
}

function ProjectsTabIcon({ color, size }: Readonly<TabIconProps>) {
  return <FolderKanban size={size} color={color} strokeWidth={2.2} />;
}

function MyTasksTabIcon({ color, size }: Readonly<TabIconProps>) {
  return <CheckSquare size={size} color={color} strokeWidth={2.2} />;
}

function MoreTabIcon({ color, size }: Readonly<TabIconProps>) {
  return <MoreHorizontal size={size} color={color} strokeWidth={2.2} />;
}

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const { data: timer } = useRunningTimer();
  // Make room for the running-timer pill so it never covers the last row.
  const tabBarInset =
    floatingTabBarBottomInset(insets.bottom) + (timer ? RUNNING_TIMER_BAR_SPACE : 0);
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
