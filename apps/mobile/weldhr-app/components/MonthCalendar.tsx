/**
 * The month that sits behind a sheet: pull the sheet down, tap a day, and
 * the screen jumps there. In `week` mode the chosen week is a tinted band;
 * today is always the filled blue square with a dot under its number. Both
 * have smooth (continuous) corners, and the band hugs the squares with the
 * same gap on every side.
 */

import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { usePalette } from '@/hooks/use-palette';
import { monthWeeks, startOfWeek, todayIso } from '@/lib/dates';
import { formatLongDay } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

/** A day's square, the row it sits in, and so the gap above and below it. */
const SQUARE = 40;
const DAY_HEIGHT = 46;
const GAP = (DAY_HEIGHT - SQUARE) / 2;

export function MonthCalendar({
  value,
  mode,
  onPick,
  max,
}: Readonly<{ value: string; mode: 'week' | 'day'; onPick: (iso: string) => void; max?: string }>) {
  const palette = usePalette();
  const { intlLocale } = useI18n();
  const today = todayIso();
  const month = value.slice(0, 7);
  const weeks = useMemo(() => monthWeeks(value), [value]);
  const selectedWeek = startOfWeek(value);
  // Monday-first two-letter weekdays in the app's language (2024-01-01 was a Monday).
  const weekdays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const short = new Date(2024, 0, 1 + i).toLocaleDateString(intlLocale, { weekday: 'short' }).slice(0, 2);
        return short.charAt(0).toUpperCase() + short.slice(1);
      }),
    [intlLocale],
  );
  // Days share the width, so a square has more room beside it than above it.
  // Pull the band in until the outer squares sit the same GAP from its ends.
  const [rowWidth, setRowWidth] = useState(0);
  const bandInset = rowWidth > 0 ? Math.max(0, (rowWidth / 7 - SQUARE) / 2 - GAP) : 0;

  return (
    <View style={styles.calendar}>
      <View style={styles.week} onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}>
        {weekdays.map((day, i) => (
          <Text key={`${day}-${i}`} style={[styles.weekday, { color: palette.muted }]}>
            {day}
          </Text>
        ))}
      </View>
      {weeks.map((week) => {
        const band = mode === 'week' && week[0] === selectedWeek;
        return (
          <View key={week[0]} style={[styles.week, styles.weekRow]}>
            {band ? (
              <View
                style={[styles.band, { left: bandInset, right: bandInset, backgroundColor: palette.calendarSoft }]}
              />
            ) : null}
            {week.map((iso) => {
              const outside = iso.slice(0, 7) !== month;
              const disabled = Boolean(max && iso > max);
              const isToday = iso === today;
              const filled = mode === 'day' ? iso === value : isToday;
              let color = palette.text;
              if (filled) color = '#FFFFFF';
              else if (outside || disabled) color = palette.muted;
              return (
                <Pressable
                  key={iso}
                  onPress={() => onPick(iso)}
                  disabled={disabled}
                  accessibilityRole="button"
                  accessibilityState={{ selected: mode === 'day' ? iso === value : band, disabled }}
                  accessibilityLabel={formatLongDay(iso, intlLocale)}
                  style={styles.day}
                >
                  <View style={[styles.dayInner, filled && { backgroundColor: palette.calendar }]}>
                    <Text
                      style={[
                        styles.dayText,
                        { color, opacity: disabled ? 0.4 : 1 },
                        outside && !filled && styles.dayOutside,
                      ]}
                    >
                      {Number(iso.slice(8))}
                    </Text>
                    {isToday ? (
                      <View style={[styles.todayDot, { backgroundColor: filled ? '#FFFFFF' : palette.calendar }]} />
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  calendar: { paddingHorizontal: 14, paddingTop: 14, paddingBottom: 18 },
  week: { flexDirection: 'row' },
  weekRow: { marginTop: 4 },
  // Concentric with the square: its radius plus the gap.
  band: { position: 'absolute', top: 0, bottom: 0, borderRadius: 14 + GAP, borderCurve: 'continuous' },
  weekday: { flex: 1, textAlign: 'center', fontSize: 15, paddingVertical: 6 },
  day: { flex: 1, height: DAY_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  dayInner: {
    width: SQUARE,
    height: SQUARE,
    borderRadius: 14,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayText: { fontSize: 18, fontWeight: '500', fontVariant: ['tabular-nums'] },
  dayOutside: { fontWeight: '400' },
  todayDot: { position: 'absolute', bottom: 4, width: 4, height: 4, borderRadius: 2 },
});
