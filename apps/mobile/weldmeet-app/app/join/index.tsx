import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, Stack } from 'expo-router';
import { ArrowLeft, KeyRound } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useWeldmeetApi } from '@/services/app-api';

export default function JoinIndexScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { weldmeet } = useWeldmeetApi();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const onJoin = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const res = await weldmeet.getMeetingByJoinCode(trimmed);
      router.replace(`/meeting/${res.data.id}/room`);
    } catch (err) {
      Alert.alert(
        'Could not join',
        err instanceof Error ? err.message : 'Check the code and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <ArrowLeft size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Join meeting</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.body}>
        <View style={[styles.icon, { backgroundColor: '#7C3AED22' }]}>
          <KeyRound size={32} color="#7C3AED" />
        </View>
        <Text style={[styles.title, { color: colors.text }]}>Enter join code</Text>
        <Text style={[styles.subtitle, { color: colors.muted }]}>
          Ask the organizer for the meeting code.
        </Text>
        <TextInput
          value={code}
          onChangeText={setCode}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="ABC-123"
          placeholderTextColor={colors.muted}
          style={[styles.input, { color: colors.text, backgroundColor: colors.card, borderColor: colors.border }]}
        />
        <Pressable
          onPress={onJoin}
          disabled={busy || !code.trim()}
          style={({ pressed }) => [
            styles.joinBtn,
            { opacity: pressed || busy || !code.trim() ? 0.5 : 1 },
          ]}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.joinText}>Join</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 8 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '600', textAlign: 'center' },
  body: { flex: 1, padding: 24, alignItems: 'center', gap: 16 },
  icon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginTop: 32 },
  title: { fontSize: 24, fontWeight: '700' },
  subtitle: { fontSize: 14, textAlign: 'center', marginBottom: 16 },
  input: {
    width: '100%',
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
    letterSpacing: 4,
    paddingVertical: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  joinBtn: {
    width: '100%',
    backgroundColor: '#7C3AED',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  joinText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
