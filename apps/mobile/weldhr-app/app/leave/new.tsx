import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import type { HrLeaveBalance, HrSelfLeave } from '@weldsuite/app-api-client/domains/weldhr';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { DateField } from '@/components/DateField';
import { FormChoice, FormField, FormHint, FormInput, FormOptions, FormRow, FormScreen } from '@/components/Form';
import { LeaveTypeTile } from '@/components/HrRows';
import { ListSkeleton } from '@/components/QueryBody';
import { ROW_TILE } from '@/components/Row';
import { useLeave, useMe, useRequestLeave } from '@/hooks/use-weldhr-queries';
import { nextWeekday, todayIso, weekdaysBetween } from '@/lib/dates';
import { formatDays } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { balanceForStart, checkAllowance, type AllowanceCheck } from '@/lib/leave';

export default function NewLeaveScreen() {
  const { t } = useI18n();
  const me = useMe();
  const leave = useLeave();
  const turnedOff = me.data?.features.leaveRequests === false;

  if (leave.isPending || turnedOff || leave.isError || !leave.data) {
    let body = <ListSkeleton count={3} />;
    if (turnedOff) body = <Banner variant="info">{t.timeOff.turnedOff}</Banner>;
    else if (!leave.isPending) body = <FormHint error>{t.common.somethingWrong}</FormHint>;
    return <FormScreen title={t.leaveForm.title}>{body}</FormScreen>;
  }
  return <LeaveForm data={leave.data} />;
}

function LeaveForm({ data }: Readonly<{ data: HrSelfLeave }>) {
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

  let approvalHint: string | null = null;
  if (type) approvalHint = type.requiresApproval ? t.leaveForm.needsApproval : t.leaveForm.autoApproved;

  return (
    <FormScreen
      title={t.leaveForm.title}
      action={{
        label: t.common.submit,
        onPress: submit,
        disabled: blocked || !typeId || request.isPending,
        loading: request.isPending,
        testID: 'leave-submit',
      }}
    >
      <TypePicker
        types={types}
        balances={startDate.slice(0, 4) === today.slice(0, 4) ? data.balances : []}
        value={typeId}
        onChange={setTypeId}
      />

      <View>
        <FormRow>
          <DateField
            label={t.leaveForm.from}
            value={startDate}
            onChange={(next) => {
              setStartDate(next);
              if (endDate < next) setEndDate(next);
            }}
          />
          <DateField label={t.leaveForm.to} value={endDate} min={startDate} onChange={setEndDate} />
        </FormRow>
        <FormHint>{plural(days, t.leaveForm.estimate)}</FormHint>
      </View>

      <AllowanceBanner allowance={allowance} />

      <FormField label={t.leaveForm.reason} hint={error ? null : approvalHint}>
        <FormInput
          placeholder={t.leaveForm.reasonPlaceholder}
          value={reason}
          onChangeText={setReason}
          multiline
          maxLength={2000}
          accessibilityLabel={t.leaveForm.reason}
        />
        {error ? <FormHint error>{error}</FormHint> : null}
      </FormField>
    </FormScreen>
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
  const { t, format, intlLocale } = useI18n();
  return (
    <FormField label={t.leaveForm.type}>
      <FormOptions>
        {types.map((type) => {
          const balance = balances.find((b) => b.leaveTypeId === type.id);
          let sub: string | null = null;
          if (balance?.remaining != null) {
            sub = `${format(t.balance.left, { days: formatDays(balance.remaining, intlLocale) })} · ${format(t.balance.ofAllowance, { days: formatDays(balance.allowance ?? 0, intlLocale) })}`;
          } else if (balance) sub = t.balance.unlimited;
          return (
            <FormChoice
              key={type.id}
              leading={<LeaveTypeTile color={type.color} size={ROW_TILE} />}
              title={type.name}
              hint={sub}
              selected={type.id === value}
              onPress={() => onChange(type.id)}
            />
          );
        })}
      </FormOptions>
    </FormField>
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
