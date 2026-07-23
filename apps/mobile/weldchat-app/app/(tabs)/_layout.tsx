import { Tabs } from 'expo-router';
import { Home, MessagesSquare, AtSign, Phone } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import { useIsTablet } from '@/hooks/useIsTablet';
import { useActivityUnreadCount } from '@/hooks/useActivityUnreadCount';
import { IPadLayout } from '@/components/IPadLayout';

export default function TabLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const isTablet = useIsTablet();
  const activityUnread = useActivityUnreadCount();

  if (isTablet) {
    return <IPadLayout />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.bgPrimary,
          borderTopColor: colors.bgTertiary,
          borderTopWidth: 1,
          height: 56 + insets.bottom,
          paddingBottom: insets.bottom,
          paddingTop: 8,
        },
        tabBarActiveTintColor: colors.textPrimary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => <Home size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="dms"
        options={{
          title: 'DMs',
          tabBarIcon: ({ color, size }) => <MessagesSquare size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Mentions',
          tabBarIcon: ({ color, size }) => <AtSign size={size} color={color} />,
          tabBarBadge: activityUnread > 0 ? activityUnread : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.brand, fontSize: 10 },
        }}
      />
      <Tabs.Screen
        name="calls"
        options={{
          title: 'Calls',
          tabBarIcon: ({ color, size }) => <Phone size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
