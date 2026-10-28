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
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { DateField } from '@/components/DateField';
import { FormChips, FormField, FormHint, FormInput, FormOptions, FormScreen } from '@/components/Form';
import { ListSkeleton } from '@/components/QueryBody';
import { useAbsences, useReportRecovered, useReportSick } from '@/hooks/use-weldhr-queries';
import { addDays, todayIso } from '@/lib/dates';
import { formatDateRange, formatDay } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function SickScreen() {
  const { t } = useI18n();
  const absences = useAbsences();

  if (!absences.data) {
    return (
      <FormScreen title={t.sick.title}>
        {absences.isError ? <FormHint error>{t.common.somethingWrong}</FormHint> : <ListSkeleton count={3} />}
      </FormScreen>
    );
  }
  const current = absences.data.current;
  return current ? <RecoverForm absenceId={current.id} startDate={current.startDate} /> : <ReportForm />;
}

function ReportForm() {
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
    <FormScreen
      title={t.sick.title}
      action={{
        label: t.common.submit,
        onPress: submit,
        disabled: report.isPending,
        loading: report.isPending,
        testID: 'sick-submit',
      }}
    >
      {/* A report can start a few days back (ill over the weekend), never in the future. */}
      <DateField
        label={t.sick.firstDay}
        value={startDate}
        max={today}
        min={addDays(today, -14)}
        onChange={setStartDate}
      />
      <FormField label={t.sick.firstDayLength}>
        <FormChips
          value={firstDay}
          onChange={setFirstDay}
          options={[
            { label: t.sick.fullDay, value: 'full' },
            { label: t.sick.halfDay, value: 'half' },
          ]}
        />
      </FormField>
      <FormField label={t.sick.note} hint={error ? null : t.sick.noteHint}>
        <FormInput
          placeholder={t.sick.notePlaceholder}
          value={note}
          onChangeText={setNote}
          multiline
          maxLength={1000}
          accessibilityLabel={t.sick.note}
        />
        {error ? <FormHint error>{error}</FormHint> : null}
      </FormField>
      <History />
    </FormScreen>
  );
}

function RecoverForm({ absenceId, startDate }: Readonly<{ absenceId: string; startDate: string }>) {
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
    <FormScreen
      title={t.sick.recoverTitle}
      action={{ label: t.common.submit, onPress: submit, disabled: recover.isPending, loading: recover.isPending }}
    >
      <View>
        <DateField label={t.sick.lastDay} value={endDate} min={startDate} max={today} onChange={setEndDate} />
        <FormHint error={Boolean(error)}>
          {error ?? format(t.sick.recoverHint, { date: formatDay(startDate, intlLocale) })}
        </FormHint>
      </View>
      <History />
    </FormScreen>
  );
}

/** The last reports, under the form: when and how many days. */
function History() {
  const { colors } = useTheme();
  const { t, plural, intlLocale } = useI18n();
  const absences = useAbsences();
  const history = absences.data?.history ?? [];
  if (history.length === 0) return null;
  return (
    <FormField label={t.sick.history}>
      <FormOptions>
        {history.slice(0, 10).map((absence) => (
          <View key={absence.id} style={styles.historyRow}>
            <Text style={[styles.historyDates, { color: colors.text }]} numberOfLines={1}>
              {formatDateRange(absence.startDate, absence.endDate ?? absence.startDate, intlLocale)}
            </Text>
            <Text style={[styles.historyDays, { color: colors.mutedForeground }]}>{plural(absence.days, t.sick.days)}</Text>
          </View>
        ))}
      </FormOptions>
    </FormField>
  );
}

const styles = StyleSheet.create({
  // A form option's height and type, with the days where its switch would be.
  historyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 13 },
  historyDates: { flexShrink: 1, fontSize: 16 },
  historyDays: { fontSize: 16, fontVariant: ['tabular-nums'] },
});
