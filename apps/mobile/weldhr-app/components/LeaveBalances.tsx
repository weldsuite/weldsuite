import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { HrLeaveBalance } from '@weldsuite/app-api-client/domains/weldhr';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { BRAND } from '@/constants/brand';
import { formatDays } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

/** Horizontally scrolling cards, one per leave type: days left with a fill bar. */
export function LeaveBalances({ balances }: Readonly<{ balances: HrLeaveBalance[] }>) {
  const { colors } = useTheme();
  const { t, format, intlLocale } = useI18n();

  if (balances.length === 0) {
    return <Text style={[styles.empty, { color: colors.mutedForeground }]}>{t.home.noBalances}</Text>;
  }

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {balances.map((balance) => {
        const color = balance.color || BRAND;
        const limited = balance.allowance != null && balance.remaining != null;
        const usedShare = limited && balance.allowance! > 0
          ? Math.min(1, (balance.used + balance.pending) / balance.allowance!)
          : 0;
        return (
          <View
            key={balance.leaveTypeId}
            style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <View style={styles.nameRow}>
              <View style={[styles.dot, { backgroundColor: color }]} />
              <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
                {balance.name}
              </Text>
            </View>
            {limited ? (
              <>
                <Text style={[styles.big, { color: colors.text }]}>{formatDays(balance.remaining!, intlLocale)}</Text>
                <Text style={[styles.sub, { color: colors.mutedForeground }]}>
                  {format(t.balance.ofAllowance, { days: formatDays(balance.allowance!, intlLocale) })}
                </Text>
                <View style={[styles.track, { backgroundColor: colors.inputBackground }]}>
                  <View style={[styles.fill, { backgroundColor: color, width: `${Math.round(usedShare * 100)}%` }]} />
                </View>
              </>
            ) : (
              <>
                <Text style={[styles.big, { color: colors.text }]}>∞</Text>
                <Text style={[styles.sub, { color: colors.mutedForeground }]}>{t.balance.unlimited}</Text>
              </>
            )}
            {balance.pending > 0 ? (
              <Text style={[styles.pending, { color: colors.mutedForeground }]}>
                {format(t.balance.pending, { days: formatDays(balance.pending, intlLocale) })}
              </Text>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: 10, paddingRight: 16 },
  empty: { fontSize: 14 },
  card: { width: 150, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  name: { fontSize: 13, fontWeight: '600', flex: 1 },
  big: { fontSize: 28, fontWeight: '700', fontVariant: ['tabular-nums'] },
  sub: { fontSize: 12 },
  track: { height: 5, borderRadius: 3, marginTop: 10, overflow: 'hidden' },
  fill: { height: 5, borderRadius: 3 },
  pending: { fontSize: 12, marginTop: 6 },
});
