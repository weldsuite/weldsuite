/**
 * A shift I asked to work, opened from Schedule: when, what for, my note, and
 * the manager's answer once there is one. While it waits it can be withdrawn.
 * An approved request is a shift, so Schedule opens that instead.
 *
 * It reads the week the shift is in (`day`), the same query Schedule shows.
 */

import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { HrSelfShiftRequest } from '@weldsuite/app-api-client/domains/weldhr';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { EmptyState } from '@/components/EmptyState';
import { statusColor, timeRange } from '@/components/HrRows';
import { MyHrGate, useSelfState } from '@/components/MyHrGate';
import { QueryBody } from '@/components/QueryBody';
import { Card, DetailRow, Row } from '@/components/Row';
import { Screen, Section } from '@/components/Screen';
import { usePalette } from '@/hooks/use-palette';
import { useAttendance, useCancelShiftRequest } from '@/hooks/use-weldhr-queries';
import { addDays, dayOf, startOfWeek, todayIso } from '@/lib/dates';
import { formatDate, formatHoursMinutes, formatLongDay } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';
import { minutesBetween } from '@/lib/shifts';

export default function ShiftRequestScreen() {
  const { t } = useI18n();
  const { id, day } = useLocalSearchParams<{ id: string; day?: string }>();
  const from = startOfWeek(day ?? todayIso());
  const state = useSelfState();
  const week = useAttendance(from, addDays(from, 6), state.status === 'ready');

  const refresh = () => {
    state.refetch();
    void week.refetch();
  };

  return (
    <Screen title={t.shiftRequest.details} variant="push" plain refreshing={week.isRefetching} onRefresh={refresh}>
      <MyHrGate state={state} onRetry={refresh}>
        <QueryBody query={week}>
          {(data) => {
            const request = data.requests?.find((r) => r.id === id);
            return request ? (
              <RequestDetail request={request} />
            ) : (
              <EmptyState illustration="calendar" title={t.shiftRequest.notFound} />
            );
          }}
        </QueryBody>
      </MyHrGate>
    </Screen>
  );
}

/** "Dinsdag 27 oktober"; Dutch writes the weekday in lower case. */
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function RequestDetail({ request }: Readonly<{ request: HrSelfShiftRequest }>) {
  const palette = usePalette();
  const { t, format, intlLocale } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const cancel = useCancelShiftRequest();
  const [confirming, setConfirming] = useState(false);

  const range = timeRange(request.startsAt, request.endsAt, intlLocale);
  const day = capitalize(formatLongDay(dayOf(request.startsAt), intlLocale));
  const hours = formatHoursMinutes(minutesBetween(request.startsAt, request.endsAt), t.common.hm);
  const reviewed = request.reviewedAt ? formatDate(request.reviewedAt, intlLocale) : null;

  const facts = [
    { label: t.shiftRequest.day, value: day },
    { label: t.shift.time, value: range },
    { label: t.shift.length, value: hours },
    { label: t.shift.work, value: request.workType },
    { label: t.shiftRequest.note, value: request.note },
    { label: t.shiftRequest.requested, value: formatDate(request.createdAt, intlLocale) },
    {
      label: t.shiftRequest.reviewed,
      value:
        reviewed && request.reviewedByName
          ? format(t.shiftRequest.reviewedBy, { date: reviewed, name: request.reviewedByName })
          : reviewed,
    },
    { label: t.shiftRequest.reviewNote, value: request.reviewNote },
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact.value));

  return (
    <>
      <Section first>
        <Card open>
          <Row
            bar={palette.grabber}
            title={range}
            subtitle={labelFor(t.shiftRequest.status, request.status)}
            subtitleColor={statusColor(request.status, palette)}
            value={hours}
            detail={request.workType ?? undefined}
          />
        </Card>
      </Section>

      <Section title={t.shift.details}>
        <Card open>
          {facts.map((fact) => (
            <DetailRow key={fact.label} label={fact.label} value={fact.value} />
          ))}
        </Card>
      </Section>

      {request.status === 'pending' ? (
        <View style={styles.actions}>
          <Button
            title={t.shiftRequest.withdraw}
            variant="destructive"
            onPress={() => setConfirming(true)}
            fullWidth
            testID="shift-request-withdraw"
          />
        </View>
      ) : null}

      <ConfirmModal
        visible={confirming}
        title={t.shiftRequest.withdrawTitle}
        message={format(t.shiftRequest.withdrawMessage, { when: `${day} ${range}` })}
        confirmText={t.shiftRequest.withdrawConfirm}
        cancelText={t.shiftRequest.keep}
        variant="destructive"
        loading={cancel.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          cancel.mutate(request.id, {
            onSuccess: () => {
              toast.success(t.shiftRequest.withdrawn);
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
