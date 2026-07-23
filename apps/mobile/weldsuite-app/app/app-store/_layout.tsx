import { Stack } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';

export default function AppStoreLayout() {
  const { colors } = useTheme();

  return (
    <Stack
      screenOptions={{
        headerStyle: {
          backgroundColor: colors.background,
        },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        headerBackTitle: 'Apps',
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="[appCode]"
        options={{
          title: 'App Details',
          headerShown: true,
        }}
      />
    </Stack>
  );
}
