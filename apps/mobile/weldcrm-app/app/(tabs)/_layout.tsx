import type { ComponentProps } from 'react';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Building2, CheckSquare, Home, MoreHorizontal, Users } from 'lucide-react-native';
import type { ColorValue } from 'react-native';
import {
  FloatingTabBar,
  floatingTabBarBottomInset,
  floatingTabBarScreenOptions,
  type FloatingTabBarProps,
} from '@weldsuite/mobile-ui/components/FloatingTabBar';
import { useI18n } from '@/lib/i18n';

type TabIconProps = { color: ColorValue; size: number };
type TabBarRenderProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

function renderTabBar(props: TabBarRenderProps) {
  return <FloatingTabBar {...(props as unknown as FloatingTabBarProps)} />;
}

const HomeTabIcon = ({ color, size }: TabIconProps) => <Home size={size} color={color} strokeWidth={2.2} />;
const CompaniesTabIcon = ({ color, size }: TabIconProps) => <Building2 size={size} color={color} strokeWidth={2.2} />;
const PeopleTabIcon = ({ color, size }: TabIconProps) => <Users size={size} color={color} strokeWidth={2.2} />;
const TasksTabIcon = ({ color, size }: TabIconProps) => <CheckSquare size={size} color={color} strokeWidth={2.2} />;
const MoreTabIcon = ({ color, size }: TabIconProps) => <MoreHorizontal size={size} color={color} strokeWidth={2.2} />;

/**
 * Home, Companies, People and Tasks, like the platform's WeldCRM sidebar; the
 * deal pipelines, notes, lists, sequences and settings sit under More. The
 * floating tab bar is the same chrome as the other WeldSuite apps.
 */
export default function TabLayout() {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      tabBar={renderTabBar}
      screenOptions={{
        ...floatingTabBarScreenOptions,
        headerShown: false,
        tabBarShowLabel: false,
        sceneStyle: { paddingBottom: floatingTabBarBottomInset(insets.bottom) },
      }}
    >
      <Tabs.Screen name="index" options={{ title: t.tabs.home, tabBarIcon: HomeTabIcon }} />
      <Tabs.Screen name="companies" options={{ title: t.tabs.companies, tabBarIcon: CompaniesTabIcon }} />
      <Tabs.Screen name="people" options={{ title: t.tabs.people, tabBarIcon: PeopleTabIcon }} />
      <Tabs.Screen name="tasks" options={{ title: t.tabs.tasks, tabBarIcon: TasksTabIcon }} />
      <Tabs.Screen name="more" options={{ title: t.tabs.more, tabBarIcon: MoreTabIcon }} />
    </Tabs>
  );
}
