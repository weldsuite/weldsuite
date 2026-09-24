/** Employee detail — attendance tab: last 30 days summary, records and upcoming shifts. */

import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { useHrAttendance, useHrAttendanceSummary, useHrShifts } from '@/hooks/queries/use-weldhr-queries';
import { AttendanceRecordDialog } from '../../attendance/components/record-dialog';
import { EmptyText, FieldGrid, SectionCard } from '../page-kit';
import {
  ErrorBanner,
  StatusBadge,
  errorMessage,
  formatDate,
  formatMinutes,
  formatTime,
  shiftIsoDate,
  todayIso,
} from '../shared';

export function EmployeeAttendanceTab({ employeeId }: { employeeId: string }) {
  const t = useTranslations();
  const { can } = usePermissions();
  const canWrite = can('attendance:create');

  const from = shiftIsoDate(todayIso(), -29);
  const to = todayIso();
  const upcomingTo = shiftIsoDate(todayIso(), 14);

  const { data: summary } = useHrAttendanceSummary({ from, to, employeeId });
  const { data: records, isLoading, error } = useHrAttendance({ employeeId, from, to, limit: 100 });
  const { data: shifts, isLoading: shiftsLoading } = useHrShifts({ employeeId, from: todayIso(), to: upcomingTo });

  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-4">
      <SectionCard title={t('weldhr.attendance.records.summary.last30Days')} contentClassName="pt-0">
        <FieldGrid
          fields={[
            {
              label: t('weldhr.attendance.records.summary.attendanceRate'),
              value: summary?.attendanceRate !== null && summary?.attendanceRate !== undefined ? `${summary.attendanceRate}%` : '—',
            },
            { label: t('weldhr.attendance.records.summary.workedHours'), value: formatMinutes(summary?.workedMinutes) },
            { label: t('weldhr.attendance.records.summary.lateMinutes'), value: summary?.lateMinutes ?? 0 },
            { label: t('weldhr.attendance.records.summary.absences'), value: summary?.byStatus.absent ?? 0 },
          ]}
        />
      </SectionCard>

      <SectionCard
        title={t('weldhr.attendance.records.title')}
        action={
          canWrite && (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('weldhr.attendance.records.addRecord')}
            </Button>
          )
        }
        contentClassName="p-0"
      >
        <ErrorBanner error={error ? errorMessage(error, t('weldhr.attendance.records.loadFailed')) : null} />

        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : !records || records.data.length === 0 ? (
          <EmptyText>{t('weldhr.attendance.records.empty.title')}</EmptyText>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('weldhr.attendance.records.table.date')}</TableHead>
                <TableHead>{t('weldhr.attendance.records.table.clockIn')}</TableHead>
                <TableHead>{t('weldhr.attendance.records.table.clockOut')}</TableHead>
                <TableHead>{t('weldhr.attendance.records.table.worked')}</TableHead>
                <TableHead>{t('weldhr.attendance.records.table.late')}</TableHead>
                <TableHead>{t('weldhr.attendance.records.table.status')}</TableHead>
                <TableHead>{t('weldhr.attendance.records.table.approved')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.data.map((record) => (
                <TableRow key={record.id}>
                  <TableCell>{formatDate(record.date)}</TableCell>
                  <TableCell>{formatTime(record.clockIn)}</TableCell>
                  <TableCell>{formatTime(record.clockOut)}</TableCell>
                  <TableCell>{formatMinutes(record.workedMinutes)}</TableCell>
                  <TableCell className={record.lateMinutes > 0 ? 'text-destructive' : undefined}>
                    {record.lateMinutes > 0 ? record.lateMinutes : '—'}
                  </TableCell>
                  <TableCell>
                    <StatusBadge group="attendance" status={record.status} />
                  </TableCell>
                  <TableCell>{record.approvedAt ? '✓' : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <SectionCard title={t('weldhr.attendance.tabs.schedule')}>
        {shiftsLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : !shifts || shifts.length === 0 ? (
          <EmptyText>{t('weldhr.attendance.schedule.empty.title')}</EmptyText>
        ) : (
          <ul className="divide-y">
            {shifts.map((shift) => (
              <li key={shift.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="font-medium">{formatDate(shift.startsAt)}</span>
                <span className="text-muted-foreground">
                  {formatTime(shift.startsAt)}–{formatTime(shift.endsAt)}
                  {shift.companyName ? ` · ${shift.companyName}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {adding && <AttendanceRecordDialog employeeId={employeeId} onClose={() => setAdding(false)} />}
    </div>
  );
}
