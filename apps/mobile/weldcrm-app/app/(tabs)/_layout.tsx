import { Tabs } from 'expo-router';
import { Building2, CheckSquare, Home, Menu, Users } from 'lucide-react-native';
import type { ColorValue } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useI18n } from '@/lib/i18n';

type TabIconProps = { color: ColorValue; size: number };

const HomeTabIcon = ({ color, size }: TabIconProps) => <Home size={size} color={color} />;
const CompaniesTabIcon = ({ color, size }: TabIconProps) => <Building2 size={size} color={color} />;
const PeopleTabIcon = ({ color, size }: TabIconProps) => <Users size={size} color={color} />;
const TasksTabIcon = ({ color, size }: TabIconProps) => <CheckSquare size={size} color={color} />;
const MoreTabIcon = ({ color, size }: TabIconProps) => <Menu size={size} color={color} />;

/**
 * Home, Companies, People and Tasks, like the platform's WeldCRM sidebar; the
 * deal pipelines, notes, lists, sequences and settings sit under More.
 */
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
      <Tabs.Screen name="companies" options={{ title: t.tabs.companies, tabBarIcon: CompaniesTabIcon }} />
      <Tabs.Screen name="people" options={{ title: t.tabs.people, tabBarIcon: PeopleTabIcon }} />
      <Tabs.Screen name="tasks" options={{ title: t.tabs.tasks, tabBarIcon: TasksTabIcon }} />
      <Tabs.Screen name="more" options={{ title: t.tabs.more, tabBarIcon: MoreTabIcon }} />
    </Tabs>
  );
}
