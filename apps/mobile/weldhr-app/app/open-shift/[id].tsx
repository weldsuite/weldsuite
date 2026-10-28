/**
 * An open shift, opened from Schedule: when it is and what for, how many
 * spots are left and, depending on where I stand, the way to sign up (with an
 * optional note for the manager), that my sign-up is waiting (and to withdraw
 * it), or why it is declined or full. The manager approves who gets the shift;
 * an approved one is in my schedule.
 *
 * It reads the same open-shifts query as Schedule, so it opens at once from there.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import type { HrSelfOpenShift } from '@weldsuite/app-api-client/domains/weldhr';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { EmptyState } from '@/components/EmptyState';
import { timeRange } from '@/components/HrRows';
import { MyHrGate, useSelfState } from '@/components/MyHrGate';
import { standingColor } from '@/components/OpenShifts';
import { QueryBody } from '@/components/QueryBody';
import { Card, DetailRow, Row } from '@/components/Row';
import { Screen, Section } from '@/components/Screen';
import { swatchFor } from '@/constants/brand';
import { usePalette } from '@/hooks/use-palette';
import { useCancelShiftRequest, useOpenShifts, useSignUpForOpenShift } from '@/hooks/use-weldhr-queries';
import { dayOf } from '@/lib/dates';
import { formatHoursMinutes, formatLongDay } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { canSignUp, standingOf } from '@/lib/open-shifts';
import { plannedMinutes } from '@/lib/shifts';

export default function OpenShiftScreen() {
  const { t } = useI18n();
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useSelfState();
  const shifts = useOpenShifts(state.status === 'ready');

  const refresh = () => {
    state.refetch();
    void shifts.refetch();
  };

  return (
    <Screen title={t.openShifts.details} variant="push" plain refreshing={shifts.isRefetching} onRefresh={refresh}>
      <MyHrGate state={state} onRetry={refresh}>
        <QueryBody query={shifts}>
          {(list) => {
            const shift = list.find((s) => s.id === id);
            return shift ? <ShiftDetail shift={shift} /> : <EmptyState illustration="calendar" title={t.openShifts.notFound} />;
          }}
        </QueryBody>
      </MyHrGate>
    </Screen>
  );
}

/** "Dinsdag 27 oktober"; Dutch writes the weekday in lower case. */
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function ShiftDetail({ shift }: Readonly<{ shift: HrSelfOpenShift }>) {
  const palette = usePalette();
  const { t, format, plural, intlLocale } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const signUp = useSignUpForOpenShift();
  const withdraw = useCancelShiftRequest();
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);

  const standing = standingOf(shift);
  const range = timeRange(shift.startsAt, shift.endsAt, intlLocale);
  const day = capitalize(formatLongDay(dayOf(shift.startsAt), intlLocale));
  const hours = formatHoursMinutes(plannedMinutes(shift), t.common.hm);
  const standingLabel = {
    open: plural(shift.spotsLeft, t.openShifts.spotsLeft),
    waiting: t.openShifts.waiting,
    declined: t.openShifts.declined,
    full: t.openShifts.full,
  }[standing];
  const pause = shift.breakStartsAt && shift.breakEndsAt ? timeRange(shift.breakStartsAt, shift.breakEndsAt, intlLocale) : null;

  const facts = [
    { label: t.shiftRequest.day, value: day },
    { label: t.shift.time, value: range },
    { label: t.shift.length, value: hours },
    { label: t.shift.plannedBreak, value: pause },
    { label: t.shift.work, value: shift.workType },
    { label: t.openShifts.client, value: shift.companyName },
    { label: t.openShifts.department, value: shift.departmentName },
    { label: t.openShifts.spots, value: format(t.openShifts.spotsOf, { left: shift.spotsLeft, total: shift.spots }) },
    { label: t.shift.notes, value: shift.notes },
    { label: t.openShifts.managerNote, value: shift.myRequest?.reviewNote },
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact.value));

  const submit = () => {
    signUp.mutate(
      { id: shift.id, note: note.trim() || null },
      {
        onSuccess: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          toast.success(t.openShifts.signedUp);
          router.back();
        },
        onError: (err) => toast.error((err as Error).message || t.common.somethingWrong),
      },
    );
  };

  const requestId = shift.myRequest?.id;

  return (
    <>
      <Section first>
        <Card open>
          <Row
            bar={swatchFor(shift.workType ?? shift.companyName)}
            title={range}
            subtitle={standingLabel}
            subtitleColor={standingColor(standing, palette)}
            value={hours}
            detail={shift.workType ?? undefined}
          />
        </Card>
      </Section>

      {canSignUp(shift) ? (
        <View style={styles.form}>
          <Textarea
            label={t.openShifts.note}
            placeholder={t.openShifts.notePlaceholder}
            value={note}
            onChangeText={setNote}
            numberOfLines={3}
            maxLength={1000}
          />
          <Text style={[styles.hint, { color: palette.muted }]}>{t.openShifts.signUpHint}</Text>
          <Button
            title={t.openShifts.submit}
            testID="open-shift-sign-up"
            onPress={submit}
            loading={signUp.isPending}
            fullWidth
            size="lg"
          />
        </View>
      ) : null}

      {standing === 'waiting' && requestId ? (
        <View style={styles.form}>
          <Text style={[styles.hint, { color: palette.muted }]}>{t.openShifts.waitingHint}</Text>
          <Button
            title={t.openShifts.withdraw}
            variant="destructive"
            onPress={() => setConfirming(true)}
            fullWidth
            testID="open-shift-withdraw"
          />
        </View>
      ) : null}

      {standing === 'declined' && !canSignUp(shift) ? (
        <View style={styles.form}>
          <Text style={[styles.hint, { color: palette.muted }]}>{t.openShifts.declinedHint}</Text>
        </View>
      ) : null}

      {standing === 'full' ? (
        <View style={styles.form}>
          <Text style={[styles.hint, { color: palette.muted }]}>{t.openShifts.fullHint}</Text>
        </View>
      ) : null}

      <Section title={t.shift.details}>
        <Card open>
          {facts.map((fact) => (
            <DetailRow key={fact.label} label={fact.label} value={fact.value} />
          ))}
        </Card>
      </Section>

      <ConfirmModal
        visible={confirming}
        title={t.openShifts.withdrawTitle}
        message={format(t.openShifts.withdrawMessage, { when: `${day} ${range}` })}
        confirmText={t.openShifts.withdrawConfirm}
        cancelText={t.openShifts.keep}
        variant="destructive"
        loading={withdraw.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          if (!requestId) return;
          withdraw.mutate(requestId, {
            onSuccess: () => {
              toast.success(t.openShifts.withdrawn);
              setConfirming(false);
              router.back();
            },
            onError: (err) => {
              toast.error((err as Error).message || t.common.somethingWrong);
              setConfirming(false);
            },
          });
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  form: { paddingHorizontal: 16, marginTop: 20, gap: 12 },
  hint: { fontSize: 14, lineHeight: 20 },
});
