import { Stack, router } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { TouchableOpacity } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';

export default function SettingsLayout() {
  const { colors } = useTheme();

  return (
    <Stack
      screenOptions={{
        headerStyle: {
          backgroundColor: colors.background,
        },
        headerTintColor: colors.text,
        headerTitleStyle: {
          fontWeight: '400',
        },
        headerShadowVisible: false,
        headerLeft: () => (
          <TouchableOpacity onPress={() => router.back()} style={{ padding: 4 }}>
            <ChevronLeft size={22} color={colors.text} strokeWidth={2} />
          </TouchableOpacity>
        ),
      }}
    >
      <Stack.Screen
        name="notifications"
        options={{
          title: 'Notification Preferences',
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="profile"
        options={{
          title: 'Edit Profile',
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="devices"
        options={{
          title: 'Registered Devices',
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="privacy"
        options={{
          title: 'Privacy & Data',
          headerShown: true,
        }}
      />
    </Stack>
  );
}
