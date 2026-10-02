import React, { useCallback, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Linking, ActivityIndicator } from 'react-native';
import { PlayCircle, Download, Clock, AlertCircle } from 'lucide-react-native';
import { format } from 'date-fns';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import type { RecordingSummary } from '@weldsuite/core-api-client/schemas/weldmeet';
import { useWeldmeetApi } from '@/services/app-api';
import {
  describeRecordingError,
  getRecordingDurationSeconds,
  getRecordingStateInfo,
} from '@/utils/recordings';

function formatDuration(seconds?: number | null): string {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function RecordingItem({ recording }: Readonly<{ recording: RecordingSummary }>) {
  const { colors } = useTheme();
  const { weldmeet } = useWeldmeetApi();
  const { playable, label } = getRecordingStateInfo(recording);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  // Recordings are private: the list carries state only, so a tokenized URL
  // (valid ~1 hour) is minted per tap and handed straight to the system. It is
  // never kept, a later tap mints a fresh one.
  const open = useCallback(async () => {
    if (!playable || busy.current) return;
    busy.current = true;
    setOpening(true);
    setError(null);
    try {
      const res = await weldmeet.getRecordingAccess(recording.sessionId);
      await Linking.openURL(res.data.url);
    } catch (err) {
      setError(describeRecordingError(err, 'Could not open the recording'));
    } finally {
      busy.current = false;
      setOpening(false);
    }
  }, [playable, weldmeet, recording.sessionId]);

  let leading = <PlayCircle size={28} color="#7C3AED" />;
  if (!playable) {
    const failed = recording.recordingStatus === 'failed';
    leading = failed ? (
      <AlertCircle size={28} color={colors.muted} />
    ) : (
      <Clock size={28} color={colors.muted} />
    );
  }

  let trailing: React.ReactNode = null;
  if (opening) trailing = <ActivityIndicator size="small" color="#7C3AED" />;
  else if (playable) trailing = <Download size={20} color={colors.muted} />;

  return (
    <Pressable
      onPress={open}
      disabled={!playable || opening}
      accessibilityRole={playable ? 'button' : undefined}
      accessibilityState={{ disabled: !playable, busy: opening }}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          opacity: pressed ? 0.7 : playable ? 1 : 0.6,
        },
      ]}
    >
      {leading}
      <View style={styles.body}>
        <Text style={[styles.title, { color: colors.text }]}>{recording.meetingTitle}</Text>
        <Text style={[styles.subtitle, { color: colors.muted }]}>
          {recording.startedAt
            ? format(new Date(recording.startedAt), 'MMM d, yyyy · h:mm a')
            : 'Pending…'}
          {' · '}
          {formatDuration(getRecordingDurationSeconds(recording))}
        </Text>
        {label && <Text style={[styles.subtitle, { color: colors.muted }]}>{label}</Text>}
        {error && <Text style={[styles.subtitle, styles.error]}>{error}</Text>}
      </View>
      {trailing}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    marginHorizontal: 16,
    marginVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  body: { flex: 1 },
  title: { fontSize: 15, fontWeight: '500' },
  subtitle: { fontSize: 13, marginTop: 2 },
  error: { color: '#DC2626' },
});
