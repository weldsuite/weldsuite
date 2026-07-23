import React from 'react';
import { View, Text, StyleSheet, Pressable, Linking } from 'react-native';
import { PlayCircle, Download } from 'lucide-react-native';
import { format } from 'date-fns';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import type { RecordingSummary } from '@weldsuite/core-api-client/schemas/weldmeet';

function formatDuration(seconds?: number | null): string {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function RecordingItem({ recording }: { recording: RecordingSummary }) {
  const { colors } = useTheme();
  const url = recording.recordingUrl;
  const open = () => {
    if (url) Linking.openURL(url);
  };

  return (
    <Pressable
      onPress={open}
      disabled={!url}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          opacity: pressed ? 0.7 : url ? 1 : 0.6,
        },
      ]}
    >
      <PlayCircle size={28} color="#7C3AED" />
      <View style={styles.body}>
        <Text style={[styles.title, { color: colors.text }]}>{recording.meetingTitle}</Text>
        <Text style={[styles.subtitle, { color: colors.muted }]}>
          {recording.startedAt
            ? format(new Date(recording.startedAt), 'MMM d, yyyy · h:mm a')
            : 'Pending…'}
          {' · '}
          {formatDuration(recording.duration)}
        </Text>
        {!url && (
          <Text style={[styles.subtitle, { color: colors.muted }]}>Recording still processing</Text>
        )}
      </View>
      <Download size={20} color={colors.muted} />
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
});
