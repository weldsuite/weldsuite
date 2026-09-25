/** KPIs sub-tab: values per employee for a KPI over a period, with add/edit/delete. */

import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Gauge, Share2, X } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrKpiValue } from '@weldsuite/app-api-client/domains/weldhr';
import {
  useDeleteHrKpiValue,
  useHrEmployees,
  useHrKpis,
  useHrKpiValues,
} from '@/hooks/queries/use-weldhr-queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  PanelEntityList,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
} from '@/components/panel-entity-list';
import { emptyIcon } from '../../components/page-kit';
import { errorMessage, formatDate, formatKpiValue } from '../../components/shared';
import { KpiValueDialog } from './kpi-value-dialog';

type DialogState = { kind: 'create' } | { kind: 'edit'; value: HrKpiValue } | null;

export function KpisTab() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canCreate = can('evaluations:create');
  const canUpdate = can('evaluations:update');
  const canDelete = can('evaluations:delete');

  const { data: kpis } = useHrKpis();
  const { data: employeesData } = useHrEmployees({ limit: 100 });
  const employeeOptions = employeesData?.data ?? [];

  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrKpiValue | null>(null);

  const filterValue = (field: string) => activeFilters.find((f) => f.field === field)?.value;
  const kpiId = filterValue('kpiId');
  const employeeId = filterValue('employeeId');
  const from = activeFilters.find((f) => f.field === 'period' && f.operator === 'after')?.value;
  const to = activeFilters.find((f) => f.field === 'period' && f.operator === 'before')?.value;

  const { data: values, isLoading, error } = useHrKpiValues({ kpiId, employeeId, from, to });
  const deleteValue = useDeleteHrKpiValue();

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await deleteValue.mutateAsync(deleteTarget.id);
      toast.success(t('weldhr.performance.kpis.toastDeleted'));
      setDeleteTarget(null);
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.common.deleteFailed')));
    }
  }

  const filters: FilterConfig[] = [
    {
      field: 'kpiId',
      label: t('weldhr.performance.kpis.dialog.kpi'),
      options: (kpis ?? []).map((k) => ({ value: k.id, label: k.name })),
    },
    {
      field: 'employeeId',
      label: t('weldhr.common.employee'),
      searchable: true,
      options: employeeOptions.map((e) => ({ value: e.id, label: e.displayName })),
    },
    {
      field: 'period',
      label: t('weldhr.evaluations.table.period'),
      filterType: 'date',
      options: [],
    },
  ];

  const columns: ColumnDef<HrKpiValue>[] = [
    {
      id: 'employee',
      header: t('weldhr.performance.kpis.table.employee'),
      width: 'flex-1',
      render: (v) => <span className="truncate">{v.employeeName}</span>,
    },
    {
      id: 'kpi',
      header: t('weldhr.performance.kpis.table.kpi'),
      width: 'w-[160px]',
      render: (v) => <span className="text-muted-foreground">{v.kpiName}</span>,
    },
    {
      id: 'period',
      header: t('weldhr.evaluations.table.period'),
      width: 'w-[190px]',
      render: (v) => (
        <span className="text-muted-foreground">
          {formatDate(v.periodStart)} – {formatDate(v.periodEnd)}
        </span>
      ),
    },
    {
      id: 'value',
      header: t('weldhr.performance.kpis.table.value'),
      width: 'w-[110px]',
      render: (v) => <span className="font-medium tabular-nums">{formatKpiValue(v.value, v.unit)}</span>,
    },
    {
      id: 'target',
      header: t('weldhr.performance.kpis.table.target'),
      width: 'w-[110px]',
      render: (v) => (
        <span className="tabular-nums text-muted-foreground">
          {v.target === null ? '—' : formatKpiValue(v.target, v.unit)}
        </span>
      ),
    },
    {
      id: 'onTarget',
      header: t('weldhr.performance.kpis.table.onTarget'),
      width: 'w-[100px]',
      render: (v) =>
        v.onTarget === null ? (
          <span className="text-muted-foreground">—</span>
        ) : v.onTarget ? (
          <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <X className="h-4 w-4 text-destructive" />
        ),
    },
    {
      id: 'shared',
      header: t('weldhr.performance.kpis.table.shared'),
      width: 'w-[80px]',
      render: (v) =>
        v.sharedWithClient ? (
          <Badge variant="outline" className="gap-1">
            <Share2 className="h-3 w-3" />
          </Badge>
        ) : null,
    },
  ];

  return (
    <>
      <PanelEntityList<HrKpiValue>
        items={values ?? []}
        isLoading={isLoading}
        error={(error as Error) ?? null}
        columns={columns}
        filters={filters}
        activeFilters={activeFilters}
        onFiltersChange={setActiveFilters}
        onEdit={canUpdate ? (v) => setDialog({ kind: 'edit', value: v }) : undefined}
        onDelete={canDelete ? (v) => setDeleteTarget(v) : undefined}
        createButton={canCreate ? { label: t('weldhr.performance.kpis.addValue'), onClick: () => setDialog({ kind: 'create' }) } : undefined}
        emptyState={{
          icon: emptyIcon(Gauge),
          title: t('weldhr.performance.kpis.empty'),
          description: t('weldhr.performance.kpis.selectKpi'),
          action: canCreate
            ? { label: t('weldhr.performance.kpis.addValue'), onClick: () => setDialog({ kind: 'create' }) }
            : undefined,
        }}
      />

      {dialog?.kind === 'create' && <KpiValueDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <KpiValueDialog value={dialog.value} onClose={() => setDialog(null)} />}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('weldhr.common.confirmDelete')}
        description={deleteTarget ? `${deleteTarget.employeeName} · ${deleteTarget.kpiName}` : ''}
        confirmLabel={t('weldhr.common.delete')}
        cancelLabel={t('weldhr.common.cancel')}
        variant="destructive"
        loading={deleteValue.isPending}
        onConfirm={confirmDelete}
      />
    </>
  );
}

export function ShareBadge({ shared }: Readonly<{ shared: boolean }>) {
  const t = useTranslations();
  if (!shared) return null;
  return (
    <Badge variant="outline" className="gap-1">
      <Share2 className="h-3 w-3" />
      {t('weldhr.common.sharedWithClient')}
    </Badge>
  );
}
