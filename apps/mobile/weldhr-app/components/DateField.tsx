/**
 * A date input that opens a month calendar in a sheet. Plain JS on purpose:
 * it looks the same on iOS, Android and the browser preview, and needs no
 * native date-picker module in the build.
 */

import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react-native';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { BRAND } from '@/constants/brand';
import { monthGrid, parseIsoDate, todayIso } from '@/lib/dates';
import { formatDay } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

interface DateFieldProps {
  label: string;
  value: string;
  onChange: (iso: string) => void;
  /** Earliest pickable day (inclusive). */
  min?: string;
  /** Latest pickable day (inclusive). */
  max?: string;
}

export function DateField({ label, value, onChange, min, max }: Readonly<DateFieldProps>) {
  const { colors } = useTheme();
  const { intlLocale } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${formatDay(value, intlLocale)}`}
        style={({ pressed }) => [
          styles.input,
          { backgroundColor: colors.inputBackground, opacity: pressed ? 0.8 : 1 },
        ]}
      >
        <Text style={[styles.value, { color: colors.text }]}>{formatDay(value, intlLocale)}</Text>
        <CalendarDays size={18} color={colors.mutedForeground} />
      </Pressable>
      {open ? (
        <Sheet visible={open} onClose={() => setOpen(false)} title={label} heightRatio={0.62}>
          <MonthCalendar
            value={value}
            min={min}
            max={max}
            onPick={(iso) => {
              onChange(iso);
              setOpen(false);
            }}
          />
        </Sheet>
      ) : null}
    </View>
  );
}

function MonthCalendar({
  value,
  min,
  max,
  onPick,
}: Readonly<{ value: string; min?: string; max?: string; onPick: (iso: string) => void }>) {
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const start = parseIsoDate(value) ?? new Date();
  const [cursor, setCursor] = useState({ year: start.getFullYear(), month: start.getMonth() });
  const today = todayIso();

  const weeks = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor]);
  const monthTitle = new Date(cursor.year, cursor.month, 1).toLocaleDateString(intlLocale, {
    month: 'long',
    year: 'numeric',
  });
  // Monday-first weekday initials in the app's language (2024-01-01 was a Monday).
  const weekdays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) =>
        new Date(2024, 0, 1 + i).toLocaleDateString(intlLocale, { weekday: 'narrow' }),
      ),
    [intlLocale],
  );

  const shift = (delta: number) =>
    setCursor(({ year, month }) => {
      const next = new Date(year, month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });

  return (
    <View style={styles.calendar}>
      <View style={styles.calendarHeader}>
        <Pressable onPress={() => shift(-1)} accessibilityLabel={t.calendar.previousMonth} hitSlop={10} style={styles.arrow}>
          <ChevronLeft size={22} color={colors.text} />
        </Pressable>
        <Text style={[styles.monthTitle, { color: colors.text }]}>{monthTitle}</Text>
        <Pressable onPress={() => shift(1)} accessibilityLabel={t.calendar.nextMonth} hitSlop={10} style={styles.arrow}>
          <ChevronRight size={22} color={colors.text} />
        </Pressable>
      </View>
      <View style={styles.week}>
        {weekdays.map((day, i) => (
          <Text key={`${day}-${i}`} style={[styles.weekday, { color: colors.mutedForeground }]}>
            {day}
          </Text>
        ))}
      </View>
      {weeks.map((week, w) => (
        <View key={w} style={styles.week}>
          {week.map((iso, d) => {
            if (!iso) return <View key={`empty-${d}`} style={styles.day} />;
            const disabled = Boolean((min && iso < min) || (max && iso > max));
            const selected = iso === value;
            const isToday = iso === today;
            return (
              <Pressable
                key={iso}
                disabled={disabled}
                onPress={() => onPick(iso)}
                accessibilityRole="button"
                accessibilityState={{ selected, disabled }}
                accessibilityLabel={formatDay(iso, intlLocale)}
                style={styles.day}
              >
                <View
                  style={[
                    styles.dayInner,
                    selected && { backgroundColor: BRAND },
                    !selected && isToday && { borderColor: BRAND, borderWidth: 1.5 },
                  ]}
                >
                  <Text
                    style={[
                      styles.dayText,
                      { color: selected ? '#fff' : disabled ? colors.placeholder : colors.text },
                      selected && styles.dayTextSelected,
                    ]}
                  >
                    {Number(iso.slice(8))}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}
      {(min && today < min) || (max && today > max) ? null : (
        <Pressable onPress={() => onPick(today)} style={styles.todayButton}>
          <Text style={[styles.todayText, { color: BRAND }]}>{t.calendar.today}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  label: { fontSize: 14, fontWeight: '500' },
  input: {
    minHeight: 46,
    borderRadius: 10,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  value: { fontSize: 16 },
  calendar: { gap: 4, paddingBottom: 8 },
  calendarHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  arrow: { padding: 6 },
  monthTitle: { fontSize: 17, fontWeight: '600', textTransform: 'capitalize' },
  week: { flexDirection: 'row' },
  weekday: { flex: 1, textAlign: 'center', fontSize: 12, fontWeight: '600', paddingVertical: 4 },
  day: { flex: 1, aspectRatio: 1, alignItems: 'center', justifyContent: 'center' },
  dayInner: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  dayText: { fontSize: 16 },
  dayTextSelected: { fontWeight: '700' },
  todayButton: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 16 },
  todayText: { fontSize: 15, fontWeight: '600' },
});
