import { Tabs } from 'expo-router';
import { Home, LayoutGrid, Settings } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

type TabIconProps = { color: string; size: number };

const HomeTabIcon = ({ color, size }: TabIconProps) => <Home size={size} color={color} />;
const LayoutGridTabIcon = ({ color, size }: TabIconProps) => <LayoutGrid size={size} color={color} />;
const SettingsTabIcon = ({ color, size }: TabIconProps) => <Settings size={size} color={color} />;

export default function TabLayout() {
  const { colors } = useTheme();

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
          title: 'Home',
          tabBarIcon: HomeTabIcon,
        }}
      />
      <Tabs.Screen
        name="ui-gallery"
        options={{
          title: 'UI',
          tabBarIcon: LayoutGridTabIcon,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: SettingsTabIcon,
        }}
      />
    </Tabs>
  );
}
