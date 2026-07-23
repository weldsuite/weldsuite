import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useWeldmeetApi } from '@/services/app-api';

export default function DeepJoinScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const { weldmeet } = useWeldmeetApi();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await weldmeet.getMeetingByJoinCode(code);
        if (cancelled) return;
        router.replace(`/meeting/${res.data.id}/room`);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Meeting not found.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, router, weldmeet]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      {error ? (
        <Text style={{ color: colors.muted }}>{error}</Text>
      ) : (
        <>
          <ActivityIndicator size="large" color="#7C3AED" />
          <Text style={[styles.text, { color: colors.muted }]}>Joining meeting…</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  text: { fontSize: 14 },
});
