import { Stack } from 'expo-router';

export default function StoreLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="[appCode]" />
    </Stack>
  );
}
