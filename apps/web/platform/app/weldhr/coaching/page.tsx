/**
 * WeldHR — coaching log. Filterable list of coaching sessions across the
 * workforce; logging, editing and closing sessions happens through
 * {@link CoachingDialog}.
 */

import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, MessageSquareText } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrCoachingCategory, HrCoachingLog } from '@weldsuite/app-api-client/domains/weldhr';
import {
  useDeleteHrCoaching,
  useHrCoaching,
  useHrEmployees,
  useUpdateHrCoaching,
} from '@/hooks/queries/use-weldhr-queries';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  PanelEntityList,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/panel-entity-list';
import { cn } from '@/lib/utils';
import { emptyIcon, useHrBreadcrumbs } from '../components/page-kit';
import { EmployeeAvatar, StatusBadge, errorMessage, formatDate, todayIso } from '../components/shared';
import { CoachingDialog } from './components/coaching-dialog';

const CATEGORIES: HrCoachingCategory[] = [
  'performance',
  'quality',
  'behavior',
  'attendance',
  'development',
  'recognition',
];

type DialogState = { kind: 'create' } | { kind: 'edit'; log: HrCoachingLog } | null;

interface CompanyOption {
  id: string;
  displayName?: string | null;
  name?: string | null;
}

export default function WeldHrCoachingPage() {
  const t = useTranslations();
  useHrBreadcrumbs({ label: t('weldhr.coaching.title') });
  const { can } = usePermissions();
  const canCreate = can('coaching:create');
  const canUpdate = can('coaching:update');
  const canDelete = can('coaching:delete');

  const [search, setSearch] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrCoachingLog | null>(null);

  const { getClient } = useAppApiClient();
  const { data: employeesData } = useHrEmployees({ limit: 100 });
  const { data: companiesData } = useQuery({
    queryKey: ['weldhr', 'coaching', 'company-options'],
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: CompanyOption[] }>('/companies?limit=100');
    },
    staleTime: 60_000,
  });
  const employeeOptions = employeesData?.data ?? [];
  const companyOptions = companiesData?.data ?? [];

  const filterValue = (field: string) => activeFilters.find((f) => f.field === field)?.value;
  const employeeId = filterValue('employeeId');
  const companyId = filterValue('companyId');
  const category = filterValue('category');
  const from = activeFilters.find((f) => f.field === 'sessionDate' && f.operator === 'after')?.value;
  const to = activeFilters.find((f) => f.field === 'sessionDate' && f.operator === 'before')?.value;

  const { data: logs, isLoading, error } = useHrCoaching({ employeeId, companyId, category, from, to });
  const updateCoaching = useUpdateHrCoaching();
  const deleteCoaching = useDeleteHrCoaching();

  const items = useMemo(() => {
    const all = logs ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (log) =>
        log.topic.toLowerCase().includes(q) ||
        (log.employeeName ?? '').toLowerCase().includes(q) ||
        (log.coachName ?? '').toLowerCase().includes(q) ||
        (log.notes ?? '').toLowerCase().includes(q),
    );
  }, [logs, search]);

  const followUpDue = (log: HrCoachingLog) =>
    Boolean(log.followUpDate) && log.followUpDate! <= todayIso() && log.status !== 'closed';

  async function closeSession(log: HrCoachingLog) {
    try {
      await updateCoaching.mutateAsync({ id: log.id, status: 'closed' });
      toast.success(t('weldhr.coaching.toastClosed'));
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.common.saveFailed')));
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await deleteCoaching.mutateAsync(deleteTarget.id);
      toast.success(t('weldhr.coaching.toastDeleted'));
      setDeleteTarget(null);
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.common.deleteFailed')));
    }
  }

  const filters: FilterConfig[] = [
    {
      field: 'category',
      label: t('weldhr.coaching.filters.category'),
      options: CATEGORIES.map((c) => ({ value: c, label: t(`weldhr.status.coachingCategory.${c}`) })),
    },
    {
      field: 'employeeId',
      label: t('weldhr.coaching.filters.employee'),
      searchable: true,
      options: employeeOptions.map((e) => ({ value: e.id, label: e.displayName })),
    },
    {
      field: 'companyId',
      label: t('weldhr.coaching.filters.client'),
      searchable: true,
      options: companyOptions.map((c) => ({ value: c.id, label: c.displayName || c.name || c.id })),
    },
    {
      field: 'sessionDate',
      label: t('weldhr.coaching.dialog.sessionDate'),
      filterType: 'date',
      options: [],
    },
  ];

  const groups: GroupConfig<HrCoachingLog>[] = [
    { id: 'followUpDue', label: t('weldhr.coaching.filters.followUpDue'), sortOrder: 1, filter: followUpDue },
    {
      id: 'open',
      label: t('weldhr.status.coaching.open'),
      sortOrder: 2,
      filter: (log) => log.status === 'open' && !followUpDue(log),
    },
    {
      id: 'acknowledged',
      label: t('weldhr.status.coaching.acknowledged'),
      sortOrder: 3,
      filter: (log) => log.status === 'acknowledged' && !followUpDue(log),
    },
    { id: 'closed', label: t('weldhr.status.coaching.closed'), sortOrder: 4, filter: (log) => log.status === 'closed' },
    {
      id: 'other',
      label: t('weldhr.coaching.groups.other'),
      sortOrder: 5,
      filter: (log) => !['open', 'acknowledged', 'closed'].includes(log.status),
    },
  ];

  const columns: ColumnDef<HrCoachingLog>[] = [
    {
      id: 'date',
      header: t('weldhr.coaching.table.date'),
      width: 'w-[100px]',
      render: (log) => <span className="text-muted-foreground">{formatDate(log.sessionDate)}</span>,
    },
    {
      id: 'employee',
      header: t('weldhr.coaching.table.employee'),
      width: 'flex-1',
      render: (log) => (
        <Link
          to="/weldhr/employees/$employeeId"
          params={{ employeeId: log.employeeId }}
          className="flex items-center gap-2 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          <EmployeeAvatar name={log.employeeName ?? ''} className="h-6 w-6" />
          <span className="truncate">{log.employeeName}</span>
        </Link>
      ),
    },
    {
      id: 'coach',
      header: t('weldhr.coaching.table.coach'),
      width: 'w-[130px]',
      render: (log) => <span className="text-muted-foreground">{log.coachName ?? '—'}</span>,
    },
    {
      id: 'category',
      header: t('weldhr.coaching.table.category'),
      width: 'w-[120px]',
      render: (log) => <span>{t(`weldhr.status.coachingCategory.${log.category}`)}</span>,
    },
    {
      id: 'topic',
      header: t('weldhr.coaching.table.topic'),
      width: 'flex-1',
      render: (log) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{log.topic}</p>
          {log.acknowledgedAt && (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3 w-3" />
              {t('weldhr.coaching.table.acknowledged')}
            </p>
          )}
        </div>
      ),
    },
    {
      id: 'client',
      header: t('weldhr.coaching.table.client'),
      width: 'w-[140px]',
      render: (log) => <span className="text-muted-foreground">{log.companyName ?? '—'}</span>,
    },
    {
      id: 'status',
      header: t('weldhr.common.status'),
      width: 'w-[170px]',
      render: (log) => (
        <div className="flex items-center gap-2">
          <StatusBadge group="coaching" status={log.status} />
          {canUpdate && log.status !== 'closed' && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={updateCoaching.isPending}
              onClick={(e) => {
                e.stopPropagation();
                void closeSession(log);
              }}
            >
              {t('weldhr.coaching.closeSession')}
            </Button>
          )}
        </div>
      ),
    },
    {
      id: 'visibility',
      header: t('weldhr.coaching.table.visibility'),
      width: 'w-[110px]',
      render: (log) => (
        <Badge variant={log.visibility === 'internal' ? 'secondary' : 'outline'}>
          {t(`weldhr.status.visibility.${log.visibility}`)}
        </Badge>
      ),
    },
    {
      id: 'followUp',
      header: t('weldhr.coaching.table.followUp'),
      width: 'w-[110px]',
      render: (log) => (
        <span className={cn(followUpDue(log) && 'font-medium text-amber-600 dark:text-amber-400')}>
          {formatDate(log.followUpDate)}
        </span>
      ),
    },
  ];

  return (
    <>
      <PanelEntityList<HrCoachingLog>
        items={items}
        isLoading={isLoading}
        error={(error as Error) ?? null}
        columns={columns}
        groups={groups}
        filters={filters}
        activeFilters={activeFilters}
        onFiltersChange={setActiveFilters}
        searchQuery={search}
        onSearchChange={setSearch}
        searchPlaceholder={t('weldhr.coaching.searchPlaceholder')}
        onRowClick={canUpdate ? (log) => setDialog({ kind: 'edit', log }) : undefined}
        onEdit={canUpdate ? (log) => setDialog({ kind: 'edit', log }) : undefined}
        onDelete={canDelete ? (log) => setDeleteTarget(log) : undefined}
        createButton={canCreate ? { label: t('weldhr.coaching.logSession'), onClick: () => setDialog({ kind: 'create' }) } : undefined}
        emptyState={{
          icon: emptyIcon(MessageSquareText),
          title: t('weldhr.coaching.empty.title'),
          description: t('weldhr.coaching.empty.description'),
          action: canCreate
            ? { label: t('weldhr.coaching.logSession'), onClick: () => setDialog({ kind: 'create' }) }
            : undefined,
        }}
      />

      {dialog?.kind === 'create' && <CoachingDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <CoachingDialog log={dialog.log} onClose={() => setDialog(null)} />}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('weldhr.common.confirmDelete')}
        description={deleteTarget?.topic ?? ''}
        confirmLabel={t('weldhr.common.delete')}
        cancelLabel={t('weldhr.common.cancel')}
        variant="destructive"
        loading={deleteCoaching.isPending}
        onConfirm={confirmDelete}
      />
    </>
  );
}
