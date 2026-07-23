import { Stack } from 'expo-router';

export default function AppsLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="store" />
    </Stack>
  );
}
