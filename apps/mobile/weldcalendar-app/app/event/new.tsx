/**
 * New event.
 *
 * Accepts an optional `?date=YYYY-MM-DD` so the Month tab can hand over the
 * day the user was looking at — landing on "today" after they tapped the 19th
 * would be quietly wrong.
 */

import { useMemo } from 'react';
import { Alert, ScrollView, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { Screen, ScreenHeader } from '@/components/screen';
import { DetailSkeleton, ErrorState } from '@/components/data-states';
import { EventForm, toCreateEventInput, type EventFormValues } from '@/components/EventForm';
import { useCalendars, useCreateEvent } from '@/hooks/use-weldcalendar';
import { useI18n } from '@/lib/i18n';
import { writableCalendars } from '@/lib/calendar-access';

/**
 * 09:00 on the chosen day, or the next whole hour when that day is today —
 * scheduling "today at 09:00" at 4pm is never what the tap meant.
 */
function startForDate(dateParam: string | undefined): Date {
  const now = new Date();
  const match = dateParam?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    const next = new Date(now);
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return next;
  }

  const [, year, month, day] = match;
  const target = new Date(Number(year), Number(month) - 1, Number(day), 9, 0, 0, 0);
  const isToday =
    target.getFullYear() === now.getFullYear() &&
    target.getMonth() === now.getMonth() &&
    target.getDate() === now.getDate();
  if (isToday && now.getHours() >= 9) {
    const next = new Date(now);
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return next;
  }
  return target;
}

export default function NewEventScreen() {
  const router = useRouter();
  const { date } = useLocalSearchParams<{ date?: string }>();
  const { t } = useI18n();

  const calendarsQuery = useCalendars();
  const createEvent = useCreateEvent();

  const calendars = useMemo(
    () => writableCalendars(calendarsQuery.data?.data ?? []),
    [calendarsQuery.data],
  );

  const start = useMemo(() => startForDate(date), [date]);

  const handleSubmit = async (values: EventFormValues) => {
    try {
      await createEvent.mutateAsync(toCreateEventInput(values));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (err) {
      Alert.alert(
        t.event.createFailed,
        err instanceof Error ? err.message : t.common.somethingWentWrong,
      );
    }
  };

  const header = <ScreenHeader title={t.event.newTitle} showBack />;

  if (calendarsQuery.isLoading) {
    return (
      <Screen header={header}>
        <DetailSkeleton />
      </Screen>
    );
  }

  if (calendarsQuery.isError) {
    return (
      <Screen header={header}>
        <ErrorState
          message={t.calendars.loadError}
          onRetry={() => void calendarsQuery.refetch()}
          retrying={calendarsQuery.isRefetching}
        />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <EventForm
          mode="create"
          calendars={calendars}
          initialValues={{ start, end: new Date(start.getTime() + 60 * 60 * 1000) }}
          onSubmit={handleSubmit}
          isSubmitting={createEvent.isPending}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 48 },
});
