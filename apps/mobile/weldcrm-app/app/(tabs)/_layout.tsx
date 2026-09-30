import { Tabs } from 'expo-router';
import { Home, Users, UserPlus, CheckSquare, Settings } from 'lucide-react-native';
import type { ColorValue } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

type TabIconProps = { color: ColorValue; size: number };

const HomeTabIcon = ({ color, size }: TabIconProps) => <Home size={size} color={color} />;
const CustomersTabIcon = ({ color, size }: TabIconProps) => <Users size={size} color={color} />;
const LeadsTabIcon = ({ color, size }: TabIconProps) => <UserPlus size={size} color={color} />;
const TasksTabIcon = ({ color, size }: TabIconProps) => <CheckSquare size={size} color={color} />;
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
        name="customers"
        options={{
          title: 'Customers',
          tabBarIcon: CustomersTabIcon,
        }}
      />
      <Tabs.Screen
        name="leads"
        options={{
          title: 'Leads',
          tabBarIcon: LeadsTabIcon,
        }}
      />
      <Tabs.Screen
        name="tasks"
        options={{
          title: 'Tasks',
          tabBarIcon: TasksTabIcon,
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
