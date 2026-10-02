import type { ColorValue } from 'react-native';
import { Tabs } from 'expo-router';
import { Home, Rows3, CalendarDays, BadgeCheck, Menu } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

interface TabIconProps {
  color: ColorValue;
  size: number;
}

const HomeIcon = ({ color, size }: TabIconProps) => <Home size={size} color={color} />;
const QueueIcon = ({ color, size }: TabIconProps) => <Rows3 size={size} color={color} />;
const CalendarIcon = ({ color, size }: TabIconProps) => <CalendarDays size={size} color={color} />;
const ApprovalsIcon = ({ color, size }: TabIconProps) => <BadgeCheck size={size} color={color} />;
const MoreIcon = ({ color, size }: TabIconProps) => <Menu size={size} color={color} />;

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
          tabBarIcon: HomeIcon,
        }}
      />
      <Tabs.Screen
        name="queue"
        options={{
          title: 'Queue',
          tabBarIcon: QueueIcon,
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{
          title: 'Calendar',
          tabBarIcon: CalendarIcon,
        }}
      />
      <Tabs.Screen
        name="approvals"
        options={{
          title: 'Approvals',
          tabBarIcon: ApprovalsIcon,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: MoreIcon,
        }}
      />
    </Tabs>
  );
}
