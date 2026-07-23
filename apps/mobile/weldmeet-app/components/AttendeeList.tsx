import React from 'react';
import { View, Text, StyleSheet, Image } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import type { MeetingAttendee } from '@weldsuite/core-api-client/schemas/weldmeet';

const STATUS_LABEL: Record<MeetingAttendee['status'], string> = {
  pending: 'Invited',
  accepted: 'Going',
  declined: 'Not going',
  tentative: 'Maybe',
};

const STATUS_COLOR: Record<MeetingAttendee['status'], string> = {
  pending: '#9CA3AF',
  accepted: '#10B981',
  declined: '#EF4444',
  tentative: '#F59E0B',
};

function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function AttendeeList({ attendees }: { attendees: MeetingAttendee[] }) {
  const { colors } = useTheme();

  if (!attendees?.length) {
    return <Text style={[styles.empty, { color: colors.muted }]}>No attendees yet</Text>;
  }

  return (
    <View style={styles.container}>
      {attendees.map((a) => (
        <View key={a.userId || a.email} style={[styles.row, { borderBottomColor: colors.divider }]}>
          {a.avatar ? (
            <Image source={{ uri: a.avatar }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <Text style={styles.avatarText}>{initials(a.name || a.email)}</Text>
            </View>
          )}
          <View style={styles.body}>
            <Text style={[styles.name, { color: colors.text }]}>{a.name || a.email}</Text>
            <Text style={[styles.email, { color: colors.muted }]}>
              {a.role === 'organizer' ? 'Organizer' : a.email}
            </Text>
          </View>
          <Text style={[styles.status, { color: STATUS_COLOR[a.status] }]}>{STATUS_LABEL[a.status]}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 0.5 },
  avatar: { width: 36, height: 36, borderRadius: 18 },
  avatarFallback: { backgroundColor: '#7C3AED', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  body: { flex: 1 },
  name: { fontSize: 15, fontWeight: '500' },
  email: { fontSize: 13, marginTop: 1 },
  status: { fontSize: 13, fontWeight: '500' },
  empty: { fontSize: 14, fontStyle: 'italic', paddingVertical: 12 },
});
