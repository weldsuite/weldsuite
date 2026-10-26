/**
 * One of my leave requests, opened from Absence, Schedule or Home: the period,
 * whether the leave type is paid, the reason and HR's review, what is left of
 * the balance, and cancelling it while that is still allowed.
 */

import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { HrSelfLeave } from '@weldsuite/app-api-client/domains/weldhr';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { EmptyState } from '@/components/EmptyState';
import { LeaveTypeTile, statusColor } from '@/components/HrRows';
import { QueryBody } from '@/components/QueryBody';
import { Card, DetailRow, Row } from '@/components/Row';
import { Screen, Section } from '@/components/Screen';
import { usePalette } from '@/hooks/use-palette';
import { useCancelLeave, useLeave } from '@/hooks/use-weldhr-queries';
import { todayIso } from '@/lib/dates';
import { formatDate, formatDateRange, formatDays, formatSpan } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';
import { balanceForStart, canCancelLeave } from '@/lib/leave';

export default function LeaveScreen() {
  const { t } = useI18n();
  const { id } = useLocalSearchParams<{ id: string }>();
  const leave = useLeave();
  const request = leave.data?.requests.find((r) => r.id === id);

  return (
    <Screen
      title={request?.leaveTypeName ?? t.absence.leave}
      variant="push"
      plain
      refreshing={leave.isRefetching}
      onRefresh={() => void leave.refetch()}
    >
      <QueryBody query={leave}>{(data) => <LeaveDetail data={data} id={id} />}</QueryBody>
    </Screen>
  );
}

function LeaveDetail({ data, id }: Readonly<{ data: HrSelfLeave; id: string }>) {
  const palette = usePalette();
  const { t, format, plural, intlLocale } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const cancel = useCancelLeave();
  const [confirming, setConfirming] = useState(false);
  const today = todayIso();

  const request = data.requests.find((r) => r.id === id);
  if (!request) return <EmptyState illustration="calendar" title={t.leaveDetail.notFound} />;

  const type = data.types.find((ty) => ty.id === request.leaveTypeId);
  // Paid or not is the leave type's; this year's balances carry it.
  const paid = data.balances.find((b) => b.leaveTypeId === request.leaveTypeId)?.isPaid;
  const balance = balanceForStart(data.balances, request.leaveTypeId, request.startDate, today);
  const days = (value: number | null) => (value == null ? t.balance.unlimited : formatDays(value, intlLocale));
  const reviewed = request.reviewedAt ? formatDate(request.reviewedAt, intlLocale) : null;

  const facts = [
    { label: t.leaveDetail.period, value: formatDateRange(request.startDate, request.endDate, intlLocale) },
    { label: t.leaveDetail.length, value: plural(request.days, t.balance.days) },
    { label: t.leaveDetail.kind, value: paid == null ? null : paid ? t.leaveDetail.paid : t.leaveDetail.unpaid },
    { label: t.leaveDetail.requested, value: request.createdAt ? formatDate(request.createdAt, intlLocale) : null },
    { label: t.leaveDetail.reason, value: request.reason },
    {
      label: t.leaveDetail.reviewed,
      value:
        reviewed && request.reviewedByName
          ? format(t.leaveDetail.reviewedBy, { date: reviewed, name: request.reviewedByName })
          : reviewed,
    },
    { label: t.leaveDetail.note, value: request.reviewNote },
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact.value));

  return (
    <>
      <Section first>
        <Card>
          <Row
            leading={<LeaveTypeTile color={request.leaveTypeColor ?? type?.color ?? null} />}
            title={request.leaveTypeName ?? type?.name ?? t.absence.leave}
            subtitle={labelFor(t.leaveStatus, request.status)}
            subtitleColor={statusColor(request.status, palette)}
            value={formatSpan(request.startDate, request.endDate, intlLocale)}
            detail={plural(request.days, t.balance.days)}
            muted={request.status === 'cancelled'}
          />
        </Card>
      </Section>

      <Section title={t.absence.leave}>
        <Card>
          {facts.map((fact) => (
            <DetailRow key={fact.label} label={fact.label} value={fact.value} />
          ))}
        </Card>
      </Section>

      {balance ? (
        <Section title={format(t.leaveDetail.balance, { year: today.slice(0, 4) })}>
          <Card>
            <DetailRow label={t.absence.allowance} value={days(balance.allowance)} />
            <DetailRow label={t.absence.taken} value={days(balance.used)} />
            <DetailRow label={t.absence.waiting} value={days(balance.pending)} />
            <DetailRow label={t.absence.left} value={days(balance.remaining)} />
          </Card>
        </Section>
      ) : null}

      {canCancelLeave(request, today) ? (
        <View style={styles.actions}>
          <Button
            title={t.leaveDetail.cancel}
            variant="destructive"
            onPress={() => setConfirming(true)}
            fullWidth
            testID="leave-cancel"
          />
        </View>
      ) : null}

      <ConfirmModal
        visible={confirming}
        title={t.timeOff.cancelTitle}
        message={format(t.timeOff.cancelMessage, {
          type: request.leaveTypeName ?? '',
          dates: formatDateRange(request.startDate, request.endDate, intlLocale),
        })}
        confirmText={t.timeOff.cancelConfirm}
        cancelText={t.timeOff.keep}
        variant="destructive"
        loading={cancel.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          cancel.mutate(request.id, {
            onSuccess: () => {
              toast.success(t.timeOff.cancelled);
              setConfirming(false);
              router.back();
            },
            onError: (err) => {
              toast.error((err as Error).message || t.common.somethingWrong);
              setConfirming(false);
            },
          })
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  actions: { paddingHorizontal: 16, marginTop: 28 },
});
