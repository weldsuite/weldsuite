/** Attendance → Records: filterable list with per-row and bulk approval. */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarClock, Check } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrAttendanceRecord, HrAttendanceStatus } from '@weldsuite/app-api-client/domains/weldhr';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PanelEntityList, type ActiveFilter, type ColumnDef, type FilterConfig } from '@/components/panel-entity-list';
import {
  useApproveHrAttendance,
  useDeleteHrAttendance,
  useHrAttendance,
  useHrAttendanceSummary,
  useHrEmployees,
} from '@/hooks/queries/use-weldhr-queries';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { emptyIcon } from '../../components/page-kit';
import {
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

interface CompanyOption {
  id: string;
  displayName?: string | null;
  name?: string | null;
}

/** The list opens on the last seven days, as a regular (removable) date filter. */
function defaultFilters(): ActiveFilter[] {
  return [{ id: 'default-date', field: 'date', operator: 'after', value: shiftIsoDate(todayIso(), -6) }];
}

export function RecordsTab() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canWrite = can('attendance:create') || can('attendance:update');
  const canDelete = can('attendance:delete');
  const canApprove = can('attendance:approve');

  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>(defaultFilters);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [dialogState, setDialogState] = useState<'create' | HrAttendanceRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrAttendanceRecord | null>(null);

  const { data: employeesData } = useHrEmployees({ limit: 100 });
  const employeeOptions = employeesData?.data ?? [];
  const { getClient } = useAppApiClient();
  const { data: companiesData } = useQuery({
    queryKey: ['weldhr', 'attendance', 'company-options'],
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: CompanyOption[] }>('/companies?limit=100');
    },
    staleTime: 60_000,
  });
  const companyOptions = companiesData?.data ?? [];

  const filterValue = (field: string) => activeFilters.find((f) => f.field === field)?.value || undefined;
  const dateValue = (operator: string) =>
    activeFilters.find((f) => f.field === 'date' && f.operator === operator)?.value || undefined;
  const onDate = dateValue('is');
  const from = onDate ?? dateValue('after');
  const to = onDate ?? dateValue('before');
  const employeeId = filterValue('employeeId');
  const companyId = filterValue('companyId');
  const status = filterValue('status');
  const needsApproval = filterValue('unapproved') === 'true';

  const filters = {
    from,
    to,
    employeeId,
    companyId,
    status,
    unapproved: needsApproval || undefined,
  };

  const { data, isLoading, isFetching, error } = useHrAttendance({ ...filters, limit });
  const { data: summary } = useHrAttendanceSummary({ from, to, employeeId, companyId });
  const approve = useApproveHrAttendance();
  const deleteRecord = useDeleteHrAttendance();

  const rows = data?.data ?? [];
  const unapprovedVisible = canApprove ? rows.filter((r) => !r.approvedAt) : [];

  async function approveAllVisible() {
    if (unapprovedVisible.length === 0) return;
    try {
      await approve.mutateAsync(unapprovedVisible.map((r) => r.id));
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.attendance.records.approveFailed')));
    }
  }

  async function approveOne(id: string) {
    try {
      await approve.mutateAsync([id]);
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.attendance.records.approveFailed')));
    }
  }

  const filterConfigs: FilterConfig[] = [
    {
      field: 'date',
      label: t('weldhr.attendance.records.table.date'),
      filterType: 'date',
      options: [],
    },
    {
      field: 'employeeId',
      label: t('weldhr.attendance.records.filters.employee'),
      searchable: true,
      options: employeeOptions.map((e) => ({ value: e.id, label: e.displayName })),
    },
    {
      field: 'companyId',
      label: t('weldhr.attendance.records.filters.client'),
      searchable: true,
      options: companyOptions.map((c) => ({ value: c.id, label: c.displayName || c.name || c.id })),
    },
    {
      field: 'status',
      label: t('weldhr.attendance.records.filters.status'),
      options: STATUSES.map((s) => ({ value: s, label: t(`weldhr.status.attendance.${s}`) })),
    },
    {
      field: 'unapproved',
      label: t('weldhr.attendance.records.filters.needsApproval'),
      filterType: 'boolean',
      options: [],
    },
  ];

  const columns: ColumnDef<HrAttendanceRecord>[] = [
    {
      id: 'date',
      header: t('weldhr.attendance.records.table.date'),
      width: 'w-[100px]',
      render: (r) => <span>{formatDate(r.date)}</span>,
    },
    {
      id: 'employee',
      header: t('weldhr.attendance.records.table.employee'),
      width: 'flex-1',
      render: (r) => <span className="truncate font-medium">{r.employeeName}</span>,
    },
    {
      id: 'client',
      header: t('weldhr.attendance.records.table.client'),
      width: 'w-[140px]',
      render: (r) => <span className="truncate text-muted-foreground">{r.companyName ?? '—'}</span>,
    },
    {
      id: 'time',
      header: `${t('weldhr.attendance.records.table.clockIn')} – ${t('weldhr.attendance.records.table.clockOut')}`,
      width: 'w-[150px]',
      render: (r) => (
        <span className="text-muted-foreground">
          {formatTime(r.clockIn)} – {formatTime(r.clockOut)}
        </span>
      ),
    },
    {
      id: 'worked',
      header: t('weldhr.attendance.records.table.worked'),
      width: 'w-[130px]',
      render: (r) => (
        <span>
          {formatMinutes(r.workedMinutes)}
          {r.lateMinutes > 0 && <span className="ml-1 text-xs text-destructive">+{r.lateMinutes}m</span>}
        </span>
      ),
    },
    {
      id: 'status',
      header: t('weldhr.attendance.records.table.status'),
      width: 'w-[110px]',
      render: (r) => <StatusBadge group="attendance" status={r.status} />,
    },
    {
      id: 'source',
      header: t('weldhr.attendance.records.table.source'),
      width: 'w-[90px]',
      render: (r) => <span className="text-muted-foreground">{t(`weldhr.attendance.records.source.${r.source}`)}</span>,
    },
    {
      id: 'approved',
      header: t('weldhr.attendance.records.table.approved'),
      width: 'w-[130px]',
      render: (r) =>
        r.approvedAt ? (
          <Badge variant="default">{r.approvedByName ?? '✓'}</Badge>
        ) : canApprove ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              void approveOne(r.id);
            }}
            disabled={approve.isPending}
          >
            <Check className="mr-1 h-3.5 w-3.5" />
            {t('weldhr.leave.requests.approve')}
          </Button>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];

  return (
    <>
      <PanelEntityList<HrAttendanceRecord>
        items={rows}
        isLoading={isLoading}
        error={error}
        columns={columns}
        filters={filterConfigs}
        activeFilters={activeFilters}
        onFiltersChange={setActiveFilters}
        onEdit={canWrite ? (r) => setDialogState(r) : undefined}
        onDelete={canDelete ? (r) => setDeleteTarget(r) : undefined}
        hasMore={data?.pagination.hasMore}
        isLoadingMore={isFetching && !isLoading}
        onLoadMore={() => setLimit((l) => l + PAGE_SIZE)}
        actionButtons={
          <div className="flex flex-wrap items-center gap-1.5">
            {summary && (
              <div className="mr-1 hidden items-center gap-2 border-r pr-2 text-xs text-muted-foreground lg:flex">
                <span>
                  <strong className="font-medium text-foreground">
                    {summary.attendanceRate !== null && summary.attendanceRate !== undefined ? `${summary.attendanceRate}%` : '—'}
                  </strong>{' '}
                  {t('weldhr.attendance.records.summary.attendanceRate').toLowerCase()}
                </span>
                <span>
                  <strong className="font-medium text-foreground">{formatMinutes(summary.workedMinutes)}</strong>{' '}
                  {t('weldhr.attendance.records.summary.workedHours').toLowerCase()}
                </span>
                <span>
                  <strong className="font-medium text-foreground">{summary.byStatus.absent ?? 0}</strong>{' '}
                  {t('weldhr.attendance.records.summary.absences').toLowerCase()}
                </span>
              </div>
            )}
            {canApprove && unapprovedVisible.length > 0 && (
              <Button size="sm" variant="outline" className="h-8" onClick={() => void approveAllVisible()} disabled={approve.isPending}>
                <Check className="mr-1.5 h-4 w-4" />
                {t('weldhr.attendance.records.approveSelected')}
              </Button>
            )}
          </div>
        }
        createButton={canWrite ? { label: t('weldhr.attendance.records.addRecord'), onClick: () => setDialogState('create') } : undefined}
        emptyState={{
          icon: emptyIcon(CalendarClock),
          title: t('weldhr.attendance.records.empty.title'),
          description: t('weldhr.attendance.records.empty.description'),
        }}
      />

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
          try {
            await deleteRecord.mutateAsync(deleteTarget.id);
            setDeleteTarget(null);
          } catch (err) {
            toast.error(errorMessage(err, t('weldhr.attendance.records.deleteFailed')));
          }
        }}
      />
    </>
  );
}
