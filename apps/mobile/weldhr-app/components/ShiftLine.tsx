import { StyleSheet, Text } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { toIsoDate } from '@/lib/dates';
import { formatDay, formatTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

/** "Tue 4 Mar · 09:00 – 17:30", in the phone's time zone. */
export function ShiftLine({ startsAt, endsAt }: Readonly<{ startsAt: string; endsAt: string }>) {
  const { colors } = useTheme();
  const { intlLocale } = useI18n();
  const start = new Date(startsAt);
  const day = Number.isNaN(start.getTime()) ? startsAt.slice(0, 10) : toIsoDate(start);
  return (
    <Text style={[styles.text, { color: colors.text }]}>
      {formatDay(day, intlLocale)} · {formatTime(startsAt, intlLocale)} – {formatTime(endsAt, intlLocale)}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: { fontSize: 15, fontWeight: '600' },
});
