import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Clock } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { Pill } from '@/components/Pill';
import { ErrorNote, Panel, Screen, Section } from '@/components/Screen';
import { ShiftLine } from '@/components/ShiftLine';
import { BRAND } from '@/constants/brand';
import { useAttendance } from '@/hooks/use-weldhr-queries';
import { formatDay, formatDuration, formatTime } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';

export default function ScheduleScreen() {
  const { colors } = useTheme();
  const { t, format, intlLocale } = useI18n();
  const attendance = useAttendance();
  const now = Date.now();

  const shifts = (attendance.data?.shifts ?? [])
    .filter((shift) => new Date(shift.endsAt).getTime() >= now)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const records = [...(attendance.data?.records ?? [])].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <Screen
      title={t.schedule.title}
      variant="push"
      refreshing={attendance.isRefetching}
      onRefresh={() => void attendance.refetch()}
    >
      {attendance.isPending ? (
        <ActivityIndicator style={styles.loading} />
      ) : attendance.isError ? (
        <ErrorNote message={t.common.somethingWrong} />
      ) : (
        <>
          <Section title={t.schedule.upcoming}>
            <Panel>
              {shifts.length === 0 ? (
                <Text style={[styles.empty, { color: colors.mutedForeground }]}>{t.schedule.noShifts}</Text>
              ) : (
                shifts.map((shift, index) => (
                  <View
                    key={shift.id}
                    style={[styles.row, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}
                  >
                    <Clock size={18} color={BRAND} />
                    <View style={styles.flex}>
                      <ShiftLine startsAt={shift.startsAt} endsAt={shift.endsAt} />
                      {shift.companyName || shift.notes ? (
                        <Text style={[styles.sub, { color: colors.mutedForeground }]} numberOfLines={2}>
                          {[shift.companyName, shift.notes].filter(Boolean).join(' · ')}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                ))
              )}
            </Panel>
          </Section>

          <Section title={t.schedule.history}>
            <Panel>
              {records.length === 0 ? (
                <Text style={[styles.empty, { color: colors.mutedForeground }]}>{t.schedule.noHistory}</Text>
              ) : (
                records.map((record, index) => (
                  <View
                    key={record.id}
                    style={[styles.row, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}
                  >
                    <View style={styles.flex}>
                      <Text style={[styles.title, { color: colors.text }]}>{formatDay(record.date, intlLocale)}</Text>
                      <Text style={[styles.sub, { color: colors.mutedForeground }]}>
                        {[
                          record.clockIn ? `${formatTime(record.clockIn, intlLocale)} – ${formatTime(record.clockOut, intlLocale) || '…'}` : null,
                          record.lateMinutes ? format(t.schedule.late, { minutes: record.lateMinutes }) : null,
                          record.approved ? null : t.schedule.pendingApproval,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    </View>
                    <View style={styles.right}>
                      {record.workedMinutes != null ? (
                        <Text style={[styles.worked, { color: colors.text }]}>
                          {format(t.schedule.worked, { duration: formatDuration(record.workedMinutes) })}
                        </Text>
                      ) : null}
                      <Pill
                        label={labelFor(t.attendanceStatus, record.status)}
                        tone={record.status === 'late' ? 'warning' : record.status === 'absent' ? 'danger' : 'neutral'}
                      />
                    </View>
                  </View>
                ))
              )}
            </Panel>
          </Section>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 2 },
  loading: { marginTop: 32 },
  empty: { fontSize: 14, padding: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  title: { fontSize: 15, fontWeight: '600' },
  sub: { fontSize: 13 },
  right: { alignItems: 'flex-end', gap: 6 },
  worked: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
