/**
 * A colleague's card: who they are and how to reach them. Read-only, and only
 * the public projection of the record (`employees:read`); sensitive details
 * stay behind the audited endpoint on the web.
 */

import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Mail, Phone, type LucideIcon } from 'lucide-react-native';
import type { HrEmployeeDetail } from '@weldsuite/app-api-client/domains/weldhr';

import { PersonAvatar } from '@/components/PersonAvatar';
import { QueryBody } from '@/components/QueryBody';
import { Card, DetailRow, List, Row } from '@/components/Row';
import { Screen, Section } from '@/components/Screen';
import { usePalette } from '@/hooks/use-palette';
import { weldhrKeys } from '@/lib/query-client';
import { formatDate } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';
import { appApi } from '@/services/app-api';

export default function EmployeeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const employee = useQuery({
    queryKey: weldhrKeys.employee(id),
    queryFn: async () => (await appApi.weldhr.getEmployee(id)).data,
    enabled: Boolean(id),
  });

  return (
    <Screen title={employee.data?.displayName ?? ''} variant="push" refreshing={employee.isRefetching} onRefresh={() => void employee.refetch()}>
      <QueryBody query={employee}>{(data) => <EmployeeCard data={data} />}</QueryBody>
    </Screen>
  );
}

function EmployeeCard({ data }: Readonly<{ data: HrEmployeeDetail }>) {
  const palette = usePalette();
  const { t, intlLocale } = useI18n();
  const phone = data.phone;
  const details = [
    { label: t.directory.department, value: data.departmentName },
    { label: t.directory.manager, value: data.managerName },
    { label: t.directory.location, value: data.location },
    { label: t.directory.startDate, value: data.startDate ? formatDate(data.startDate, intlLocale) : null },
    { label: t.directory.emailAddress, value: data.email },
  ].filter((detail): detail is { label: string; value: string } => Boolean(detail.value));

  return (
    <>
      <View style={styles.header}>
        <PersonAvatar name={data.displayName} url={data.avatarUrl} size={84} />
        {data.jobTitle ? <Text style={[styles.job, { color: palette.text }]}>{data.jobTitle}</Text> : null}
        <Text style={[styles.meta, { color: palette.muted }]}>
          {[labelFor(t.employeeStatus, data.status), data.pronouns].filter(Boolean).join(' • ')}
        </Text>
      </View>

      <View style={styles.actions}>
        {phone ? (
          <ContactButton
            icon={Phone}
            label={t.directory.call}
            onPress={() => void Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`)}
          />
        ) : null}
        <ContactButton icon={Mail} label={t.directory.email} onPress={() => void Linking.openURL(`mailto:${data.email}`)} />
      </View>

      {details.length > 0 ? (
        <Section>
          <Card>
            {details.map((detail) => (
              <DetailRow key={detail.label} label={detail.label} value={detail.value} />
            ))}
          </Card>
        </Section>
      ) : null}

      {data.directReports.length > 0 ? (
        <Section title={t.directory.reports}>
          <List>
            {data.directReports.map((report) => (
              <Row
                key={report.id}
                leading={<PersonAvatar name={report.displayName} url={report.avatarUrl} />}
                title={report.displayName}
                subtitle={report.jobTitle}
              />
            ))}
          </List>
        </Section>
      ) : null}
    </>
  );
}

/** Call / email, as grey tiles under the name like a phone's contact card. */
function ContactButton({ icon: Icon, label, onPress }: Readonly<{ icon: LucideIcon; label: string; onPress: () => void }>) {
  const palette = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.contact, { backgroundColor: palette.control, opacity: pressed ? 0.75 : 1 }]}
    >
      <Icon size={20} color={palette.text} strokeWidth={2} />
      <Text style={[styles.contactLabel, { color: palette.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, gap: 4 },
  job: { fontSize: 17, fontWeight: '600', textAlign: 'center', marginTop: 10 },
  meta: { fontSize: 15, textAlign: 'center' },
  actions: { flexDirection: 'row', justifyContent: 'center', gap: 10, paddingHorizontal: 16, marginTop: 20 },
  contact: { flex: 1, maxWidth: 160, alignItems: 'center', gap: 4, borderRadius: 14, paddingVertical: 12 },
  contactLabel: { fontSize: 14, fontWeight: '600' },
});
