import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { ClipboardList, Package, Settings } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useI18n } from '@/lib/i18n';

type TabIconProps = { color: ColorValue; size: number };

const ProductsTabIcon = ({ color, size }: TabIconProps) => <Package size={size} color={color} />;
const PicksTabIcon = ({ color, size }: TabIconProps) => <ClipboardList size={size} color={color} />;
const SettingsTabIcon = ({ color, size }: TabIconProps) => <Settings size={size} color={color} />;

export default function TabLayout() {
  const { colors } = useTheme();
  const { t } = useI18n();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.background, borderTopColor: colors.divider },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t.tabs.products,
          tabBarIcon: ProductsTabIcon,
        }}
      />
      <Tabs.Screen
        name="picks"
        options={{
          title: t.tabs.picks,
          tabBarIcon: PicksTabIcon,
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
