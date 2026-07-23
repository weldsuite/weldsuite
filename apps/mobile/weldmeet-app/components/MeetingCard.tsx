import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Video, Mic, Users, Circle } from 'lucide-react-native';
import { format, isToday, isTomorrow } from 'date-fns';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import type { Meeting } from '@weldsuite/core-api-client/schemas/weldmeet';

interface Props {
  meeting: Meeting;
  onPress: () => void;
}

function formatTime(iso?: string | null): string {
  if (!iso) return 'No time';
  const d = new Date(iso);
  const time = format(d, 'h:mm a');
  if (isToday(d)) return `Today, ${time}`;
  if (isTomorrow(d)) return `Tomorrow, ${time}`;
  return `${format(d, 'MMM d')}, ${time}`;
}

export function MeetingCard({ meeting, onPress }: Props) {
  const { colors } = useTheme();
  const Icon = meeting.meetingType === 'audio' ? Mic : Video;
  const live = meeting.status === 'in_progress';

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <View style={[styles.icon, { backgroundColor: live ? '#EF4444' : '#7C3AED22' }]}>
        <Icon size={20} color={live ? '#fff' : '#7C3AED'} />
      </View>
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>
            {meeting.title}
          </Text>
          {live && (
            <View style={styles.liveBadge}>
              <Circle size={8} color="#fff" fill="#fff" />
              <Text style={styles.liveText}>LIVE</Text>
            </View>
          )}
        </View>
        <Text style={[styles.subtitle, { color: colors.muted }]}>
          {formatTime(meeting.scheduledStart)}
        </Text>
        <View style={styles.meta}>
          <Users size={12} color={colors.muted} />
          <Text style={[styles.metaText, { color: colors.muted }]}>
            {meeting.attendees?.length ?? 0} attendee{(meeting.attendees?.length ?? 0) === 1 ? '' : 's'}
          </Text>
          <Text style={[styles.metaText, { color: colors.muted }]}>·</Text>
          <Text style={[styles.metaText, { color: colors.muted }]}>{meeting.joinCode}</Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    gap: 12,
    padding: 12,
    marginHorizontal: 16,
    marginVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '600', flex: 1 },
  subtitle: { fontSize: 13 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  metaText: { fontSize: 12 },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#EF4444',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  liveText: { color: '#fff', fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
});
