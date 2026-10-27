import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Check } from 'lucide-react-native';
import type { HrLeaveBalance, HrSelfLeave } from '@weldsuite/app-api-client/domains/weldhr';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { DateField } from '@/components/DateField';
import { LeaveTypeTile } from '@/components/HrRows';
import { ListSkeleton } from '@/components/QueryBody';
import { ErrorNote, Screen } from '@/components/Screen';
import { tint } from '@/constants/brand';
import { usePalette } from '@/hooks/use-palette';
import { useLeave, useMe, useRequestLeave } from '@/hooks/use-weldhr-queries';
import { nextWeekday, todayIso, weekdaysBetween } from '@/lib/dates';
import { formatDays } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { balanceForStart, checkAllowance, type AllowanceCheck } from '@/lib/leave';

export default function NewLeaveScreen() {
  const { t } = useI18n();
  const me = useMe();
  const leave = useLeave();

  return (
    <Screen title={t.leaveForm.title} variant="modal">
      <NewLeaveBody turnedOff={me.data?.features.leaveRequests === false} leave={leave} />
    </Screen>
  );
}

function NewLeaveBody({ turnedOff, leave }: Readonly<{ turnedOff: boolean; leave: ReturnType<typeof useLeave> }>) {
  const { t } = useI18n();
  if (leave.isPending) return <ListSkeleton count={3} />;
  if (turnedOff) return <Banner variant="info">{t.timeOff.turnedOff}</Banner>;
  if (leave.isError || !leave.data) return <ErrorNote message={t.common.somethingWrong} />;
  return <LeaveForm data={leave.data} />;
}

function LeaveForm({ data }: Readonly<{ data: HrSelfLeave }>) {
  const palette = usePalette();
  const { t, plural } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const request = useRequestLeave();

  // Most requests are for the next working day or later.
  const today = todayIso();
  const firstDay = nextWeekday(today);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(firstDay);
  const [endDate, setEndDate] = useState(firstDay);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const types = data.types;
  // One type is the common case (holiday); pick it so the form is one tap shorter.
  useEffect(() => {
    if (!typeId && types.length === 1) setTypeId(types[0].id);
  }, [typeId, types]);

  const type = types.find((candidate) => candidate.id === typeId);
  const balance = balanceForStart(data.balances, typeId, startDate, today);
  const days = useMemo(() => weekdaysBetween(startDate, endDate), [startDate, endDate]);
  const allowance = checkAllowance(balance, days);
  const blocked = allowance.kind === 'over' && allowance.blocked;

  const submit = () => {
    setError(null);
    if (!typeId) return setError(t.leaveForm.chooseType);
    if (endDate < startDate) return setError(t.leaveForm.endBeforeStart);
    request.mutate(
      { leaveTypeId: typeId, startDate, endDate, reason: reason.trim() || null },
      {
        onSuccess: ({ data: created }) => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          toast.success(created.status === 'approved' ? t.leaveForm.approved : t.leaveForm.sent);
          router.back();
        },
        onError: (err) => setError((err as Error).message || t.common.somethingWrong),
      },
    );
  };

  return (
    <View style={styles.form}>
      <TypePicker
        types={types}
        balances={startDate.slice(0, 4) === today.slice(0, 4) ? data.balances : []}
        value={typeId}
        onChange={setTypeId}
      />

      <View style={styles.dates}>
        <View style={styles.date}>
          <DateField
            label={t.leaveForm.from}
            value={startDate}
            onChange={(next) => {
              setStartDate(next);
              if (endDate < next) setEndDate(next);
            }}
          />
        </View>
        <View style={styles.date}>
          <DateField label={t.leaveForm.to} value={endDate} min={startDate} onChange={setEndDate} />
        </View>
      </View>
      <Text style={[styles.hint, { color: palette.muted }]}>{plural(days, t.leaveForm.estimate)}</Text>

      <AllowanceBanner allowance={allowance} />

      <Textarea
        label={t.leaveForm.reason}
        placeholder={t.leaveForm.reasonPlaceholder}
        value={reason}
        onChangeText={setReason}
        numberOfLines={3}
        maxLength={2000}
      />

      {type ? (
        <Text style={[styles.hint, { color: palette.muted }]}>
          {type.requiresApproval ? t.leaveForm.needsApproval : t.leaveForm.autoApproved}
        </Text>
      ) : null}

      {error ? <ErrorNote message={error} /> : null}

      <Button
        title={t.leaveForm.submit}
        testID="leave-submit"
        onPress={submit}
        loading={request.isPending}
        disabled={blocked || !typeId}
        fullWidth
        size="lg"
      />
    </View>
  );
}

/** Every leave type as a row with what is left of it, so the balance is in view while choosing. */
function TypePicker({
  types,
  balances,
  value,
  onChange,
}: Readonly<{
  types: HrSelfLeave['types'];
  balances: HrLeaveBalance[];
  value: string | null;
  onChange: (id: string) => void;
}>) {
  const palette = usePalette();
  const { t, format, intlLocale } = useI18n();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: palette.text }]}>{t.leaveForm.type}</Text>
      <View style={[styles.types, { backgroundColor: palette.surface, borderColor: palette.border }]}>
        {types.map((type, index) => {
          const selected = type.id === value;
          const balance = balances.find((b) => b.leaveTypeId === type.id);
          let sub: string | null = null;
          if (balance?.remaining != null) {
            sub = `${format(t.balance.left, { days: formatDays(balance.remaining, intlLocale) })} · ${format(t.balance.ofAllowance, { days: formatDays(balance.allowance ?? 0, intlLocale) })}`;
          } else if (balance) sub = t.balance.unlimited;
          return (
            <Pressable
              key={type.id}
              onPress={() => onChange(type.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={type.name}
              style={({ pressed }) => [
                styles.type,
                index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
                (pressed || selected) && { backgroundColor: selected ? tint(palette.accent, 0.07) : palette.tile },
              ]}
            >
              <LeaveTypeTile color={type.color} />
              <View style={styles.flex}>
                <Text style={[styles.typeName, { color: palette.text }]} numberOfLines={1}>
                  {type.name}
                </Text>
                {sub ? (
                  <Text style={[styles.typeSub, { color: palette.muted }]} numberOfLines={1}>
                    {sub}
                  </Text>
                ) : null}
              </View>
              <View
                style={[
                  styles.radio,
                  {
                    borderColor: selected ? palette.accent : palette.grabber,
                    backgroundColor: selected ? palette.accent : 'transparent',
                  },
                ]}
              >
                {selected ? <Check size={13} color="#FFFFFF" strokeWidth={3} /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function AllowanceBanner({ allowance }: Readonly<{ allowance: AllowanceCheck }>) {
  const { t, format, intlLocale } = useI18n();
  if (allowance.kind !== 'over') return null;
  const template = allowance.blocked ? t.leaveForm.overAllowanceBlocked : t.leaveForm.overAllowance;
  return (
    <Banner variant={allowance.blocked ? 'error' : 'warning'}>
      {format(template, { days: formatDays(allowance.remaining, intlLocale) })}
    </Banner>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  form: { gap: 14 },
  field: { gap: 8 },
  label: { fontSize: 14, fontWeight: '500' },
  types: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  type: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 12 },
  typeName: { fontSize: 16, fontWeight: '600' },
  typeSub: { fontSize: 14, marginTop: 1 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  hint: { fontSize: 13, marginTop: -6 },
  dates: { flexDirection: 'row', gap: 12 },
  date: { flex: 1 },
});
