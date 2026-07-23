import { Redirect } from 'expo-router';

export default function HelpdeskIndex() {
  return <Redirect href="/helpdesk/(tabs)/inbox" />;
}
