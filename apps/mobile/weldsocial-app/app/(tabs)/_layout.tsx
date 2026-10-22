import type { ColorValue } from 'react-native';
import { Tabs } from 'expo-router';
import { Home, Rows3, CalendarDays, BadgeCheck, Menu } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useI18n } from '@/lib/i18n';

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
          title: t.tabs.home,
          tabBarAccessibilityLabel: t.tabs.home,
          tabBarIcon: HomeIcon,
        }}
      />
      <Tabs.Screen
        name="queue"
        options={{
          title: t.tabs.queue,
          tabBarAccessibilityLabel: t.tabs.queue,
          tabBarIcon: QueueIcon,
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{
          title: t.tabs.calendar,
          tabBarAccessibilityLabel: t.tabs.calendar,
          tabBarIcon: CalendarIcon,
        }}
      />
      <Tabs.Screen
        name="approvals"
        options={{
          title: t.tabs.approvals,
          tabBarAccessibilityLabel: t.tabs.approvals,
          tabBarIcon: ApprovalsIcon,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: t.tabs.more,
          tabBarAccessibilityLabel: t.tabs.more,
          tabBarIcon: MoreIcon,
        }}
      />
    </Tabs>
  );
}
