/**
 * Event detail — the full record from `GET /api/calendar-events/:id`, with
 * edit and delete for calendars the user may write to.
 *
 * Read-only calendars still reach this screen (they are visible in the agenda),
 * so the actions are gated on `canEditEvent` and a banner explains why they
 * are missing rather than leaving the header mysteriously bare.
 */

import { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Linking, Pressable } from 'react-native';
import { useObserve } from 'expo-observe';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { ExternalLink, Pencil, Trash2 } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';

import { BRAND, eventColor } from '@/lib/brand';
import { canEditEvent } from '@/lib/calendar-access';
import {
  formatDuration,
  formatEventTimeRange,
  formatWeekdayDate,
  relativeDayLabel,
} from '@/lib/date';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard, DetailRow } from '@/components/detail';
import { DetailSkeleton, ErrorState } from '@/components/data-states';
import { EventPriorityBadge, EventStatusBadge, EventTypeChip } from '@/components/status-badge';
import { useCalendars, useDeleteEvent, useEvent } from '@/hooks/use-weldcalendar';
import { useI18n } from '@/lib/i18n';
import { hideAppSplash } from '@/utils/splash';

export default function EventDetailScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { markInteractive } = useObserve();
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const { t, intlLocale, plural } = useI18n();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data, isLoading, isError, refetch, isRefetching } = useEvent(eventId);
  const calendarsQuery = useCalendars();
  const deleteEvent = useDeleteEvent();

  const event = data?.data;
  const calendars = useMemo(() => calendarsQuery.data?.data ?? [], [calendarsQuery.data]);
  const calendar = useMemo(
    () => calendars.find((c) => c.id === event?.calendarId),
    [calendars, event?.calendarId],
  );
  const editable = event ? canEditEvent(event, calendars) : false;

  useEffect(() => {
    if (!isLoading) {
      hideAppSplash();
      markInteractive();
    }
  }, [isLoading, markInteractive]);

  if (isLoading) {
    return (
      <Screen header={<ScreenHeader title={t.event.detailTitle} showBack />}>
        <DetailSkeleton />
      </Screen>
    );
  }

  if (!event || isError) {
    return (
      <Screen header={<ScreenHeader title={t.appName} showBack />}>
        <ErrorState
          message={t.event.notFound}
          onRetry={() => void refetch()}
          retrying={isRefetching}
        />
      </Screen>
    );
  }

  const accent = eventColor(event.color, event.type);
  const attendees = event.attendees ?? [];
  const duration = event.allDay ? '' : formatDuration(event.startTime, event.endTime);

  const handleDelete = async () => {
    setConfirmDelete(false);
    try {
      await deleteEvent.mutateAsync({ id: event.id });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.event.deleteFailed);
    }
  };

  return (
    <Screen
      header={
        <ScreenHeader
          title={event.title}
          showBack
          actions={
            editable ? (
              <>
                <IconButton
                  icon={<Pencil size={20} color={colors.text} />}
                  accessibilityLabel={t.event.edit}
                  onPress={() => router.push(`/event/edit/${event.id}`)}
                />
                <IconButton
                  icon={<Trash2 size={20} color={colors.destructive} />}
                  accessibilityLabel={t.common.delete}
                  onPress={() => setConfirmDelete(true)}
                />
              </>
            ) : undefined
          }
        />
      }
    >
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.badgeRow}>
          <EventTypeChip type={event.type} />
          <EventStatusBadge status={event.status} />
          <EventPriorityBadge priority={event.priority} />
        </View>

        <View style={[styles.whenCard, { backgroundColor: colors.cardBackground }]}>
          <View style={[styles.whenRule, { backgroundColor: accent }]} />
          <View style={styles.whenText}>
            <Text style={[styles.whenDay, { color: colors.text }]}>
              {relativeDayLabel(event.startTime, t.days, intlLocale)}
            </Text>
            <Text style={[styles.whenTime, { color: colors.mutedForeground }]}>
              {formatEventTimeRange(event.startTime, event.endTime, {
                allDay: event.allDay,
                allDayLabel: t.agenda.allDay,
                locale: intlLocale,
              })}
              {duration ? ` · ${duration}` : ''}
            </Text>
          </View>
        </View>

        {!editable ? (
          <Banner variant="info" title={t.event.readOnly} style={styles.banner}>
            {t.event.readOnlyHint}
          </Banner>
        ) : null}

        {event.autoScheduled ? (
          <Banner variant="info" title={t.event.autoScheduled} style={styles.banner}>
            {t.event.autoScheduledHint}
          </Banner>
        ) : null}

        {event.description ? (
          <SectionCard title={t.event.description}>
            <Text style={[styles.bodyText, { color: colors.text }]}>{event.description}</Text>
          </SectionCard>
        ) : null}

        <SectionCard title={t.event.details}>
          <DetailRow label={t.event.calendar} value={calendar?.name ?? t.common.dash} />
          <DetailRow
            label={t.event.when}
            value={formatWeekdayDate(event.startTime, intlLocale)}
          />
          {event.location ? (
            <DetailRow label={t.event.location} value={event.location} />
          ) : null}
          {event.timezone ? (
            <DetailRow label={t.event.timezone} value={event.timezone} />
          ) : null}
        </SectionCard>

        {event.meetingUrl ? (
          <SectionCard title={t.event.meetingLink}>
            <Pressable
              onPress={() => void Linking.openURL(event.meetingUrl as string)}
              accessibilityRole="link"
              accessibilityLabel={t.event.joinMeeting}
              style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.7 }]}
            >
              <Text style={[styles.linkText, { color: BRAND }]} numberOfLines={1}>
                {t.event.joinMeeting}
              </Text>
              <ExternalLink size={16} color={BRAND} />
            </Pressable>
            <Text
              style={[styles.linkUrl, { color: colors.mutedForeground }]}
              numberOfLines={1}
            >
              {event.meetingUrl}
            </Text>
          </SectionCard>
        ) : null}

        {attendees.length > 0 ? (
          <SectionCard title={plural(attendees.length, t.event.attendeeCount)}>
            {attendees.map((attendee) => (
              <DetailRow
                key={attendee.email}
                label={attendee.name || attendee.email}
                value={attendee.name ? attendee.email : (attendee.status ?? t.common.dash)}
              />
            ))}
          </SectionCard>
        ) : null}

        {event.notes ? (
          <SectionCard title={t.event.notes}>
            <Text style={[styles.bodyText, { color: colors.text }]}>{event.notes}</Text>
          </SectionCard>
        ) : null}
      </ScrollView>

      <ConfirmModal
        visible={confirmDelete}
        title={t.event.deleteTitle}
        message={t.event.deleteMessage}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        variant="destructive"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 32 },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  whenCard: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 12,
    marginHorizontal: 12,
    marginTop: 12,
    padding: 14,
    borderRadius: 14,
  },
  whenRule: { width: 4, borderRadius: 2 },
  whenText: { flex: 1, minWidth: 0 },
  whenDay: { fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  whenTime: { fontSize: 14, marginTop: 3 },
  banner: { marginHorizontal: 12, marginTop: 12 },
  bodyText: { fontSize: 15, lineHeight: 21 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  linkText: { fontSize: 15, fontWeight: '600' },
  linkUrl: { fontSize: 12, marginTop: 2 },
});
