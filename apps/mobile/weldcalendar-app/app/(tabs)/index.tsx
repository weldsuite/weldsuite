/**
 * WeldCalendar agenda — the home tab.
 *
 * A flat, day-grouped list of everything in the next two weeks, led by a KPI
 * strip. Reads `/api/calendar-events/range` rather than `/upcoming`: the
 * latter filters `startTime >= now` and `status = 'confirmed'`, so it would
 * hide the meeting you are sitting in and every tentative hold — and it takes
 * no `calendarIds`, so the Calendars tab's toggles would not apply.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { View, Text, SectionList, RefreshControl, StyleSheet } from 'react-native';
import { useObserve } from 'expo-observe';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { CalendarRange, Plus } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { useOrganization } from '@clerk/expo';

import { BRAND } from '@/lib/brand';
import { calendarPickerLabel } from '@/lib/calendar-access';
import {
  addDays,
  dayKey,
  endOfDay,
  groupByDay,
  isSameDay,
  relativeDayLabel,
  startOfDay,
} from '@/lib/date';
import { useCalendarVisibility } from '@/lib/calendar-visibility';
import { Screen, ScreenHeader } from '@/components/screen';
import { KpiCard, KpiGrid, KpiSkeletonGrid } from '@/components/kpi';
import { EventRow } from '@/components/event-row';
import { ErrorState, ListSkeleton } from '@/components/data-states';
import { useCalendars, useEventsInRange } from '@/hooks/use-weldcalendar';
import { useI18n } from '@/lib/i18n';
import { hideAppSplash } from '@/utils/splash';
import type { CalendarEvent } from '@/types/weldcalendar';

/** Two weeks is enough to answer "what's coming up" without a huge payload. */
const AGENDA_DAYS = 14;

export default function AgendaScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { markInteractive } = useObserve();
  const { organization } = useOrganization();
  const { t, intlLocale, plural } = useI18n();
  const { visibleIdsParam } = useCalendarVisibility();

  const calendarsQuery = useCalendars();
  const calendars = useMemo(() => calendarsQuery.data?.data ?? [], [calendarsQuery.data]);

  /**
   * Anchored to midnight so the key is stable for the whole day — a `new Date()`
   * in the query key would re-fetch on every render.
   */
  const range = useMemo(() => {
    const from = startOfDay(new Date());
    return {
      startDate: from.toISOString(),
      endDate: endOfDay(addDays(from, AGENDA_DAYS)).toISOString(),
      calendarIds: visibleIdsParam(calendars),
    };
    // `calendars` only changes identity when the list actually refetches.
  }, [calendars, visibleIdsParam]);

  // Held until the calendar list resolves: firing early would request the
  // unfiltered set and then visibly drop rows once the toggles are known.
  const eventsQuery = useEventsInRange(range, !calendarsQuery.isLoading);

  const events = useMemo(() => eventsQuery.data?.data ?? [], [eventsQuery.data]);

  const calendarNames = useMemo(
    () =>
      new Map(
        calendars.map((calendar) => [
          calendar.id,
          calendarPickerLabel(calendar, t.calendars.personal),
        ]),
      ),
    [calendars, t.calendars.personal],
  );

  const sections = useMemo(
    () => groupByDay<CalendarEvent>(events, (event) => event.startTime),
    [events],
  );

  const todayCount = useMemo(() => {
    const key = dayKey(new Date());
    return sections.find((section) => section.key === key)?.data.length ?? 0;
  }, [sections]);

  const weekCount = useMemo(() => {
    const limit = endOfDay(addDays(new Date(), 6)).getTime();
    return events.filter((event) => new Date(event.startTime).getTime() <= limit).length;
  }, [events]);

  const loading = calendarsQuery.isLoading || eventsQuery.isLoading;
  const refreshing = calendarsQuery.isRefetching || eventsQuery.isRefetching;
  const failed = calendarsQuery.isError || eventsQuery.isError;

  useEffect(() => {
    if (!loading) {
      hideAppSplash();
      markInteractive();
    }
  }, [loading, markInteractive]);

  const onRefresh = useCallback(() => {
    void calendarsQuery.refetch();
    void eventsQuery.refetch();
  }, [calendarsQuery, eventsQuery]);

  const navigate = useCallback(
    (route: string) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.push(route as never);
    },
    [router],
  );

  const header = (
    <ScreenHeader
      title={organization?.name || t.agenda.title}
      actions={
        <IconButton
          icon={<Plus size={22} color={colors.text} />}
          accessibilityLabel={t.agenda.newEvent}
          onPress={() => navigate('/event/new')}
        />
      }
    />
  );

  if (failed && !eventsQuery.data) {
    return (
      <Screen header={header}>
        <ErrorState message={t.agenda.loadError} onRetry={onRefresh} retrying={refreshing} />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <SectionList
        sections={sections}
        keyExtractor={(event) => event.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BRAND} />
        }
        ListHeaderComponent={
          loading && !eventsQuery.data ? (
            <KpiSkeletonGrid count={3} />
          ) : (
            <KpiGrid>
              <KpiCard
                label={t.agenda.today}
                value={String(todayCount)}
                sub={plural(todayCount, t.agenda.eventCount)}
              />
              <KpiCard
                label={t.agenda.next7Days}
                value={String(weekCount)}
                sub={plural(weekCount, t.agenda.eventCount)}
              />
              <KpiCard
                label={t.tabs.calendars}
                value={String(calendars.length)}
                sub={plural(calendars.length, t.agenda.calendarCount)}
                onPress={() => navigate('/(tabs)/calendars')}
              />
            </KpiGrid>
          )
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text
              style={[
                styles.sectionTitle,
                { color: isSameDay(section.date, new Date()) ? BRAND : colors.text },
              ]}
            >
              {relativeDayLabel(section.date, t.days, intlLocale)}
            </Text>
            <Text style={[styles.sectionCount, { color: colors.mutedForeground }]}>
              {plural(section.data.length, t.agenda.eventCount)}
            </Text>
          </View>
        )}
        renderItem={({ item }) => (
          <EventRow
            event={item}
            calendarName={calendars.length > 1 ? calendarNames.get(item.calendarId) : undefined}
            onPress={() => navigate(`/event/${item.id}`)}
          />
        )}
        ListEmptyComponent={
          loading ? (
            <ListSkeleton count={6} />
          ) : (
            <EmptyState
              icon={<CalendarRange size={32} color={colors.mutedForeground} />}
              title={t.agenda.emptyTitle}
              description={t.agenda.emptyDescription}
              style={styles.empty}
            />
          )
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 8, paddingBottom: 24, flexGrow: 1 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 22,
    paddingBottom: 6,
    gap: 12,
  },
  sectionTitle: { fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
  sectionCount: { fontSize: 12 },
  empty: { marginTop: 40 },
});
