/**
 * Report sick, or report recovered when a report is open. Always available:
 * unlike leave requests, hr-api has no switch for this, because an employee
 * who is ill has to be able to say so.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import type { HrAbsenceFirstDay } from '@weldsuite/app-api-client/domains/weldhr';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { DateField } from '@/components/DateField';
import { Card, DetailRow } from '@/components/Row';
import { QueryBody } from '@/components/QueryBody';
import { ErrorNote, Screen } from '@/components/Screen';
import { useAbsences, useReportRecovered, useReportSick } from '@/hooks/use-weldhr-queries';
import { addDays, todayIso } from '@/lib/dates';
import { formatDateRange, formatDay } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function SickScreen() {
  const { t } = useI18n();
  const absences = useAbsences();
  const current = absences.data?.current ?? null;

  return (
    <Screen title={current ? t.sick.recoverTitle : t.sick.title} variant="modal">
      <QueryBody query={absences}>
        {(data) =>
          data.current ? <RecoverForm absenceId={data.current.id} startDate={data.current.startDate} /> : <ReportForm />
        }
      </QueryBody>
      {absences.data && absences.data.history.length > 0 ? <History /> : null}
    </Screen>
  );
}

function ReportForm() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const report = useReportSick();
  const today = todayIso();
  const [startDate, setStartDate] = useState(today);
  const [firstDay, setFirstDay] = useState<HrAbsenceFirstDay>('full');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    report.mutate(
      { startDate, firstDay, note: note.trim() || null },
      {
        onSuccess: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          toast.success(t.sick.reported);
          router.back();
        },
        onError: (err) => setError((err as Error).message || t.common.somethingWrong),
      },
    );
  };

  return (
    <View style={styles.form}>
      {/* A report can start a few days back (ill over the weekend), never in the future. */}
      <DateField
        label={t.sick.firstDay}
        value={startDate}
        max={today}
        min={addDays(today, -14)}
        onChange={setStartDate}
      />
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.text }]}>{t.sick.firstDayLength}</Text>
        <SegmentedControl
          value={firstDay}
          onValueChange={(value) => setFirstDay(value as HrAbsenceFirstDay)}
          options={[
            { label: t.sick.fullDay, value: 'full' },
            { label: t.sick.halfDay, value: 'half' },
          ]}
        />
      </View>
      <Textarea
        label={t.sick.note}
        placeholder={t.sick.notePlaceholder}
        helperText={t.sick.noteHint}
        value={note}
        onChangeText={setNote}
        numberOfLines={3}
        maxLength={1000}
      />
      {error ? <ErrorNote message={error} /> : null}
      <Button
        title={t.sick.submit}
        testID="sick-submit"
        onPress={submit}
        loading={report.isPending}
        fullWidth
        size="lg"
      />
    </View>
  );
}

function RecoverForm({ absenceId, startDate }: Readonly<{ absenceId: string; startDate: string }>) {
  const { colors } = useTheme();
  const { t, format, intlLocale } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const recover = useReportRecovered();
  const today = todayIso();
  // Most people report it the morning they are back, so yesterday was the last sick day.
  const [endDate, setEndDate] = useState(() => {
    const yesterday = addDays(today, -1);
    return yesterday < startDate ? startDate : yesterday;
  });
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    recover.mutate(
      { id: absenceId, endDate },
      {
        onSuccess: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          toast.success(t.sick.recovered);
          router.back();
        },
        onError: (err) => setError((err as Error).message || t.common.somethingWrong),
      },
    );
  };

  return (
    <View style={styles.form}>
      <Text style={[styles.text, { color: colors.mutedForeground }]}>
        {format(t.sick.recoverHint, { date: formatDay(startDate, intlLocale) })}
      </Text>
      <DateField label={t.sick.lastDay} value={endDate} min={startDate} max={today} onChange={setEndDate} />
      {error ? <ErrorNote message={error} /> : null}
      <Button title={t.sick.recoverSubmit} onPress={submit} loading={recover.isPending} fullWidth size="lg" />
    </View>
  );
}

function History() {
  const { colors } = useTheme();
  const { t, plural, intlLocale } = useI18n();
  const absences = useAbsences();
  const history = absences.data?.history ?? [];
  return (
    <View style={styles.history}>
      <Text style={[styles.historyTitle, { color: colors.text }]}>{t.sick.history}</Text>
      <Card style={styles.historyGroup}>
        {history.slice(0, 10).map((absence) => (
          <DetailRow
            key={absence.id}
            label={formatDateRange(absence.startDate, absence.endDate ?? absence.startDate, intlLocale)}
            value={plural(absence.days, t.sick.days)}
          />
        ))}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 16 },
  field: { gap: 6 },
  label: { fontSize: 14, fontWeight: '500' },
  text: { fontSize: 15, lineHeight: 21 },
  history: { marginTop: 8, gap: 10 },
  historyTitle: { fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  historyGroup: { marginHorizontal: 0 },
});
