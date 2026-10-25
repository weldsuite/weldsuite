import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import type { HrSelfLeave } from '@weldsuite/app-api-client/domains/weldhr';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Select } from '@weldsuite/mobile-ui/components/Select';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { DateField } from '@/components/DateField';
import { ErrorNote, Screen } from '@/components/Screen';
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
  if (leave.isPending) return <ActivityIndicator style={styles.loading} />;
  if (turnedOff) return <Banner variant="info">{t.timeOff.turnedOff}</Banner>;
  if (leave.isError || !leave.data) return <ErrorNote message={t.common.somethingWrong} />;
  return <LeaveForm data={leave.data} />;
}

function LeaveForm({ data }: Readonly<{ data: HrSelfLeave }>) {
  const { colors } = useTheme();
  const { t, format, plural, intlLocale } = useI18n();
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
      <Select
        label={t.leaveForm.type}
        placeholder={t.leaveForm.typePlaceholder}
        value={typeId}
        onValueChange={setTypeId}
        options={types.map((option) => ({ label: option.name, value: option.id }))}
      />
      {balance?.remaining == null ? null : (
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>
          {format(t.balance.left, { days: formatDays(balance.remaining, intlLocale) })} ·{' '}
          {format(t.balance.ofAllowance, { days: formatDays(balance.allowance ?? 0, intlLocale) })}
        </Text>
      )}

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
      <Text style={[styles.hint, { color: colors.mutedForeground }]}>{plural(days, t.leaveForm.estimate)}</Text>

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
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>
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
  loading: { marginTop: 32 },
  form: { gap: 14 },
  hint: { fontSize: 13, marginTop: -6 },
  dates: { flexDirection: 'row', gap: 12 },
  date: { flex: 1 },
});
