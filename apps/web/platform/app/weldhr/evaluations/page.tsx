/** WeldHR — evaluations list with scoring entry point. */

import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck, Share2 } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrEvaluation } from '@weldsuite/app-api-client/domains/weldhr';
import { useHrEmployees, useHrEvaluationForms, useHrEvaluations } from '@/hooks/queries/use-weldhr-queries';
import { useAppApiClient } from '@/lib/api/use-app-api';
import {
  PanelEntityList,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/panel-entity-list';
import { emptyIcon, useHrBreadcrumbs } from '../components/page-kit';
import { EmployeeAvatar, ScoreBadge, StatusBadge, formatDate } from '../components/shared';
import { EvaluationDialog } from './components/evaluation-dialog';

interface CompanyOption {
  id: string;
  displayName?: string | null;
  name?: string | null;
}

export default function WeldHrEvaluationsPage() {
  const t = useTranslations();
  useHrBreadcrumbs({ label: t('weldhr.evaluations.title') });
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canCreate = can('evaluations:create');

  const [search, setSearch] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [creating, setCreating] = useState(false);

  const { data: forms } = useHrEvaluationForms();
  const { data: employeesData } = useHrEmployees({ limit: 100 });
  const employeeOptions = employeesData?.data ?? [];
  const { getClient } = useAppApiClient();
  const { data: companiesData } = useQuery({
    queryKey: ['weldhr', 'evaluations', 'company-options'],
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: CompanyOption[] }>('/companies?limit=100');
    },
    staleTime: 60_000,
  });
  const companyOptions = companiesData?.data ?? [];

  const filterValue = (field: string) => activeFilters.find((f) => f.field === field)?.value;
  const employeeId = filterValue('employeeId');
  const companyId = filterValue('companyId');
  const formId = filterValue('formId');

  const { data: evaluations, isLoading, error } = useHrEvaluations({ employeeId, companyId, formId });

  const items = useMemo(() => {
    const all = evaluations ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (e) =>
        (e.employeeName ?? '').toLowerCase().includes(q) ||
        (e.formName ?? '').toLowerCase().includes(q) ||
        (e.evaluatorName ?? '').toLowerCase().includes(q),
    );
  }, [evaluations, search]);

  const filters: FilterConfig[] = [
    {
      field: 'employeeId',
      label: t('weldhr.evaluations.filters.employee'),
      searchable: true,
      options: employeeOptions.map((e) => ({ value: e.id, label: e.displayName })),
    },
    {
      field: 'companyId',
      label: t('weldhr.evaluations.filters.client'),
      searchable: true,
      options: companyOptions.map((c) => ({ value: c.id, label: c.displayName || c.name || c.id })),
    },
    {
      field: 'formId',
      label: t('weldhr.evaluations.filters.form'),
      options: (forms ?? []).map((f) => ({ value: f.id, label: f.name })),
    },
  ];

  const groups: GroupConfig<HrEvaluation>[] = [
    { id: 'draft', label: t('weldhr.status.evaluation.draft'), sortOrder: 1, filter: (e) => e.status === 'draft' },
    { id: 'submitted', label: t('weldhr.status.evaluation.submitted'), sortOrder: 2, filter: (e) => e.status === 'submitted' },
    {
      id: 'acknowledged',
      label: t('weldhr.status.evaluation.acknowledged'),
      sortOrder: 3,
      filter: (e) => e.status === 'acknowledged',
    },
    {
      id: 'other',
      label: t('weldhr.evaluations.groups.other'),
      sortOrder: 4,
      filter: (e) => !['draft', 'submitted', 'acknowledged'].includes(e.status),
    },
  ];

  const columns: ColumnDef<HrEvaluation>[] = [
    {
      id: 'employee',
      header: t('weldhr.evaluations.table.employee'),
      width: 'flex-1',
      render: (e) => (
        <Link
          to="/weldhr/employees/$employeeId"
          params={{ employeeId: e.employeeId }}
          className="flex items-center gap-2 hover:underline"
          onClick={(ev) => ev.stopPropagation()}
        >
          <EmployeeAvatar name={e.employeeName ?? ''} className="h-6 w-6" />
          <span className="truncate">{e.employeeName}</span>
        </Link>
      ),
    },
    {
      id: 'form',
      header: t('weldhr.evaluations.table.form'),
      width: 'w-[180px]',
      render: (e) => <span className="text-muted-foreground">{e.formName ?? '—'}</span>,
    },
    {
      id: 'period',
      header: t('weldhr.evaluations.table.period'),
      width: 'w-[200px]',
      render: (e) => (
        <span className="text-muted-foreground">
          {e.periodStart || e.periodEnd
            ? `${formatDate(e.periodStart)} – ${formatDate(e.periodEnd)}`
            : t('weldhr.evaluations.table.noPeriod')}
        </span>
      ),
    },
    {
      id: 'evaluator',
      header: t('weldhr.evaluations.table.evaluator'),
      width: 'w-[160px]',
      render: (e) => <span className="text-muted-foreground">{e.evaluatorName ?? '—'}</span>,
    },
    {
      id: 'score',
      header: t('weldhr.evaluations.table.score'),
      width: 'w-[100px]',
      render: (e) => <ScoreBadge score={e.overallScore} />,
    },
    {
      id: 'status',
      header: t('weldhr.common.status'),
      width: 'w-[130px]',
      render: (e) => <StatusBadge group="evaluation" status={e.status} />,
    },
    {
      id: 'shared',
      header: t('weldhr.evaluations.table.shared'),
      width: 'w-[80px]',
      render: (e) => (e.sharedWithClient ? <Share2 className="h-4 w-4 text-muted-foreground" /> : null),
    },
  ];

  return (
    <>
      <PanelEntityList<HrEvaluation>
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
        searchPlaceholder={t('weldhr.evaluations.searchPlaceholder')}
        onRowClick={(e) => void navigate({ to: '/weldhr/evaluations/$evaluationId', params: { evaluationId: e.id } })}
        createButton={canCreate ? { label: t('weldhr.evaluations.newEvaluation'), onClick: () => setCreating(true) } : undefined}
        emptyState={{
          icon: emptyIcon(ClipboardCheck),
          title: t('weldhr.evaluations.empty.title'),
          description: t('weldhr.evaluations.empty.description'),
          action: canCreate
            ? { label: t('weldhr.evaluations.newEvaluation'), onClick: () => setCreating(true) }
            : undefined,
        }}
      />

      {creating && <EvaluationDialog onClose={() => setCreating(false)} />}
    </>
  );
}
