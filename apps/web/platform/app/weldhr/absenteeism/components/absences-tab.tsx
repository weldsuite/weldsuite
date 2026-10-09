/**
 * Absenteeism → Ongoing / Completed: everyone's sick reports, for HR. Report
 * sick for an employee, report them recovered, correct or remove a report.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { HeartPulse, Repeat } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrAbsence, HrAbsenceStatus } from '@weldsuite/app-api-client/domains/weldhr';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PanelEntityList, type ActiveFilter, type ColumnDef, type FilterConfig } from '@/components/panel-entity-list';
import { useDeleteHrAbsence, useHrAbsences, useHrDepartments, useHrEmployees } from '@/hooks/queries/use-weldhr-queries';
import { emptyIcon } from '../../components/page-kit';
import { errorMessage, formatDate } from '../../components/shared';
import { AbsenceDialog } from './absence-dialog';
import { RecoverDialog } from './recover-dialog';
import { formatDays } from './shared';

const PAGE_SIZE = 50;

export function AbsencesTab({ status }: Readonly<{ status: HrAbsenceStatus }>) {
  const t = useTranslations();
  const { can } = usePermissions();
  const canCreate = can('absences:create');
  const canUpdate = can('absences:update');
  const canDelete = can('absences:delete');
  // The filters list people and departments, which is employee data of its own.
  const canPickEmployees = can('employees:read');

  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [dialogState, setDialogState] = useState<'create' | HrAbsence | null>(null);
  const [recoverTarget, setRecoverTarget] = useState<HrAbsence | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrAbsence | null>(null);

  const { data: employeesData } = useHrEmployees({ limit: 100 }, { enabled: canPickEmployees });
  const { data: departments } = useHrDepartments({ enabled: canPickEmployees });

  const filterValue = (field: string) => activeFilters.find((f) => f.field === field)?.value || undefined;
  const { data, isLoading, isFetching, error } = useHrAbsences({
    status,
    employeeId: filterValue('employeeId'),
    departmentId: filterValue('departmentId'),
    limit,
  });
  const deleteAbsence = useDeleteHrAbsence();

  const filterConfigs: FilterConfig[] = canPickEmployees
    ? [
        {
          field: 'employeeId',
          label: t('weldhr.absenteeism.list.filters.employee'),
          searchable: true,
          options: (employeesData?.data ?? []).map((e) => ({ value: e.id, label: e.displayName })),
        },
        {
          field: 'departmentId',
          label: t('weldhr.absenteeism.list.filters.department'),
          options: (departments ?? []).map((d) => ({ value: d.id, label: d.name })),
        },
      ]
    : [];

  const columns: ColumnDef<HrAbsence>[] = [
    {
      id: 'employee',
      header: t('weldhr.absenteeism.table.employee'),
      // Never narrower than a name: on a small screen the columns to the right give way instead.
      width: 'grow-[2] shrink-0 basis-36',
      render: (r) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium" title={r.departmentName ?? undefined}>
            {r.employeeName}
          </span>
          {r.relapse && (
            <span className="shrink-0" title={`${t('weldhr.absenteeism.relapse')}: ${t('weldhr.absenteeism.relapseHelp')}`}>
              <Repeat className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden />
              <span className="sr-only">{t('weldhr.absenteeism.relapse')}</span>
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'firstSickDay',
      header: t('weldhr.absenteeism.table.firstSickDay'),
      width: 'w-[150px]',
      render: (r) => (
        <span className="block truncate">
          {formatDate(r.startDate)}
          {r.firstDay === 'half' && <span className="text-muted-foreground"> · {t('weldhr.absenteeism.halfFirstDay')}</span>}
        </span>
      ),
    },
    {
      id: 'lastSickDay',
      header: t('weldhr.absenteeism.table.lastSickDay'),
      width: 'w-[105px]',
      render: (r) =>
        r.endDate ? <span>{formatDate(r.endDate)}</span> : <span className="text-muted-foreground">{t('weldhr.absenteeism.stillAbsent')}</span>,
    },
    {
      id: 'days',
      header: t('weldhr.absenteeism.table.days'),
      width: 'w-[45px]',
      render: (r) => <span className="tabular-nums">{formatDays(r.days)}</span>,
    },
    {
      id: 'note',
      header: t('weldhr.absenteeism.table.note'),
      width: 'grow shrink basis-24',
      render: (r) => (
        <span className="block truncate text-muted-foreground" title={r.note ?? undefined}>
          {r.note ?? '—'}
        </span>
      ),
    },
    {
      id: 'reportedBy',
      header: t('weldhr.absenteeism.table.reportedBy'),
      width: 'w-[100px]',
      render: (r) => (
        <span className="block truncate text-muted-foreground">
          {r.reportedBySelf ? t('weldhr.absenteeism.reportedBySelf') : r.reportedByName ?? '—'}
        </span>
      ),
    },
    ...(status === 'ongoing' && canUpdate
      ? [
          {
            id: 'recover',
            header: '',
            width: 'w-[140px]',
            render: (r: HrAbsence) =>
              r.endDate === null ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRecoverTarget(r);
                  }}
                >
                  {t('weldhr.absenteeism.reportRecovered')}
                </Button>
              ) : null,
          },
        ]
      : []),
  ];

  const empty = status === 'ongoing' ? 'emptyOngoing' : 'emptyCompleted';

  return (
    <>
      <PanelEntityList<HrAbsence>
        items={data?.data ?? []}
        isLoading={isLoading}
        error={error}
        columns={columns}
        filters={filterConfigs}
        activeFilters={activeFilters}
        onFiltersChange={setActiveFilters}
        onEdit={canUpdate ? (r) => setDialogState(r) : undefined}
        onDelete={canDelete ? (r) => setDeleteTarget(r) : undefined}
        hasMore={data?.pagination.hasMore}
        isLoadingMore={isFetching && !isLoading}
        onLoadMore={() => setLimit((l) => l + PAGE_SIZE)}
        createButton={canCreate ? { label: t('weldhr.absenteeism.reportSick'), onClick: () => setDialogState('create') } : undefined}
        emptyState={{
          icon: emptyIcon(HeartPulse),
          title: t(`weldhr.absenteeism.list.${empty}.title`),
          description: t(`weldhr.absenteeism.list.${empty}.description`),
        }}
      />

      {dialogState && (
        <AbsenceDialog
          mode={dialogState === 'create' ? { kind: 'create' } : { kind: 'edit', absence: dialogState }}
          onClose={() => setDialogState(null)}
        />
      )}

      {recoverTarget && (
        <RecoverDialog absence={recoverTarget} employeeName={recoverTarget.employeeName} onClose={() => setRecoverTarget(null)} />
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('weldhr.absenteeism.deleteConfirmTitle')}
        description={t('weldhr.absenteeism.deleteConfirmDescription')}
        variant="destructive"
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteAbsence.mutateAsync(deleteTarget.id);
            setDeleteTarget(null);
          } catch (err) {
            toast.error(errorMessage(err, t('weldhr.absenteeism.deleteFailed')));
          }
        }}
      />
    </>
  );
}
