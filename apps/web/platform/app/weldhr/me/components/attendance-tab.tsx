/** My HR → Attendance: clock records and shifts for a date range (the last 30 days and the next two weeks by default). */

import { useState } from 'react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import { useMyHrAttendance } from '@/hooks/queries/use-weldhr-queries';
import { EmptyText, SectionCard } from '../../components/page-kit';
import {
  ErrorBanner,
  StatusBadge,
  errorMessage,
  formatDate,
  formatMinutes,
  formatTime,
  shiftIsoDate,
  todayIso,
} from '../../components/shared';
import { TabLoading } from './shared';
import { UpcomingShiftsCard } from './shifts-card';

/** The API refuses ranges longer than this. */
const MAX_RANGE_DAYS = 92;

export function MyAttendanceTab() {
  const t = useTranslations();
  const [from, setFrom] = useState(() => shiftIsoDate(todayIso(), -29));
  const [to, setTo] = useState(() => shiftIsoDate(todayIso(), 14));
  const validRange = Boolean(from && to && from <= to && shiftIsoDate(from, MAX_RANGE_DAYS) >= to);

  const { data, isLoading, error } = useMyHrAttendance({ from, to }, { enabled: validRange });

  if (isLoading) return <TabLoading />;

  return (
    <div className="space-y-4">
      <ErrorBanner error={error ? errorMessage(error, t('weldhr.me.attendance.loadFailed')) : null} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="my-hr-attendance-from">{t('weldhr.common.from')}</Label>
          <Input
            id="my-hr-attendance-from"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(event) => setFrom(event.target.value)}
            className="w-40"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="my-hr-attendance-to">{t('weldhr.common.to')}</Label>
          <Input
            id="my-hr-attendance-to"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(event) => setTo(event.target.value)}
            className="w-40"
          />
        </div>
        {!validRange && <p className="pb-2 text-sm text-destructive">{t('weldhr.me.attendance.invalidRange')}</p>}
      </div>

      <UpcomingShiftsCard
        shifts={data?.shifts ?? []}
        title={t('weldhr.me.attendance.shiftsTitle')}
        emptyText={t('weldhr.me.attendance.shiftsEmpty')}
      />

      <SectionCard title={t('weldhr.me.attendance.title')} contentClassName="p-0">
        {!data || data.records.length === 0 ? (
          <EmptyText>{t('weldhr.me.attendance.empty')}</EmptyText>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('weldhr.me.attendance.table.date')}</TableHead>
                <TableHead>{t('weldhr.me.attendance.table.clockIn')}</TableHead>
                <TableHead>{t('weldhr.me.attendance.table.clockOut')}</TableHead>
                <TableHead>{t('weldhr.me.attendance.table.break')}</TableHead>
                <TableHead>{t('weldhr.me.attendance.table.worked')}</TableHead>
                <TableHead>{t('weldhr.me.attendance.table.status')}</TableHead>
                <TableHead>{t('weldhr.me.attendance.table.client')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.records.map((record) => (
                <TableRow key={record.id}>
                  <TableCell className="whitespace-nowrap">{formatDate(record.date)}</TableCell>
                  <TableCell>{formatTime(record.clockIn)}</TableCell>
                  <TableCell>{formatTime(record.clockOut)}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatMinutes(record.breakMinutes)}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatMinutes(record.workedMinutes)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusBadge group="attendance" status={record.status} />
                      {record.lateMinutes !== null && record.lateMinutes > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {t('weldhr.me.attendance.lateBy', { minutes: record.lateMinutes })}
                        </span>
                      )}
                      {!record.approved && <Badge variant="outline">{t('weldhr.me.attendance.awaitingApproval')}</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{record.companyName ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}
