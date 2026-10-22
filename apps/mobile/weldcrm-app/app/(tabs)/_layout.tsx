import { Tabs } from 'expo-router';
import { Home, Users, Target, UserPlus, CheckSquare, Settings } from 'lucide-react-native';
import type { ColorValue } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useI18n } from '@/lib/i18n';

type TabIconProps = { color: ColorValue; size: number };

const HomeTabIcon = ({ color, size }: TabIconProps) => <Home size={size} color={color} />;
const ContactsTabIcon = ({ color, size }: TabIconProps) => <Users size={size} color={color} />;
const DealsTabIcon = ({ color, size }: TabIconProps) => <Target size={size} color={color} />;
const LeadsTabIcon = ({ color, size }: TabIconProps) => <UserPlus size={size} color={color} />;
const TasksTabIcon = ({ color, size }: TabIconProps) => <CheckSquare size={size} color={color} />;
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
        tabBarLabelStyle: { fontSize: 11 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: t.tabs.home, tabBarIcon: HomeTabIcon }} />
      <Tabs.Screen name="contacts" options={{ title: t.tabs.contacts, tabBarIcon: ContactsTabIcon }} />
      <Tabs.Screen name="deals" options={{ title: t.tabs.deals, tabBarIcon: DealsTabIcon }} />
      <Tabs.Screen name="leads" options={{ title: t.tabs.leads, tabBarIcon: LeadsTabIcon }} />
      <Tabs.Screen name="tasks" options={{ title: t.tabs.tasks, tabBarIcon: TasksTabIcon }} />
      <Tabs.Screen name="settings" options={{ title: t.tabs.settings, tabBarIcon: SettingsTabIcon }} />
    </Tabs>
  );
}
