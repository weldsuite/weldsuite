import type { ColorValue } from 'react-native';
import { Tabs } from 'expo-router';
import { KeyRound, Settings, Vault, WandSparkles } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { brandFor } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';

type TabIconProps = { color: ColorValue; size: number };

const ItemsIcon = ({ color, size }: TabIconProps) => <KeyRound size={size} color={color} />;
const VaultsIcon = ({ color, size }: TabIconProps) => <Vault size={size} color={color} />;
const GeneratorIcon = ({ color, size }: TabIconProps) => <WandSparkles size={size} color={color} />;
const SettingsIcon = ({ color, size }: TabIconProps) => <Settings size={size} color={color} />;

export default function TabLayout() {
  const { colors, theme } = useTheme();
  const { t } = useI18n();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: brandFor(theme),
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.background, borderTopColor: colors.divider },
      }}
    >
      <Tabs.Screen name="index" options={{ title: t.tabs.items, tabBarIcon: ItemsIcon, tabBarButtonTestID: 'tab-items' }} />
      <Tabs.Screen name="vaults" options={{ title: t.tabs.vaults, tabBarIcon: VaultsIcon, tabBarButtonTestID: 'tab-vaults' }} />
      <Tabs.Screen
        name="generator"
        options={{ title: t.tabs.generator, tabBarIcon: GeneratorIcon, tabBarButtonTestID: 'tab-generator' }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: t.tabs.settings, tabBarIcon: SettingsIcon, tabBarButtonTestID: 'tab-settings' }}
      />
    </Tabs>
  );
}
