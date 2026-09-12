/**
 * Call-room route — thin shim for deep links.
 *
 * Incoming-call pushes now present Accept/Decline via CallContext (see
 * `incoming-call-bridge`). This route remains as a fallback for legacy
 * `/call-room?callId=…` links: fetch the call and present the ring UI
 * instead of silently auto-joining.
 */

import { useEffect, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useCall } from '@/contexts/CallContext';
import { appApi } from '@/services/app-api';
import { presentIncomingCallFromPush } from '@/lib/incoming-call-bridge';

export default function CallRoom() {
  const router = useRouter();
  const { callId } = useLocalSearchParams<{ callId?: string }>();
  const { session, status, expandCall } = useCall();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    const run = async () => {
      if (!session && callId && status === 'idle') {
        try {
          const { data: call } = await appApi.chatCalls.get(callId);
          if (call && (call.status === 'ringing' || call.status === 'active')) {
            presentIncomingCallFromPush({
              callId: call.id,
              channelId: call.channelId,
              callType: call.callType,
              callerName: call.initiatorName || 'Incoming call',
            });
          }
        } catch {
          // Call may already have ended.
        }
      }
      expandCall();
      if (router.canGoBack()) router.back();
      else router.replace('/(tabs)' as never);
    };

    void run();
  }, [session, callId, status, expandCall, router]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
});
