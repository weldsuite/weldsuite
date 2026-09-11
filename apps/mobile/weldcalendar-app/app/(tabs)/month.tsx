/**
 * Month grid over a scrollable list of the selected day's events.
 *
 * The range request covers the WHOLE GRID, not the calendar month: the grid's
 * first and last rows spill into the neighbouring months, and fetching only
 * 1–31 would leave those squares dotless even though they have events.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, RefreshControl, StyleSheet } from 'react-native';
import { useObserve } from 'expo-observe';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';

import { BRAND } from '@/lib/brand';
import { calendarPickerLabel } from '@/lib/calendar-access';
import {
  addDays,
  addMonths,
  buildMonthMatrix,
  dayKey,
  endOfDay,
  formatMonthYear,
  isSameDay,
  relativeDayLabel,
  startOfDay,
} from '@/lib/date';
import { useCalendarVisibility } from '@/lib/calendar-visibility';
import { Screen, ScreenHeader } from '@/components/screen';
import { MonthGrid } from '@/components/month-grid';
import { EventRow } from '@/components/event-row';
import { ErrorState, ListSkeleton } from '@/components/data-states';
import { useCalendars, useEventsInRange } from '@/hooks/use-weldcalendar';
import { useI18n } from '@/lib/i18n';
import { hideAppSplash } from '@/utils/splash';

export default function MonthScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { markInteractive } = useObserve();
  const { t, intlLocale } = useI18n();
  const { visibleIdsParam } = useCalendarVisibility();

  const [month, setMonth] = useState(() => startOfDay(new Date()));
  const [selected, setSelected] = useState(() => startOfDay(new Date()));

  const calendarsQuery = useCalendars();
  const calendars = useMemo(() => calendarsQuery.data?.data ?? [], [calendarsQuery.data]);

  /**
   * Bounds of the rendered 6x7 grid, with a day of slack on each side so an
   * event sitting on a boundary is never missed by a timezone rounding edge.
   */
  const range = useMemo(() => {
    const weeks = buildMonthMatrix(month);
    const first = weeks[0][0];
    const last = weeks[weeks.length - 1][6];
    return {
      startDate: startOfDay(addDays(first, -1)).toISOString(),
      endDate: endOfDay(addDays(last, 1)).toISOString(),
      calendarIds: visibleIdsParam(calendars),
    };
  }, [month, calendars, visibleIdsParam]);

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

  const selectedKey = dayKey(selected);
  const dayEvents = useMemo(
    () =>
      events
        .filter((event) => dayKey(event.startTime) === selectedKey)
        .sort(
          (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
        ),
    [events, selectedKey],
  );

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

  const step = useCallback((delta: number) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setMonth((current) => addMonths(current, delta));
  }, []);

  /** Jumping to today only makes sense as "select it AND show its month". */
  const jumpToToday = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const today = startOfDay(new Date());
    setMonth(today);
    setSelected(today);
  }, []);

  const handleSelect = useCallback((date: Date) => {
    setSelected(date);
    // Tapping a spill-over square moves the grid to that month, matching the
    // platform: otherwise the selection would sit outside the visible month.
    setMonth((current) =>
      current.getMonth() === date.getMonth() && current.getFullYear() === date.getFullYear()
        ? current
        : date,
    );
  }, []);

  const navigate = useCallback(
    (route: string) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.push(route as never);
    },
    [router],
  );

  const header = (
    <ScreenHeader
      title={formatMonthYear(month, intlLocale)}
      actions={
        <>
          <IconButton
            icon={<ChevronLeft size={22} color={colors.text} />}
            accessibilityLabel={t.month.previousMonth}
            onPress={() => step(-1)}
          />
          <IconButton
            icon={<ChevronRight size={22} color={colors.text} />}
            accessibilityLabel={t.month.nextMonth}
            onPress={() => step(1)}
          />
          <IconButton
            icon={<Plus size={22} color={colors.text} />}
            accessibilityLabel={t.agenda.newEvent}
            onPress={() =>
              navigate(`/event/new?date=${encodeURIComponent(selectedKey)}`)
            }
          />
        </>
      }
    />
  );

  if (failed && !eventsQuery.data) {
    return (
      <Screen header={header}>
        <ErrorState message={t.month.loadError} onRetry={onRefresh} retrying={refreshing} />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <FlatList
        data={dayEvents}
        keyExtractor={(event) => event.id}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BRAND} />
        }
        ListHeaderComponent={
          <>
            <MonthGrid
              month={month}
              selected={selected}
              events={events}
              onSelect={handleSelect}
            />
            <View style={[styles.dayHeader, { borderTopColor: colors.border }]}>
              <Text style={[styles.dayTitle, { color: colors.text }]}>
                {relativeDayLabel(selected, t.days, intlLocale)}
              </Text>
              {!isSameDay(selected, new Date()) ? (
                <Text
                  style={[styles.todayLink, { color: BRAND }]}
                  onPress={jumpToToday}
                  accessibilityRole="button"
                >
                  {t.month.today}
                </Text>
              ) : null}
            </View>
          </>
        }
        renderItem={({ item }) => (
          <EventRow
            event={item}
            calendarName={calendars.length > 1 ? calendarNames.get(item.calendarId) : undefined}
            onPress={() => navigate(`/event/${item.id}`)}
          />
        )}
        ListEmptyComponent={
          loading && !eventsQuery.data ? (
            <ListSkeleton count={3} />
          ) : (
            <EmptyState
              icon={<CalendarDays size={32} color={colors.mutedForeground} />}
              title={t.month.noEventsTitle}
              description={t.month.noEventsDescription}
              style={styles.empty}
            />
          )
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 24 },
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 6,
    marginTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  dayTitle: { fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  todayLink: { fontSize: 14, fontWeight: '600' },
  empty: { marginTop: 24 },
});
