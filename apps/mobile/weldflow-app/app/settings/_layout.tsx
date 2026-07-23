import { Stack, router } from 'expo-router';
import { TouchableOpacity } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

export default function SettingsLayout() {
  const { colors } = useTheme();

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '400' },
        headerShadowVisible: false,
        headerLeft: () => (
          <TouchableOpacity onPress={() => router.back()} style={{ padding: 4 }}>
            <ChevronLeft size={22} color={colors.text} strokeWidth={2} />
          </TouchableOpacity>
        ),
      }}
    >
      <Stack.Screen
        name="privacy"
        options={{ title: 'Privacy & Account', headerShown: true }}
      />
    </Stack>
  );
}
