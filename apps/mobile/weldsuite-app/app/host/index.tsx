import { Redirect } from 'expo-router';

export default function HostIndex() {
  return <Redirect href="/host/(tabs)/domains" />;
}
