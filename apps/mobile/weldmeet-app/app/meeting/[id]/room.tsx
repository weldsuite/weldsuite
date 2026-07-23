import React, { useEffect } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Pressable, StatusBar } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import {
  RealtimeKitProvider,
  useRealtimeKitClient,
} from '@cloudflare/realtimekit-react-native';
import {
  RtkUIProvider,
  RtkMeeting,
  RtkWaitingScreen,
} from '@cloudflare/realtimekit-react-native-ui';
import { ArrowLeft } from 'lucide-react-native';
import { useMeetingSession } from '@/hooks/useMeetingSession';

export default function MeetingRoomScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session, loading, error, leave } = useMeetingSession(id);
  const [meeting, initMeeting] = useRealtimeKitClient();

  useEffect(() => {
    if (!session?.authToken) return;
    initMeeting({
      authToken: session.authToken,
      defaults: { audio: true, video: true },
    });
  }, [session?.authToken, initMeeting]);

  // When the SFU room ends or the user disconnects, leave the session and bounce back.
  useEffect(() => {
    if (!meeting) return;
    const handleLeft = async () => {
      await leave();
      router.back();
    };
    // RTK emits 'roomLeft' when the local user disconnects.
    meeting.self.on('roomLeft', handleLeft);
    return () => {
      meeting.self.off('roomLeft', handleLeft);
    };
  }, [meeting, leave, router]);

  if (error) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={styles.errorText}>{error}</Text>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <ArrowLeft size={20} color="#fff" />
          <Text style={styles.backText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  if (loading || !session) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator size="large" color="#7C3AED" />
        <Text style={styles.loadingText}>Connecting…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar hidden />
      {/* RealtimeKit ships nested copies of @cloudflare/realtimekit, so the value/meeting
        types diverge across packages. The runtime values are correct; cast to bridge them. */}
      <RealtimeKitProvider value={meeting as never} fallback={<RtkWaitingScreen />}>
        <RtkUIProvider>
          {meeting ? <RtkMeeting meeting={meeting as never} showSetupScreen /> : <RtkWaitingScreen />}
        </RtkUIProvider>
      </RealtimeKitProvider>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    padding: 24,
  },
  loadingText: { color: '#fff', fontSize: 14, marginTop: 8 },
  errorText: { color: '#fff', fontSize: 16, textAlign: 'center' },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#7C3AED',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 24,
    marginTop: 16,
  },
  backText: { color: '#fff', fontWeight: '600' },
});
