/**
 * The member's time off balances for this year, on the profile page: a card
 * (Grouped.tsx) with a row per leave type, a small ring for how much is left
 * and the days left on the right, and a sheet with the figures (allowance,
 * taken, waiting, left) when one is tapped.
 */

import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import type { HrLeaveBalance } from '@weldsuite/app-api-client/domains/weldhr';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';

import { solid } from '@/constants/brand';
import { usePalette } from '@/hooks/use-palette';
import { useLeave } from '@/hooks/use-weldhr-queries';
import { formatDays } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { Group, GroupRow, GROUPED_ICON } from './Grouped';
import { Card, DetailRow } from './Row';

/** Nothing while loading or when the workspace gives this member no leave types. */
export function LeaveBalances() {
  const leave = useLeave();
  const [balance, setBalance] = useState<HrLeaveBalance | null>(null);
  const balances = leave.data?.balances ?? [];
  if (balances.length === 0) return null;

  return (
    <>
      <Group>
        {balances.map((b) => (
          <BalanceRow key={b.leaveTypeId} balance={b} onPress={() => setBalance(b)} />
        ))}
      </Group>
      {balance ? <BalanceSheet balance={balance} onClose={() => setBalance(null)} /> : null}
    </>
  );
}

/** How much of the allowance is left, as a ring in the leave type's colour. */
function Ring({ fraction, color, size = GROUPED_ICON }: Readonly<{ fraction: number | null; color: string; size?: number }>) {
  const palette = usePalette();
  const stroke = 2.5;
  const radius = (size - stroke) / 2;
  const length = 2 * Math.PI * radius;
  const shown = fraction == null ? 1 : Math.min(1, Math.max(0, fraction));
  return (
    <Svg width={size} height={size}>
      <Circle cx={size / 2} cy={size / 2} r={radius} stroke={palette.tile} strokeWidth={stroke} fill="none" />
      {shown > 0 ? (
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${length * shown} ${length}`}
          rotation={-90}
          origin={`${size / 2}, ${size / 2}`}
        />
      ) : null}
    </Svg>
  );
}

function BalanceRow({ balance, onPress }: Readonly<{ balance: HrLeaveBalance; onPress: () => void }>) {
  const palette = usePalette();
  const { t, format, plural } = useI18n();
  const limited = balance.allowance != null && balance.remaining != null;
  // How full the ring is; none for a type without a limit.
  let fraction: number | null = null;
  if (limited) fraction = balance.allowance! > 0 ? balance.remaining! / balance.allowance! : 0;
  const remaining = limited ? format(t.absence.remaining, { amount: plural(balance.remaining!, t.balance.days) }) : t.balance.unlimited;
  return (
    <GroupRow
      leading={<Ring fraction={fraction} color={solid(balance.color)} />}
      title={balance.name}
      value={
        limited && balance.remaining! < 0 ? (
          <Text style={[styles.over, { color: palette.danger }]} numberOfLines={1}>
            {remaining}
          </Text>
        ) : (
          remaining
        )
      }
      onPress={onPress}
      chevron
    />
  );
}

/** A balance in figures: allowance, taken, waiting for approval, left. */
function BalanceSheet({ balance, onClose }: Readonly<{ balance: HrLeaveBalance; onClose: () => void }>) {
  const palette = usePalette();
  const { t, intlLocale } = useI18n();
  const days = (value: number | null) => (value == null ? t.balance.unlimited : formatDays(value, intlLocale));
  return (
    <Sheet visible onClose={onClose} title={balance.name} heightRatio={0.5}>
      <Card style={styles.sheetCard}>
        <DetailRow label={t.absence.allowance} value={days(balance.allowance)} />
        <DetailRow label={t.absence.taken} value={days(balance.used)} />
        <DetailRow label={t.absence.waiting} value={days(balance.pending)} />
        <DetailRow label={t.absence.left} value={days(balance.remaining)} />
      </Card>
      {balance.prorated ? <Text style={[styles.sheetNote, { color: palette.muted }]}>{t.balance.prorated}</Text> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // The row's value, in red when over the allowance.
  over: { flexShrink: 0, fontSize: 15, letterSpacing: 0, fontVariant: ['tabular-nums'] },
  sheetCard: { marginHorizontal: 0 },
  sheetNote: { fontSize: 13, marginTop: 10 },
});
