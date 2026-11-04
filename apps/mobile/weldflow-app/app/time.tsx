/**
 * My time — the caller's own time entries for one Monday-to-Sunday week,
 * grouped by day with day and week totals (`GET /api/time-entries`).
 */

import { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { ChevronLeft, ChevronRight, Clock } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';

import { ACCENTS } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard, IconTile } from '@/components/detail';
import { RecordRow } from '@/components/record-row';
import { ErrorState, ListSkeleton } from '@/components/data-states';
import { useFormatMinutes } from '@/components/time-tracking';
import { useTimeEntries } from '@/hooks/use-weldflow';
import { useI18n } from '@/lib/i18n';
import {
  addDays,
  entryMinutes,
  fromDateKey,
  groupEntriesByDay,
  weekRange,
} from '@/lib/time-tracking';

/** A week of entries fits one page: the API caps a page at 500 rows. */
const WEEK_LIMIT = 500;

export default function MyTimeScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { t, format, intlLocale } = useI18n();
  const formatMinutes = useFormatMinutes();

  const currentWeek = useMemo(() => weekRange(new Date()), []);
  const [from, setFrom] = useState(currentWeek.from);
  const to = addDays(from, 6);
  const isCurrentWeek = from === currentWeek.from;

  const query = useTimeEntries({ fromDate: from, toDate: to, limit: WEEK_LIMIT });
  const days = useMemo(() => groupEntriesByDay(query.data?.data ?? []), [query.data]);
  const weekMinutes = days.reduce((sum, d) => sum + d.minutes, 0);

  const weekTitle = isCurrentWeek
    ? t.time.thisWeek
    : format(t.time.weekOf, {
        date: fromDateKey(from).toLocaleDateString(intlLocale, { day: 'numeric', month: 'short' }),
      });

  const shiftWeek = (weeks: number) => {
    void Haptics.selectionAsync();
    setFrom((f) => addDays(f, weeks * 7));
  };

  let body: React.ReactNode;
  if (query.isLoading) {
    body = <ListSkeleton count={5} />;
  } else if (query.isError) {
    body = <ErrorState onRetry={() => void query.refetch()} retrying={query.isRefetching} />;
  } else if (days.length === 0) {
    body = (
      <EmptyState
        icon={<Clock size={40} color={colors.mutedForeground} />}
        title={t.time.empty}
        description={t.time.emptyDescription}
      />
    );
  } else {
    body = days.map((day) => (
      <SectionCard
        key={day.date}
        title={fromDateKey(day.date).toLocaleDateString(intlLocale, {
          weekday: 'long',
          day: 'numeric',
          month: 'short',
        })}
        action={
          <Text style={[styles.dayTotal, { color: colors.mutedForeground }]}>
            {formatMinutes(day.minutes)}
          </Text>
        }
        padded={false}
      >
        {day.entries.map((entry) => {
          const canOpen = !!entry.projectId && !!entry.taskId;
          return (
            <RecordRow
              key={entry.id}
              leading={<IconTile icon={Clock} color={ACCENTS.tasks} />}
              title={entry.task?.title ?? entry.description ?? t.time.noTask}
              subtitle={entry.task?.title ? entry.description ?? undefined : undefined}
              meta={formatMinutes(entryMinutes(entry))}
              onPress={
                canOpen
                  ? () => router.push(`/task/${entry.projectId}/${entry.taskId}`)
                  : undefined
              }
            />
          );
        })}
      </SectionCard>
    ));
  }

  return (
    <Screen header={<ScreenHeader title={t.time.myTime} showBack />}>
      <View style={styles.weekBar}>
        <IconButton
          icon={<ChevronLeft size={22} color={colors.text} />}
          accessibilityLabel={t.time.previousWeek}
          onPress={() => shiftWeek(-1)}
        />
        <View style={styles.weekText}>
          <Text style={[styles.weekTitle, { color: colors.text }]}>{weekTitle}</Text>
          <Text style={[styles.weekTotal, { color: colors.mutedForeground }]}>
            {t.time.weekTotal} · {formatMinutes(weekMinutes)}
          </Text>
        </View>
        <IconButton
          icon={
            <ChevronRight
              size={22}
              color={isCurrentWeek ? colors.mutedForeground : colors.text}
            />
          }
          accessibilityLabel={t.time.nextWeek}
          onPress={() => shiftWeek(1)}
          disabled={isCurrentWeek}
        />
      </View>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />
        }
      >
        {body}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  weekBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  weekText: { flex: 1, alignItems: 'center' },
  weekTitle: { fontSize: 16, fontWeight: '600' },
  weekTotal: { fontSize: 13, marginTop: 2, fontVariant: ['tabular-nums'] },
  dayTotal: { fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  scroll: { paddingBottom: 24 },
});
