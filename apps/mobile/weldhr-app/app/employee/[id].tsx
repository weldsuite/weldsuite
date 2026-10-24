/**
 * A colleague's card: who they are and how to reach them. Read-only, and only
 * the public projection of the record (`employees:read`); sensitive details
 * stay behind the audited endpoint on the web.
 */

import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Mail, Phone } from 'lucide-react-native';
import { Avatar } from '@weldsuite/mobile-ui/components/Avatar';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { Pill } from '@/components/Pill';
import { ErrorNote, Panel, Screen, Section } from '@/components/Screen';
import { weldhrKeys } from '@/lib/query-client';
import { formatDate } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';
import { appApi } from '@/services/app-api';

export default function EmployeeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const employee = useQuery({
    queryKey: weldhrKeys.employee(id),
    queryFn: async () => (await appApi.weldhr.getEmployee(id)).data,
    enabled: Boolean(id),
  });
  const data = employee.data;

  return (
    <Screen
      title={data?.displayName ?? ''}
      variant="push"
      refreshing={employee.isRefetching}
      onRefresh={() => void employee.refetch()}
    >
      {employee.isPending ? (
        <ActivityIndicator style={styles.loading} />
      ) : employee.isError || !data ? (
        <ErrorNote message={t.common.somethingWrong} />
      ) : (
        <>
          <View style={styles.header}>
            <Avatar name={data.displayName} source={data.avatarUrl ? { uri: data.avatarUrl } : undefined} size={72} />
            <View style={styles.headerText}>
              {data.jobTitle ? <Text style={[styles.job, { color: colors.text }]}>{data.jobTitle}</Text> : null}
              {data.pronouns ? (
                <Text style={[styles.sub, { color: colors.mutedForeground }]}>{data.pronouns}</Text>
              ) : null}
              <Pill label={labelFor(t.employeeStatus, data.status)} tone={data.status === 'active' ? 'brand' : 'neutral'} />
            </View>
          </View>

          <View style={styles.actions}>
            {data.phone ? (
              <Button
                title={t.directory.call}
                variant="outline"
                leftIcon={<Phone size={16} color={colors.text} />}
                onPress={() => void Linking.openURL(`tel:${data.phone!.replace(/[^\d+]/g, '')}`)}
                style={styles.flex}
              />
            ) : null}
            <Button
              title={t.directory.email}
              variant="outline"
              leftIcon={<Mail size={16} color={colors.text} />}
              onPress={() => void Linking.openURL(`mailto:${data.email}`)}
              style={styles.flex}
            />
          </View>

          <Panel>
            <Detail label={t.directory.department} value={data.departmentName} first />
            <Detail label={t.directory.manager} value={data.managerName} />
            <Detail label={t.directory.location} value={data.location} />
            <Detail label={t.directory.startDate} value={data.startDate ? formatDate(data.startDate, intlLocale) : null} />
            <Detail label={t.directory.email} value={data.email} />
          </Panel>

          {data.directReports.length > 0 ? (
            <Section title={t.directory.reports}>
              <Panel>
                {data.directReports.map((report, index) => (
                  <View
                    key={report.id}
                    style={[styles.report, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}
                  >
                    <Avatar name={report.displayName} source={report.avatarUrl ? { uri: report.avatarUrl } : undefined} size={32} />
                    <View style={styles.flex}>
                      <Text style={[styles.reportName, { color: colors.text }]}>{report.displayName}</Text>
                      {report.jobTitle ? (
                        <Text style={[styles.sub, { color: colors.mutedForeground }]}>{report.jobTitle}</Text>
                      ) : null}
                    </View>
                  </View>
                ))}
              </Panel>
            </Section>
          ) : null}
        </>
      )}
    </Screen>
  );
}

function Detail({ label, value, first }: Readonly<{ label: string; value: string | null; first?: boolean }>) {
  const { colors } = useTheme();
  if (!value) return null;
  return (
    <View style={[styles.detail, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}>
      <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.detailValue, { color: colors.text }]} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { marginTop: 32 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  headerText: { flex: 1, gap: 6 },
  job: { fontSize: 17, fontWeight: '600' },
  sub: { fontSize: 13 },
  actions: { flexDirection: 'row', gap: 10 },
  detail: { paddingHorizontal: 14, paddingVertical: 12, gap: 2 },
  detailLabel: { fontSize: 12 },
  detailValue: { fontSize: 15 },
  report: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  reportName: { fontSize: 15, fontWeight: '500' },
});
