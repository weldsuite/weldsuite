import { Tabs } from 'expo-router';
import { Calendar, Clock, FileVideo, Settings } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

type TabIconProps = { color: string; size: number };

function CalendarTabIcon({ color, size }: Readonly<TabIconProps>) {
  return <Calendar size={size} color={color} />;
}

function ClockTabIcon({ color, size }: Readonly<TabIconProps>) {
  return <Clock size={size} color={color} />;
}

function FileVideoTabIcon({ color, size }: Readonly<TabIconProps>) {
  return <FileVideo size={size} color={color} />;
}

function SettingsTabIcon({ color, size }: Readonly<TabIconProps>) {
  return <Settings size={size} color={color} />;
}

export default function TabLayout() {
  const { colors } = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#7C3AED',
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.background, borderTopColor: colors.divider },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Upcoming', tabBarIcon: CalendarTabIcon }} />
      <Tabs.Screen name="history" options={{ title: 'History', tabBarIcon: ClockTabIcon }} />
      <Tabs.Screen name="recordings" options={{ title: 'Recordings', tabBarIcon: FileVideoTabIcon }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: SettingsTabIcon }} />
    </Tabs>
  );
}
