/**
 * The one row shape every WeldCalendar list uses.
 *
 * Full-bleed like a messaging inbox, but led by a TIME COLUMN rather than an
 * icon tile: on an agenda the time is what the eye scans for, and a fixed-width
 * gutter keeps the titles aligned down the list. The coloured rule between the
 * time and the title carries the event's type colour.
 *
 * Cancelled events stay in the list (struck through and dimmed) instead of
 * being filtered out — a meeting that was called off is information, and the
 * platform grid shows them the same way.
 */

import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { MapPin, Users, Video } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { eventColor } from '@/lib/brand';
import { formatTime, isOngoing, isPastEvent } from '@/lib/date';
import { useI18n } from '@/lib/i18n';
import type { CalendarEvent } from '@/types/weldcalendar';

export interface EventRowProps {
  event: CalendarEvent;
  /** Name of the calendar it belongs to, when the list mixes several. */
  calendarName?: string;
  onPress?: () => void;
}

export function EventRow({ event, calendarName, onPress }: EventRowProps) {
  const { colors } = useTheme();
  const { t, intlLocale, plural } = useI18n();

  const accent = eventColor(event.color, event.type);
  const cancelled = event.status === 'cancelled';
  const past = !cancelled && isPastEvent(event.startTime, event.endTime);
  const live = !cancelled && isOngoing(event.startTime, event.endTime);
  const attendeeCount = event.attendees?.length ?? 0;

  const subtitleParts = [calendarName, event.location].filter(Boolean) as string[];

  const body = (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <View style={styles.timeCol}>
        {event.allDay ? (
          <Text
            style={[styles.allDay, { color: colors.mutedForeground }]}
            numberOfLines={2}
          >
            {t.agenda.allDay}
          </Text>
        ) : (
          <>
            <Text style={[styles.startTime, { color: colors.text }]} numberOfLines={1}>
              {formatTime(event.startTime, intlLocale)}
            </Text>
            {event.endTime ? (
              <Text style={[styles.endTime, { color: colors.mutedForeground }]} numberOfLines={1}>
                {formatTime(event.endTime, intlLocale)}
              </Text>
            ) : null}
          </>
        )}
      </View>

      <View style={[styles.rule, { backgroundColor: accent }, past && styles.dimmed]} />

      <View style={styles.main}>
        <Text
          style={[
            styles.title,
            { color: colors.text },
            cancelled && [styles.struck, { color: colors.mutedForeground }],
            past && styles.dimmed,
          ]}
          numberOfLines={2}
        >
          {event.title}
        </Text>

        {subtitleParts.length > 0 ? (
          <View style={styles.subtitleRow}>
            {event.location ? <MapPin size={12} color={colors.mutedForeground} /> : null}
            <Text
              style={[styles.subtitle, { color: colors.mutedForeground }]}
              numberOfLines={1}
            >
              {subtitleParts.join(' · ')}
            </Text>
          </View>
        ) : null}

        <View style={styles.metaRow}>
          {live ? (
            <View style={[styles.nowPill, { backgroundColor: accent }]}>
              <Text style={styles.nowText}>{t.agenda.now}</Text>
            </View>
          ) : null}
          {event.isVirtual || event.meetingUrl ? (
            <Video size={13} color={colors.mutedForeground} />
          ) : null}
          {attendeeCount > 0 ? (
            <View style={styles.attendees}>
              <Users size={13} color={colors.mutedForeground} />
              <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
                {plural(attendeeCount, t.event.attendeeCount)}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );

  if (!onPress) return body;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[
        event.title,
        event.allDay ? t.agenda.allDay : formatTime(event.startTime, intlLocale),
        calendarName,
      ]
        .filter(Boolean)
        .join(', ')}
      style={({ pressed }) => (pressed ? { backgroundColor: colors.pressed } : undefined)}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  timeCol: { width: 52, flexShrink: 0, paddingTop: 1 },
  startTime: { fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
  endTime: { fontSize: 13, marginTop: 1 },
  allDay: { fontSize: 12, fontWeight: '600' },
  rule: { width: 3, borderRadius: 2, flexShrink: 0 },
  dimmed: { opacity: 0.55 },
  main: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  struck: { textDecorationLine: 'line-through' },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  subtitle: { fontSize: 13, flexShrink: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  attendees: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: 12 },
  nowPill: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8 },
  nowText: { color: '#fff', fontSize: 10, fontWeight: '700', letterSpacing: 0.3 },
});
