/**
 * Asking to work a shift: the day, from and until (past midnight ends the
 * next day), what to do and a note for the manager. The manager approves or
 * declines it in WeldHR; approved, it is a shift in the schedule.
 */

import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { DateField } from '@/components/DateField';
import { FormField, FormHint, FormInput, FormRow, FormScreen } from '@/components/Form';
import { TimeField } from '@/components/TimeField';
import { useRequestShift } from '@/hooks/use-weldhr-queries';
import { addDays, todayIso } from '@/lib/dates';
import { formatHoursMinutes } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

/** `day` at `time` ("09:30"), local. */
function instant(day: string, time: string): Date {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number);
  const [h = 0, min = 0] = time.split(':').map(Number);
  return new Date(y, m - 1, d, h, min);
}

export default function NewShiftRequestScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const request = useRequestShift();

  const today = todayIso();
  const [day, setDay] = useState(() => addDays(today, 1));
  const [from, setFrom] = useState('09:00');
  const [until, setUntil] = useState('17:00');
  const [work, setWork] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Until at or before from is a night shift: it ends the next day.
  const nextDay = until <= from;
  const startsAt = instant(day, from);
  const endsAt = instant(nextDay ? addDays(day, 1) : day, until);
  const minutes = Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000);

  const submit = () => {
    setError(null);
    if (startsAt.getTime() <= Date.now()) return setError(t.shiftRequest.inPast);
    request.mutate(
      {
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        workType: work.trim() || null,
        note: note.trim() || null,
      },
      {
        onSuccess: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          toast.success(t.shiftRequest.sent);
          router.back();
        },
        onError: (err) => setError((err as Error).message || t.common.somethingWrong),
      },
    );
  };

  return (
    <FormScreen
      title={t.shiftRequest.title}
      action={{
        label: t.common.submit,
        onPress: submit,
        disabled: request.isPending,
        loading: request.isPending,
        testID: 'shift-request-submit',
      }}
    >
      <DateField label={t.shiftRequest.day} value={day} min={today} onChange={setDay} />

      <View>
        <FormRow>
          <TimeField label={t.shiftRequest.from} value={from} onChange={setFrom} testID="shift-request-from" />
          <TimeField label={t.shiftRequest.to} value={until} onChange={setUntil} testID="shift-request-until" />
        </FormRow>
        <FormHint>
          {[formatHoursMinutes(minutes, t.common.hm), nextDay ? t.shiftRequest.nextDay : null].filter(Boolean).join(' · ')}
        </FormHint>
      </View>

      <FormField label={t.shiftRequest.work}>
        <FormInput
          placeholder={t.shiftRequest.workPlaceholder}
          value={work}
          onChangeText={setWork}
          maxLength={100}
          accessibilityLabel={t.shiftRequest.work}
        />
      </FormField>

      <FormField label={t.shiftRequest.note} hint={error ? null : t.shiftRequest.hint}>
        <FormInput
          placeholder={t.shiftRequest.notePlaceholder}
          value={note}
          onChangeText={setNote}
          multiline
          maxLength={1000}
          accessibilityLabel={t.shiftRequest.note}
        />
        {error ? <FormHint error>{error}</FormHint> : null}
      </FormField>
    </FormScreen>
  );
}
