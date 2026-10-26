/**
 * Asking to work a shift: the day, from and until (past midnight ends the
 * next day), what to do and a note for the manager. The manager approves or
 * declines it in WeldHR; approved, it is a shift in the schedule.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { DateField } from '@/components/DateField';
import { ErrorNote, Screen } from '@/components/Screen';
import { TimeField } from '@/components/TimeField';
import { usePalette } from '@/hooks/use-palette';
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
  return (
    <Screen title={t.shiftRequest.title} variant="modal">
      <ShiftRequestForm />
    </Screen>
  );
}

function ShiftRequestForm() {
  const palette = usePalette();
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
    <View style={styles.form}>
      <DateField label={t.shiftRequest.day} value={day} min={today} onChange={setDay} />

      <View style={styles.times}>
        <View style={styles.time}>
          <TimeField label={t.shiftRequest.from} value={from} onChange={setFrom} testID="shift-request-from" />
        </View>
        <View style={styles.time}>
          <TimeField label={t.shiftRequest.to} value={until} onChange={setUntil} testID="shift-request-until" />
        </View>
      </View>
      <Text style={[styles.hint, { color: palette.muted }]}>
        {[formatHoursMinutes(minutes, t.common.hm), nextDay ? t.shiftRequest.nextDay : null].filter(Boolean).join(' · ')}
      </Text>

      <Input
        label={t.shiftRequest.work}
        placeholder={t.shiftRequest.workPlaceholder}
        value={work}
        onChangeText={setWork}
        maxLength={100}
      />

      <Textarea
        label={t.shiftRequest.note}
        placeholder={t.shiftRequest.notePlaceholder}
        value={note}
        onChangeText={setNote}
        numberOfLines={3}
        maxLength={1000}
      />

      <Text style={[styles.hint, { color: palette.muted }]}>{t.shiftRequest.hint}</Text>

      {error ? <ErrorNote message={error} /> : null}

      <Button
        title={t.shiftRequest.submit}
        testID="shift-request-submit"
        onPress={submit}
        loading={request.isPending}
        fullWidth
        size="lg"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 14 },
  times: { flexDirection: 'row', gap: 12 },
  time: { flex: 1 },
  hint: { fontSize: 13, marginTop: -6 },
});
