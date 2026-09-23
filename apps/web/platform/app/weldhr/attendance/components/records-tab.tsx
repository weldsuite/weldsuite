/** Attendance → Records: filterable table with approval and a summary strip. */

import { useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrAttendanceRecord, HrAttendanceStatus } from '@weldsuite/app-api-client/domains/weldhr';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useApproveHrAttendance,
  useDeleteHrAttendance,
  useHrAttendance,
  useHrAttendanceSummary,
} from '@/hooks/queries/use-weldhr-queries';
import {
  CompanyPicker,
  EmployeePicker,
  EmptyState,
  ErrorBanner,
  InlineSpinner,
  StatTile,
  StatusBadge,
  errorMessage,
  formatDate,
  formatMinutes,
  formatTime,
  shiftIsoDate,
  todayIso,
} from '../../components/shared';
import { AttendanceRecordDialog } from './record-dialog';

const STATUSES: HrAttendanceStatus[] = ['present', 'late', 'absent', 'excused', 'remote', 'half_day'];
const PAGE_SIZE = 50;

export function RecordsTab() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canWrite = can('attendance:create') || can('attendance:update');
  const canDelete = can('attendance:delete');
  const canApprove = can('attendance:approve');

  const [from, setFrom] = useState(shiftIsoDate(todayIso(), -6));
  const [to, setTo] = useState(todayIso());
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [employeeLabel, setEmployeeLabel] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyLabel, setCompanyLabel] = useState<string | null>(null);
  const [status, setStatus] = useState('all');
  const [needsApproval, setNeedsApproval] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialogState, setDialogState] = useState<'create' | HrAttendanceRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrAttendanceRecord | null>(null);

  const filters = {
    from,
    to,
    employeeId: employeeId ?? undefined,
    companyId: companyId ?? undefined,
    status: status === 'all' ? undefined : status,
    unapproved: needsApproval || undefined,
  };

  const { data, isLoading, error } = useHrAttendance({ ...filters, limit });
  const { data: summary } = useHrAttendanceSummary({ from, to, employeeId: employeeId ?? undefined, companyId: companyId ?? undefined });
  const approve = useApproveHrAttendance();
  const deleteRecord = useDeleteHrAttendance();

  const rows = data?.data ?? [];

  function toggleRow(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(rows.map((r) => r.id)) : new Set());
  }

  async function approveSelected() {
    if (selected.size === 0) return;
    try {
      await approve.mutateAsync([...selected]);
      setSelected(new Set());
    } catch {
      // ErrorBanner below reflects the mutation error.
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label={t('weldhr.attendance.records.summary.attendanceRate')} value={summary?.attendanceRate !== null && summary?.attendanceRate !== undefined ? `${summary.attendanceRate}%` : '—'} />
        <StatTile label={t('weldhr.attendance.records.summary.workedHours')} value={formatMinutes(summary?.workedMinutes)} />
        <StatTile label={t('weldhr.attendance.records.summary.lateMinutes')} value={summary?.lateMinutes ?? 0} />
        <StatTile label={t('weldhr.attendance.records.summary.absences')} value={summary?.byStatus.absent ?? 0} />
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t('weldhr.attendance.records.filters.from')}</label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t('weldhr.attendance.records.filters.to')}</label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36" />
        </div>
        <div className="w-48 space-y-1">
          <label className="text-xs text-muted-foreground">{t('weldhr.attendance.records.filters.employee')}</label>
          <EmployeePicker
            value={employeeId}
            valueLabel={employeeLabel}
            allowClear
            onChange={(id, label) => {
              setEmployeeId(id);
              setEmployeeLabel(label);
            }}
          />
        </div>
        <div className="w-48 space-y-1">
          <label className="text-xs text-muted-foreground">{t('weldhr.attendance.records.filters.client')}</label>
          <CompanyPicker
            value={companyId}
            valueLabel={companyLabel}
            allowClear
            onChange={(id, label) => {
              setCompanyId(id);
              setCompanyLabel(label);
            }}
          />
        </div>
        <div className="w-40 space-y-1">
          <label className="text-xs text-muted-foreground">{t('weldhr.attendance.records.filters.status')}</label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('weldhr.attendance.records.filters.allStatuses')}</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`weldhr.status.attendance.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center gap-2 pb-1.5 text-sm">
          <Switch checked={needsApproval} onCheckedChange={setNeedsApproval} />
          {t('weldhr.attendance.records.filters.needsApproval')}
        </label>
        <div className="ml-auto flex items-center gap-2 pb-0.5">
          {canApprove && selected.size > 0 && (
            <Button size="sm" variant="outline" onClick={() => void approveSelected()} disabled={approve.isPending}>
              {t('weldhr.attendance.records.selected', { count: selected.size })} · {t('weldhr.attendance.records.approveSelected')}
            </Button>
          )}
          {canWrite && (
            <Button size="sm" onClick={() => setDialogState('create')}>
              {t('weldhr.attendance.records.addRecord')}
            </Button>
          )}
        </div>
      </div>

      <ErrorBanner
        error={
          error
            ? errorMessage(error, t('weldhr.attendance.records.loadFailed'))
            : approve.error
              ? errorMessage(approve.error, t('weldhr.attendance.records.approveFailed'))
              : null
        }
      />

      {isLoading ? (
        <InlineSpinner />
      ) : rows.length === 0 ? (
        <EmptyState title={t('weldhr.attendance.records.empty.title')} description={t('weldhr.attendance.records.empty.description')} />
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  {canApprove && (
                    <TableHead className="w-10">
                      <Checkbox
                        checked={rows.length > 0 && selected.size === rows.length}
                        onCheckedChange={(c) => toggleAll(c === true)}
                      />
                    </TableHead>
                  )}
                  <TableHead>{t('weldhr.attendance.records.table.date')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.table.employee')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.table.client')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.table.clockIn')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.table.clockOut')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.table.break')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.table.worked')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.table.late')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.table.status')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.table.source')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.table.approved')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((record) => (
                  <TableRow key={record.id}>
                    {canApprove && (
                      <TableCell>
                        <Checkbox checked={selected.has(record.id)} onCheckedChange={(c) => toggleRow(record.id, c === true)} />
                      </TableCell>
                    )}
                    <TableCell>{formatDate(record.date)}</TableCell>
                    <TableCell>{record.employeeName}</TableCell>
                    <TableCell className="text-muted-foreground">{record.companyName ?? '—'}</TableCell>
                    <TableCell>{formatTime(record.clockIn)}</TableCell>
                    <TableCell>{formatTime(record.clockOut)}</TableCell>
                    <TableCell>{record.breakMinutes}m</TableCell>
                    <TableCell>{formatMinutes(record.workedMinutes)}</TableCell>
                    <TableCell className={record.lateMinutes > 0 ? 'text-destructive' : undefined}>
                      {record.lateMinutes > 0 ? record.lateMinutes : '—'}
                    </TableCell>
                    <TableCell>
                      <StatusBadge group="attendance" status={record.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{t(`weldhr.attendance.records.source.${record.source}`)}</TableCell>
                    <TableCell>
                      {record.approvedAt ? (
                        <Badge variant="default">{record.approvedByName ?? '✓'}</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {canWrite && (
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setDialogState(record)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {canDelete && (
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setDeleteTarget(record)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {data?.pagination.hasMore && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
                {t('weldhr.attendance.records.loadMore')}
              </Button>
            </div>
          )}
        </>
      )}

      {dialogState && (
        <AttendanceRecordDialog record={dialogState === 'create' ? undefined : dialogState} onClose={() => setDialogState(null)} />
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('weldhr.attendance.records.deleteConfirmTitle')}
        description={t('weldhr.attendance.records.deleteConfirmDescription')}
        variant="destructive"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await deleteRecord.mutateAsync(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
