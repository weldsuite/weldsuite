import { Tabs } from 'expo-router';
import { Calendar, Clock, FileVideo, Settings } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

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
      <Tabs.Screen
        name="index"
        options={{
          title: 'Upcoming',
          tabBarIcon: ({ color, size }) => <Calendar size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'History',
          tabBarIcon: ({ color, size }) => <Clock size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="recordings"
        options={{
          title: 'Recordings',
          tabBarIcon: ({ color, size }) => <FileVideo size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => <Settings size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
