import type { ColorValue } from 'react-native';
import { Tabs, useRouter } from 'expo-router';
import { LayoutDashboard, FileText, Camera, Receipt, MoreHorizontal } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  FloatingTabBar,
  floatingTabBarBottomInset,
  floatingTabBarScreenOptions,
  type FloatingTabBarProps,
} from '@/components/floating-tab-bar';
import { useI18n } from '@/lib/i18n';

type TabIconProps = { color: ColorValue; size: number };

function renderTabBar(props: unknown) {
  return <FloatingTabBar {...(props as FloatingTabBarProps)} />;
}

function HomeTabIcon({ color, size }: TabIconProps) {
  return <LayoutDashboard size={size} color={color} strokeWidth={2.2} />;
}

function InvoicesTabIcon({ color, size }: TabIconProps) {
  return <FileText size={size} color={color} strokeWidth={2.2} />;
}

function ScanTabIcon({ color, size }: TabIconProps) {
  return <Camera size={size} color={color} strokeWidth={2.2} />;
}

function ExpensesTabIcon({ color, size }: TabIconProps) {
  return <Receipt size={size} color={color} strokeWidth={2.2} />;
}

function MoreTabIcon({ color, size }: TabIconProps) {
  return <MoreHorizontal size={size} color={color} strokeWidth={2.2} />;
}

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
          tabBarIcon: HomeTabIcon,
        }}
      />
      <Tabs.Screen
        name="invoices"
        options={{
          title: t.tabs.invoices,
          tabBarIcon: InvoicesTabIcon,
        }}
      />
      <Tabs.Screen
        name="scan-placeholder"
        options={{
          title: t.tabs.scan,
          tabBarIcon: ScanTabIcon,
        }}
        listeners={{
          tabPress: (e) => {
            e.preventDefault();
            router.push('/scan');
          },
        }}
      />
      <Tabs.Screen
        name="expenses"
        options={{
          title: t.tabs.expenses,
          tabBarIcon: ExpensesTabIcon,
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
