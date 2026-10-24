import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
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
import { checkAllowance } from '@/lib/leave';

export default function NewLeaveScreen() {
  const { colors } = useTheme();
  const { t, format, plural, intlLocale } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const me = useMe();
  const leave = useLeave();
  const request = useRequestLeave();

  // Most requests are for the next working day or later.
  const firstDay = nextWeekday(todayIso());
  const [typeId, setTypeId] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(firstDay);
  const [endDate, setEndDate] = useState(firstDay);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const types = useMemo(() => leave.data?.types ?? [], [leave.data]);
  // One type is the common case (holiday); pick it so the form is one tap shorter.
  useEffect(() => {
    if (!typeId && types.length === 1) setTypeId(types[0].id);
  }, [typeId, types]);

  const type = types.find((candidate) => candidate.id === typeId);
  const balance = leave.data?.balances.find((b) => b.leaveTypeId === typeId);
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
        onSuccess: ({ data }) => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          toast.success(data.status === 'approved' ? t.leaveForm.approved : t.leaveForm.sent);
          router.back();
        },
        onError: (err) => setError((err as Error).message || t.common.somethingWrong),
      },
    );
  };

  const turnedOff = me.data?.features.leaveRequests === false;

  return (
    <Screen title={t.leaveForm.title} variant="modal">
      {leave.isPending ? (
        <ActivityIndicator style={styles.loading} />
      ) : turnedOff ? (
        <Banner variant="info">{t.timeOff.turnedOff}</Banner>
      ) : leave.isError ? (
        <ErrorNote message={t.common.somethingWrong} />
      ) : (
        <View style={styles.form}>
          <Select
            label={t.leaveForm.type}
            placeholder={t.leaveForm.typePlaceholder}
            value={typeId}
            onValueChange={setTypeId}
            options={types.map((option) => ({ label: option.name, value: option.id }))}
          />
          {balance && balance.remaining != null ? (
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
              {format(t.balance.left, { days: formatDays(balance.remaining, intlLocale) })} ·{' '}
              {format(t.balance.ofAllowance, { days: formatDays(balance.allowance ?? 0, intlLocale) })}
            </Text>
          ) : null}

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

          {allowance.kind === 'over' ? (
            <Banner variant={allowance.blocked ? 'error' : 'warning'}>
              {format(allowance.blocked ? t.leaveForm.overAllowanceBlocked : t.leaveForm.overAllowance, {
                days: formatDays(allowance.remaining, intlLocale),
              })}
            </Banner>
          ) : null}

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
            onPress={submit}
            loading={request.isPending}
            disabled={blocked || !typeId}
            fullWidth
            size="lg"
          />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 32 },
  form: { gap: 14 },
  hint: { fontSize: 13, marginTop: -6 },
  dates: { flexDirection: 'row', gap: 12 },
  date: { flex: 1 },
});
