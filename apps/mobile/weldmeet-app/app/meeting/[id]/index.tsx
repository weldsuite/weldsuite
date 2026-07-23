import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { ArrowLeft, Video, Calendar, Hash, X } from 'lucide-react-native';
import { format } from 'date-fns';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useMeeting } from '@/hooks/useMeetings';
import { AttendeeList } from '@/components/AttendeeList';
import { useWeldmeetApi } from '@/services/app-api';

export default function MeetingDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { weldmeet } = useWeldmeetApi();
  const { data: meeting, loading, error, refresh } = useMeeting(id);
  const [busy, setBusy] = useState(false);

  const onJoin = () => {
    if (!meeting) return;
    router.push(`/meeting/${meeting.id}/room`);
  };

  const onCancel = () => {
    if (!meeting) return;
    const cancel = async (notify: boolean) => {
      setBusy(true);
      try {
        await weldmeet.cancelMeeting(meeting.id, notify);
      } catch (err) {
        Alert.alert('Could not cancel', err instanceof Error ? err.message : 'Please try again.');
      } finally {
        setBusy(false);
        refresh();
      }
    };
    Alert.alert('Cancel meeting', 'Notify attendees?', [
      { text: 'Back', style: 'cancel' },
      { text: 'Cancel without notice', style: 'destructive', onPress: () => cancel(false) },
      { text: 'Cancel & notify', onPress: () => cancel(true) },
    ]);
  };

  if (loading && !meeting) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color="#7C3AED" />
      </View>
    );
  }

  if (error || !meeting) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.muted }}>{error || 'Meeting not found'}</Text>
      </View>
    );
  }

  const cancelled = meeting.status === 'cancelled';
  const completed = meeting.status === 'completed';

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <ArrowLeft size={24} color={colors.text} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.title, { color: colors.text }]}>{meeting.title}</Text>
        {meeting.description && (
          <Text style={[styles.description, { color: colors.muted }]}>{meeting.description}</Text>
        )}

        <View style={[styles.metaCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {meeting.scheduledStart && (
            <View style={styles.metaRow}>
              <Calendar size={18} color={colors.muted} />
              <Text style={[styles.metaText, { color: colors.text }]}>
                {format(new Date(meeting.scheduledStart), 'EEE, MMM d · h:mm a')}
                {meeting.scheduledEnd && ` – ${format(new Date(meeting.scheduledEnd), 'h:mm a')}`}
              </Text>
            </View>
          )}
          <View style={styles.metaRow}>
            <Video size={18} color={colors.muted} />
            <Text style={[styles.metaText, { color: colors.text }]}>
              {meeting.meetingType === 'audio' ? 'Audio meeting' : 'Video meeting'}
            </Text>
          </View>
          <View style={styles.metaRow}>
            <Hash size={18} color={colors.muted} />
            <Text style={[styles.metaText, { color: colors.text }]}>Code · {meeting.joinCode}</Text>
          </View>
        </View>

        <Text style={[styles.sectionTitle, { color: colors.muted }]}>ATTENDEES</Text>
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <AttendeeList attendees={meeting.attendees ?? []} />
        </View>

        {!cancelled && !completed && (
          <Pressable
            onPress={onJoin}
            disabled={busy}
            style={({ pressed }) => [styles.joinBtn, { opacity: pressed || busy ? 0.7 : 1 }]}
          >
            <Video size={20} color="#fff" />
            <Text style={styles.joinText}>
              {meeting.status === 'in_progress' ? 'Join now' : 'Start meeting'}
            </Text>
          </Pressable>
        )}

        {cancelled && (
          <View style={styles.cancelledBanner}>
            <Text style={styles.cancelledText}>This meeting was cancelled.</Text>
          </View>
        )}

        {!cancelled && !completed && (
          <Pressable onPress={onCancel} disabled={busy} style={styles.cancelBtn}>
            <X size={18} color="#EF4444" />
            <Text style={styles.cancelText}>Cancel meeting</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { paddingHorizontal: 16, paddingBottom: 8 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: 16, paddingBottom: 64 },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 8 },
  description: { fontSize: 15, marginBottom: 16, lineHeight: 22 },
  metaCard: { borderRadius: 12, borderWidth: 1, padding: 16, gap: 12, marginBottom: 24 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  metaText: { fontSize: 15 },
  sectionTitle: { fontSize: 12, fontWeight: '600', letterSpacing: 0.5, marginBottom: 8 },
  section: { borderRadius: 12, borderWidth: 1, padding: 12, marginBottom: 24 },
  joinBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#7C3AED',
    paddingVertical: 16,
    borderRadius: 12,
    marginBottom: 12,
  },
  joinText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  cancelledBanner: {
    backgroundColor: '#FEF3C7',
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
  },
  cancelledText: { color: '#92400E', textAlign: 'center', fontWeight: '500' },
  cancelBtn: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, paddingVertical: 12 },
  cancelText: { color: '#EF4444', fontSize: 15, fontWeight: '500' },
});
