import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight, CalendarOff } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import type { SocialAccount, SocialPost } from '@weldsuite/app-api-client/domains/social';
import appApi from '@/services/app-api';
import { useAsyncData } from '@/hooks/use-async-data';
import { PostCard } from '@/components/PostCard';
import { toDayKey } from '@/lib/social';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface CalendarData {
  posts: SocialPost[];
  accounts: SocialAccount[];
}

/** Build the 6x7 grid of dates shown for a month (Monday-first). */
function buildMonthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  // getDay(): 0=Sun..6=Sat → Monday-first offset
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - offset);
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

export default function CalendarScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const today = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() });
  const [selectedDay, setSelectedDay] = useState(toDayKey(today));

  const fetcher = useCallback(async (): Promise<CalendarData> => {
    // Calendar view covers scheduled + published posts; both lists are capped
    // at the API max and merged client-side.
    const [scheduled, published, accountsRes] = await Promise.all([
      appApi.social.posts.list({ status: 'scheduled', limit: 100 }),
      appApi.social.posts.list({ status: 'published', limit: 100 }),
      appApi.social.accounts.list({ limit: 100 }),
    ]);
    return { posts: [...scheduled.data, ...published.data], accounts: accountsRes.data };
  }, []);

  const { data, loading, refreshing, error, refresh } = useAsyncData(fetcher);

  const accountsById = useMemo(
    () => new Map((data?.accounts ?? []).map((a) => [a.id, a])),
    [data?.accounts],
  );

  const postsByDay = useMemo(() => {
    const map = new Map<string, SocialPost[]>();
    for (const post of data?.posts ?? []) {
      const when = post.scheduledAt ?? post.publishedAt;
      if (!when) continue;
      const key = toDayKey(new Date(when));
      const bucket = map.get(key) ?? [];
      bucket.push(post);
      map.set(key, bucket);
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => {
        const aTime = a.scheduledAt ?? a.publishedAt ?? '';
        const bTime = b.scheduledAt ?? b.publishedAt ?? '';
        return aTime.localeCompare(bTime);
      });
    }
    return map;
  }, [data?.posts]);

  const grid = useMemo(() => buildMonthGrid(cursor.year, cursor.month), [cursor]);
  const monthLabel = new Date(cursor.year, cursor.month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
  const dayPosts = postsByDay.get(selectedDay) ?? [];
  const todayKey = toDayKey(today);
  // Parse the day key as LOCAL time — `new Date('YYYY-MM-DD')` is UTC and
  // would label the wrong weekday in negative-offset timezones.
  const [selY, selM, selD] = selectedDay.split('-').map(Number);
  const selectedDate = new Date(selY, selM - 1, selD);

  const shiftMonth = (delta: number) => {
    setCursor(({ year, month }) => {
      const d = new Date(year, month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={[styles.title, { color: colors.text }]}>Calendar</Text>
        <View style={styles.monthNav}>
          <TouchableOpacity onPress={() => shiftMonth(-1)} style={styles.navButton} accessibilityLabel="Previous month">
            <ChevronLeft size={20} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.monthLabel, { color: colors.text }]}>{monthLabel}</Text>
          <TouchableOpacity onPress={() => shiftMonth(1)} style={styles.navButton} accessibilityLabel="Next month">
            <ChevronRight size={20} color={colors.text} />
          </TouchableOpacity>
        </View>
      </View>

      {error && (
        <View style={styles.bannerWrap}>
          <Banner variant="error" title="Couldn't load calendar">{error}</Banner>
        </View>
      )}

      {loading && !data ? (
        <View style={styles.loading}>
          <Spinner label="Loading…" />
        </View>
      ) : (
        <ScrollView
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />}
          contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        >
          <View style={styles.weekdayRow}>
            {WEEKDAYS.map((day) => (
              <Text key={day} style={[styles.weekday, { color: colors.mutedForeground }]}>
                {day}
              </Text>
            ))}
          </View>

          <View style={styles.grid}>
            {grid.map((date) => {
              const key = toDayKey(date);
              const inMonth = date.getMonth() === cursor.month;
              const isSelected = key === selectedDay;
              const isToday = key === todayKey;
              const count = postsByDay.get(key)?.length ?? 0;
              return (
                <TouchableOpacity
                  key={key}
                  style={[
                    styles.cell,
                    isSelected && { backgroundColor: colors.primary, borderRadius: 10 },
                  ]}
                  onPress={() => setSelectedDay(key)}
                >
                  <Text
                    style={[
                      styles.cellText,
                      {
                        color: isSelected
                          ? colors.primaryForeground
                          : inMonth
                            ? colors.text
                            : colors.muted,
                        fontWeight: isToday || isSelected ? '700' : '400',
                      },
                    ]}
                  >
                    {date.getDate()}
                  </Text>
                  <View style={styles.dotRow}>
                    {count > 0 && (
                      <View
                        style={[
                          styles.dayDot,
                          { backgroundColor: isSelected ? colors.primaryForeground : colors.info },
                        ]}
                      />
                    )}
                    {count > 1 && (
                      <View
                        style={[
                          styles.dayDot,
                          { backgroundColor: isSelected ? colors.primaryForeground : colors.info },
                        ]}
                      />
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={styles.dayList}>
            <Text style={[styles.dayListTitle, { color: colors.text }]}>
              {selectedDate.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
            </Text>
            {dayPosts.length ? (
              <View style={{ gap: 10 }}>
                {dayPosts.map((post) => (
                  <PostCard
                    key={post.id}
                    post={post}
                    accountsById={accountsById}
                    onPress={() => router.push(`/post/${post.id}`)}
                  />
                ))}
              </View>
            ) : (
              <EmptyState
                icon={<CalendarOff size={36} color={colors.mutedForeground} />}
                title="No posts this day"
              />
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 12, gap: 8 },
  title: { fontSize: 34, fontWeight: '700' },
  monthNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navButton: { padding: 8 },
  monthLabel: { fontSize: 17, fontWeight: '600' },
  bannerWrap: { paddingHorizontal: 16, paddingTop: 8 },
  loading: { paddingTop: 64, alignItems: 'center' },
  weekdayRow: { flexDirection: 'row', paddingHorizontal: 12 },
  weekday: { flex: 1, textAlign: 'center', fontSize: 12, fontWeight: '600', marginBottom: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12, marginBottom: 16 },
  cell: { width: `${100 / 7}%`, aspectRatio: 0.9, alignItems: 'center', justifyContent: 'center' },
  cellText: { fontSize: 15 },
  dotRow: { flexDirection: 'row', gap: 2, height: 5, marginTop: 3 },
  dayDot: { width: 5, height: 5, borderRadius: 2.5 },
  dayList: { paddingHorizontal: 16 },
  dayListTitle: { fontSize: 18, fontWeight: '700', marginBottom: 10 },
});
