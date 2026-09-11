/**
 * Edit an existing event.
 *
 * The form is keyed on the loaded event so its `useState` initialisers run
 * once the real values are in hand — `EventForm` seeds its state from
 * `initialValues` on mount, so without the key a form mounted during the
 * fetch would keep showing the defaults after the data arrived.
 */

import { useMemo } from 'react';
import { Alert, ScrollView, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { Screen, ScreenHeader } from '@/components/screen';
import { DetailSkeleton, ErrorState } from '@/components/data-states';
import { EventForm, toUpdateEventInput, type EventFormValues } from '@/components/EventForm';
import { canEditEvent, writableCalendars } from '@/lib/calendar-access';
import { useCalendars, useEvent, useUpdateEvent } from '@/hooks/use-weldcalendar';
import { useI18n } from '@/lib/i18n';

export default function EditEventScreen() {
  const router = useRouter();
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const { t } = useI18n();

  const eventQuery = useEvent(eventId);
  const calendarsQuery = useCalendars();
  const updateEvent = useUpdateEvent(eventId);

  const event = eventQuery.data?.data;
  const allCalendars = useMemo(() => calendarsQuery.data?.data ?? [], [calendarsQuery.data]);
  const calendars = useMemo(() => writableCalendars(allCalendars), [allCalendars]);

  const initialValues = useMemo<Partial<EventFormValues> | undefined>(() => {
    if (!event) return undefined;
    const start = new Date(event.startTime);
    return {
      calendarId: event.calendarId,
      title: event.title,
      description: event.description ?? '',
      type: event.type,
      start,
      // Open-ended events get a one-hour default so the picker has something
      // sane to show; the column is nullable but the form always writes a pair.
      end: event.endTime ? new Date(event.endTime) : new Date(start.getTime() + 60 * 60 * 1000),
      allDay: event.allDay ?? false,
      location: event.location ?? '',
      meetingUrl: event.meetingUrl ?? '',
      status: event.status,
      priority: event.priority ?? 'normal',
      notifyAttendees: false,
    };
  }, [event]);

  const handleSubmit = async (values: EventFormValues) => {
    try {
      await updateEvent.mutateAsync({
        data: toUpdateEventInput(values),
        sendNotification: values.notifyAttendees,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (err) {
      Alert.alert(
        t.event.updateFailed,
        err instanceof Error ? err.message : t.common.somethingWentWrong,
      );
    }
  };

  const header = <ScreenHeader title={t.event.editTitle} showBack />;

  if (eventQuery.isLoading || calendarsQuery.isLoading) {
    return (
      <Screen header={header}>
        <DetailSkeleton />
      </Screen>
    );
  }

  if (!event || eventQuery.isError) {
    return (
      <Screen header={header}>
        <ErrorState
          message={t.event.notFound}
          onRetry={() => void eventQuery.refetch()}
          retrying={eventQuery.isRefetching}
        />
      </Screen>
    );
  }

  // Someone can reach this route from a deep link (or after a share was
  // downgraded) without write access. The route would reject the PATCH; say so
  // here instead of letting them fill the form in first.
  if (!canEditEvent(event, allCalendars)) {
    return (
      <Screen header={header}>
        <ErrorState message={t.event.readOnlyHint} />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <EventForm
          key={event.id}
          mode="edit"
          calendars={calendars}
          initialValues={initialValues}
          onSubmit={handleSubmit}
          isSubmitting={updateEvent.isPending}
          hasAttendees={(event.attendees?.length ?? 0) > 0}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 48 },
});
