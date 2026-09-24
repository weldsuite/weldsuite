/** Milestones sub-tab: goals, milestones and certifications across the workforce. */

import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { CheckCircle2, Target } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrMilestone, HrMilestoneStatus, HrMilestoneType } from '@weldsuite/app-api-client/domains/weldhr';
import {
  useDeleteHrMilestone,
  useHrEmployees,
  useHrMilestones,
  useUpdateHrMilestone,
} from '@/hooks/queries/use-weldhr-queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  PanelEntityList,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/panel-entity-list';
import { emptyIcon } from '../../components/page-kit';
import { StatusBadge, errorMessage, formatDate } from '../../components/shared';
import { MilestoneDialog } from './milestone-dialog';
import { ShareBadge } from './kpis-tab';

const TYPES: HrMilestoneType[] = ['goal', 'milestone', 'certification'];
const STATUSES: HrMilestoneStatus[] = ['planned', 'in_progress', 'achieved', 'missed'];

type DialogState = { kind: 'create' } | { kind: 'edit'; milestone: HrMilestone } | null;

export function MilestonesTab() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canCreate = can('evaluations:create');
  const canUpdate = can('evaluations:update');
  const canDelete = can('evaluations:delete');

  const { data: employeesData } = useHrEmployees({ limit: 100 });
  const employeeOptions = employeesData?.data ?? [];

  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrMilestone | null>(null);

  const filterValue = (field: string) => activeFilters.find((f) => f.field === field)?.value;
  const employeeId = filterValue('employeeId');
  const type = filterValue('type');

  const { data: milestones, isLoading, error } = useHrMilestones({ employeeId });
  const updateMilestone = useUpdateHrMilestone();
  const deleteMilestone = useDeleteHrMilestone();

  const items = useMemo(() => {
    const all = milestones ?? [];
    return type ? all.filter((m) => m.type === type) : all;
  }, [milestones, type]);

  async function markAchieved(id: string) {
    try {
      await updateMilestone.mutateAsync({ id, status: 'achieved' });
      toast.success(t('weldhr.performance.milestones.toastAchieved'));
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.common.saveFailed')));
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await deleteMilestone.mutateAsync(deleteTarget.id);
      toast.success(t('weldhr.performance.milestones.toastDeleted'));
      setDeleteTarget(null);
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.common.deleteFailed')));
    }
  }

  const filters: FilterConfig[] = [
    {
      field: 'employeeId',
      label: t('weldhr.common.employee'),
      searchable: true,
      options: employeeOptions.map((e) => ({ value: e.id, label: e.displayName })),
    },
    {
      field: 'type',
      label: t('weldhr.performance.milestones.dialog.type'),
      options: TYPES.map((v) => ({ value: v, label: t(`weldhr.status.milestoneType.${v}`) })),
    },
  ];

  const groups: GroupConfig<HrMilestone>[] = [
    ...STATUSES.map((s, i) => ({
      id: s,
      label: t(`weldhr.status.milestone.${s}`),
      sortOrder: i + 1,
      filter: (m: HrMilestone) => m.status === s,
    })),
    {
      id: 'other',
      label: t('weldhr.performance.milestones.groups.other'),
      sortOrder: STATUSES.length + 1,
      filter: (m) => !STATUSES.includes(m.status),
    },
  ];

  const columns: ColumnDef<HrMilestone>[] = [
    {
      id: 'employee',
      header: t('weldhr.common.employee'),
      width: 'flex-1',
      render: (m) => (
        <Link
          to="/weldhr/employees/$employeeId"
          params={{ employeeId: m.employeeId }}
          className="hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {m.employeeName}
        </Link>
      ),
    },
    {
      id: 'title',
      header: t('weldhr.performance.milestones.table.title'),
      width: 'flex-1',
      render: (m) => <span className="truncate font-medium">{m.title}</span>,
    },
    {
      id: 'type',
      header: t('weldhr.performance.milestones.table.type'),
      width: 'w-[130px]',
      render: (m) => <span>{t(`weldhr.status.milestoneType.${m.type}`)}</span>,
    },
    {
      id: 'due',
      header: t('weldhr.performance.milestones.table.due'),
      width: 'w-[110px]',
      render: (m) => <span className="text-muted-foreground">{formatDate(m.dueDate)}</span>,
    },
    {
      id: 'achieved',
      header: t('weldhr.performance.milestones.table.achieved'),
      width: 'w-[110px]',
      render: (m) => <span className="text-muted-foreground">{formatDate(m.achievedAt)}</span>,
    },
    {
      id: 'shared',
      header: t('weldhr.performance.milestones.table.shared'),
      width: 'w-[90px]',
      render: (m) => <ShareBadge shared={m.sharedWithClient} />,
    },
    {
      id: 'status',
      header: t('weldhr.common.status'),
      width: 'w-[190px]',
      render: (m) => (
        <div className="flex items-center gap-2">
          <StatusBadge group="milestone" status={m.status} />
          {canUpdate && m.status !== 'achieved' && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={updateMilestone.isPending}
              onClick={(e) => {
                e.stopPropagation();
                void markAchieved(m.id);
              }}
            >
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
              {t('weldhr.performance.milestones.markAchieved')}
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PanelEntityList<HrMilestone>
        items={items}
        isLoading={isLoading}
        error={(error as Error) ?? null}
        columns={columns}
        groups={groups}
        filters={filters}
        activeFilters={activeFilters}
        onFiltersChange={setActiveFilters}
        onRowClick={canUpdate ? (m) => setDialog({ kind: 'edit', milestone: m }) : undefined}
        onEdit={canUpdate ? (m) => setDialog({ kind: 'edit', milestone: m }) : undefined}
        onDelete={canDelete ? (m) => setDeleteTarget(m) : undefined}
        createButton={
          canCreate ? { label: t('weldhr.performance.milestones.addMilestone'), onClick: () => setDialog({ kind: 'create' }) } : undefined
        }
        emptyState={{
          icon: emptyIcon(Target),
          title: t('weldhr.performance.milestones.empty'),
          description: t('weldhr.performance.milestones.empty'),
          action: canCreate
            ? { label: t('weldhr.performance.milestones.addMilestone'), onClick: () => setDialog({ kind: 'create' }) }
            : undefined,
        }}
      />

      {dialog?.kind === 'create' && <MilestoneDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <MilestoneDialog milestone={dialog.milestone} onClose={() => setDialog(null)} />}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('weldhr.common.confirmDelete')}
        description={deleteTarget?.title ?? ''}
        confirmLabel={t('weldhr.common.delete')}
        cancelLabel={t('weldhr.common.cancel')}
        variant="destructive"
        loading={deleteMilestone.isPending}
        onConfirm={confirmDelete}
      />
    </>
  );
}
