/**
 * Call-room route — now a thin shim.
 *
 * The call UI itself is a global overlay owned by <CallHost> (mounted in the
 * root layout), so it can survive navigation and be minimized. This route only
 * exists as the entry point for a push-notification tap, which deep-links to
 * `/call-room?callId=…`. We join that call (if we aren't already in one), make
 * sure the overlay is expanded, and immediately get out of the way so the
 * overlay — not a stacked screen — drives the experience.
 */

import { useEffect, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useCall } from '@/contexts/CallContext';

export default function CallRoom() {
  const router = useRouter();
  const { callId } = useLocalSearchParams<{ callId?: string }>();
  const { session, joinCallById, expandCall } = useCall();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    // Cold start (push tap): no session yet but a callId → join it.
    if (!session && callId) {
      joinCallById(callId).catch(() => {});
    }
    // Make sure the overlay is showing full-screen, not minimized.
    expandCall();

    // Hand off to the global overlay and leave the stack.
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)' as never);
  }, [session, callId, joinCallById, expandCall, router]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
});
