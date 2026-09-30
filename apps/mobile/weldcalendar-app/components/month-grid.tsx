/**
 * Monday-first month grid with per-day event dots.
 *
 * Always six rows (see `buildMonthMatrix`) so the grid's height is identical
 * for every month — a grid that grows and shrinks under a fixed header reads
 * as a rendering glitch on a phone.
 *
 * Each day shows at most three dots plus a "+n" overflow count: more than that
 * and a 48px square turns into noise. The dots carry each event's own colour
 * so a busy day is still readable at a glance.
 */

import React, { useMemo } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { BRAND, eventColor } from '@/lib/brand';
import { buildMonthMatrix, dayKey, isSameDay, isSameMonth, weekdayInitials } from '@/lib/date';
import { useI18n } from '@/lib/i18n';
import type { CalendarEvent } from '@/types/weldcalendar';

const MAX_DOTS = 3;

/** Stable keys for the Monday-first weekday header cells. */
const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

interface DayDot {
  /** Unique within the grid: local day key + the event's ordinal on that day. */
  id: string;
  color: string;
}

interface DayFlags {
  isSelected: boolean;
  isCurrentDay: boolean;
  inMonth: boolean;
}

/** Colour of the day number: selected > today > in-month > outside-month. */
function dayTextColor(
  { isSelected, isCurrentDay, inMonth }: DayFlags,
  text: string,
  muted: string,
): string {
  if (isSelected) return '#fff';
  if (isCurrentDay) return BRAND;
  return inMonth ? text : muted;
}

export interface MonthGridProps {
  /** Any date inside the month to render. */
  month: Date;
  selected: Date;
  /** Events for (at least) the visible window, keyed internally by local day. */
  events: CalendarEvent[];
  onSelect: (date: Date) => void;
}

export function MonthGrid({ month, selected, events, onSelect }: Readonly<MonthGridProps>) {
  const { colors } = useTheme();
  const { intlLocale } = useI18n();

  const weeks = useMemo(() => buildMonthMatrix(month), [month]);
  const headers = useMemo(() => weekdayInitials(intlLocale), [intlLocale]);

  /** Day key → event colours, in start order, capped at what we can draw. */
  const dotsByDay = useMemo(() => {
    const map = new Map<string, { dots: DayDot[]; total: number }>();
    for (const event of events) {
      const key = dayKey(event.startTime);
      if (!key) continue;
      const entry = map.get(key) ?? { dots: [], total: 0 };
      if (entry.dots.length < MAX_DOTS) {
        entry.dots.push({ id: `${key}-${entry.total}`, color: eventColor(event.color, event.type) });
      }
      entry.total += 1;
      map.set(key, entry);
    }
    return map;
  }, [events]);

  const today = new Date();

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        {headers.map((label, index) => (
          <View key={WEEKDAY_KEYS[index]} style={styles.headerCell}>
            <Text style={[styles.headerText, { color: colors.mutedForeground }]}>{label}</Text>
          </View>
        ))}
      </View>

      {weeks.map((week) => (
        <View key={dayKey(week[0])} style={styles.week}>
          {week.map((date) => {
            const key = dayKey(date);
            const entry = dotsByDay.get(key);
            const inMonth = isSameMonth(date, month);
            const isSelected = isSameDay(date, selected);
            const isCurrentDay = isSameDay(date, today);
            const overflow = entry ? entry.total - entry.dots.length : 0;

            return (
              <Pressable
                key={key}
                onPress={() => onSelect(date)}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={date.toLocaleDateString(intlLocale, {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                })}
                style={styles.cell}
              >
                <View
                  style={[
                    styles.dayCircle,
                    isSelected && { backgroundColor: BRAND },
                    !isSelected && isCurrentDay && { borderColor: BRAND, borderWidth: 1.5 },
                  ]}
                >
                  <Text
                    style={[
                      styles.dayText,
                      {
                        color: dayTextColor(
                          { isSelected, isCurrentDay, inMonth },
                          colors.text,
                          colors.mutedForeground,
                        ),
                      },
                      !inMonth && !isSelected && styles.outsideMonth,
                      (isSelected || isCurrentDay) && styles.dayTextStrong,
                    ]}
                  >
                    {date.getDate()}
                  </Text>
                </View>

                <View style={styles.dotRow}>
                  {entry?.dots.map((dot) => (
                    <View
                      key={dot.id}
                      style={[
                        styles.dot,
                        { backgroundColor: dot.color },
                        !inMonth && styles.outsideMonth,
                      ]}
                    />
                  ))}
                  {overflow > 0 ? (
                    <Text style={[styles.overflow, { color: colors.mutedForeground }]}>
                      +{overflow}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 8 },
  headerRow: { flexDirection: 'row', paddingBottom: 4 },
  headerCell: { flex: 1, alignItems: 'center' },
  headerText: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  week: { flexDirection: 'row' },
  cell: { flex: 1, alignItems: 'center', paddingVertical: 3, minHeight: 46 },
  dayCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayText: { fontSize: 15 },
  dayTextStrong: { fontWeight: '700' },
  outsideMonth: { opacity: 0.35 },
  dotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    height: 8,
    marginTop: 1,
  },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
  overflow: { fontSize: 9, fontWeight: '600', marginLeft: 1 },
});
