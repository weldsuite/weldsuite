/**
 * One of my sick reports, opened from Absence, Schedule or Home: the first
 * day (whole or half), the last or that it is still running, how long, when
 * it was reported and the note for HR, with "I'm better" while it is open.
 */

import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { HrSelfAbsences } from '@weldsuite/app-api-client/domains/weldhr';
import { Button } from '@weldsuite/mobile-ui/components/Button';

import { EmptyState } from '@/components/EmptyState';
import { SickTile } from '@/components/HrRows';
import { QueryBody } from '@/components/QueryBody';
import { Card, DetailRow, Row, ROW_TILE } from '@/components/Row';
import { Screen, Section } from '@/components/Screen';
import { usePalette } from '@/hooks/use-palette';
import { useAbsences } from '@/hooks/use-weldhr-queries';
import { formatDate, formatLongDay, formatShortDate, formatSpan, RANGE } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function SickReportScreen() {
  const { t } = useI18n();
  const { id } = useLocalSearchParams<{ id: string }>();
  const absences = useAbsences();

  return (
    <Screen title={t.absence.sick} variant="push" plain refreshing={absences.isRefetching} onRefresh={() => void absences.refetch()}>
      <QueryBody query={absences}>{(data) => <SickDetail data={data} id={id} />}</QueryBody>
    </Screen>
  );
}

function SickDetail({ data, id }: Readonly<{ data: HrSelfAbsences; id: string }>) {
  const palette = usePalette();
  const { t, plural, intlLocale } = useI18n();
  const router = useRouter();
  const report = [data.current, ...data.history].find((a) => a?.id === id);
  if (!report) return <EmptyState illustration="calendar" title={t.sickDetail.notFound} />;

  const ongoing = report.status === 'ongoing';
  const firstDay = formatLongDay(report.startDate, intlLocale);
  const facts = [
    {
      label: t.sickDetail.firstDay,
      value: `${firstDay} · ${report.firstDay === 'half' ? t.sick.halfDay : t.sick.fullDay}`,
    },
    { label: t.sickDetail.lastDay, value: report.endDate ? formatLongDay(report.endDate, intlLocale) : t.sickDetail.stillSick },
    { label: t.sickDetail.length, value: plural(report.days, t.balance.days) },
    { label: t.sickDetail.reported, value: formatDate(report.createdAt, intlLocale) },
    { label: t.sickDetail.note, value: report.note },
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact.value));

  return (
    <>
      <Section first>
        <Card open>
          <Row
            leading={<SickTile size={ROW_TILE} />}
            title={t.absence.sick}
            subtitle={ongoing ? t.absence.ongoing : t.absence.recovered}
            subtitleColor={ongoing ? palette.danger : palette.muted}
            value={
              report.endDate
                ? formatSpan(report.startDate, report.endDate, intlLocale)
                : `${formatShortDate(report.startDate, intlLocale)}${RANGE}…`
            }
            detail={plural(report.days, t.balance.days)}
          />
        </Card>
      </Section>

      <Section title={t.absence.sickLeave}>
        <Card open>
          {facts.map((fact) => (
            <DetailRow key={fact.label} label={fact.label} value={fact.value} />
          ))}
        </Card>
      </Section>

      {ongoing ? (
        <View style={styles.actions}>
          <Button title={t.sick.recoverSubmit} onPress={() => router.push('/sick')} fullWidth testID="sick-recover" />
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  actions: { paddingHorizontal: 16, marginTop: 28 },
});
