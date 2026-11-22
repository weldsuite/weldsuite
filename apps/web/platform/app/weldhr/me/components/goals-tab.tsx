/**
 * My HR → Performance → KPIs and Milestones: each KPI with its latest
 * result against the target (off target first), and your goals, milestones and
 * certifications by status. A row opens its panel (a KPI's with its history).
 */

import { Flag, Target } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfPerformance } from '@weldsuite/app-api-client/domains/weldhr';
import { useObjectPanel } from '@/components/object-panel';
import { MY_KPI_PANEL_TYPE, MY_MILESTONE_PANEL_TYPE } from '@/components/objects/hr-my-hr/types';
import {
  PanelEntityList,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/panel-entity-list';
import { useMyHrPerformance } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { HR_COL, HrListContainer, emptyIcon } from '../../components/page-kit';
import { StatusBadge, errorMessage, formatDate, formatKpiValue } from '../../components/shared';

export type MyKpiResult = HrSelfPerformance['kpis'][number];
export type MyMilestone = HrSelfPerformance['milestones'][number];
/** A KPI's latest result, keyed by the KPI so its panel can show the history. */
type KpiRow = MyKpiResult & { id: string };
type KpiResult = 'off' | 'on' | 'none';

/** The most recent result of each KPI. */
function latestPerKpi(kpis: MyKpiResult[]): KpiRow[] {
  const latest = new Map<string, MyKpiResult>();
  for (const kpi of kpis) {
    const current = latest.get(kpi.kpiId);
    if (!current || kpi.periodEnd > current.periodEnd) latest.set(kpi.kpiId, kpi);
  }
  return Array.from(latest.values(), (kpi) => ({ ...kpi, id: kpi.kpiId }));
}

function resultOf(kpi: MyKpiResult): KpiResult {
  if (kpi.onTarget === null) return 'none';
  return kpi.onTarget ? 'on' : 'off';
}

/** On target, off target or no target, as a soft pill. */
export function KpiResultBadge({ kpi }: Readonly<{ kpi: MyKpiResult }>) {
  const t = useTranslations();
  const result = resultOf(kpi);
  if (result === 'none') return <span className="text-muted-foreground">{t('weldhr.me.goals.kpis.noTarget')}</span>;
  return (
    <span
      className={cn(
        'inline-flex rounded px-2 py-0.5 text-[12px] font-medium',
        result === 'on'
          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400'
          : 'bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400',
      )}
    >
      {result === 'on' ? t('weldhr.me.goals.kpis.onTarget') : t('weldhr.me.goals.kpis.offTarget')}
    </span>
  );
}

export function MyKpisList() {
  const t = useTranslations();
  const { data, isLoading, error } = useMyHrPerformance();
  const { open: openPanel } = useObjectPanel();
  const rows = latestPerKpi(data?.kpis ?? []);

  const resultLabel = (result: KpiResult) =>
    ({
      off: t('weldhr.me.goals.kpis.offTarget'),
      on: t('weldhr.me.goals.kpis.onTarget'),
      none: t('weldhr.me.goals.kpis.noTarget'),
    })[result];
  const results: KpiResult[] = ['off', 'on', 'none'];
  const groups: GroupConfig<KpiRow>[] = results.map((result, index) => ({
    id: result,
    label: resultLabel(result),
    sortOrder: index + 1,
    filter: (kpi) => resultOf(kpi) === result,
  }));
  const filters: FilterConfig[] = [
    {
      field: 'result',
      label: t('weldhr.me.goals.kpis.table.result'),
      operators: ['is'],
      options: results.map((result) => ({ value: result, label: resultLabel(result) })),
    },
  ];
  const applyFilters = (list: KpiRow[], active: ActiveFilter[]) =>
    active.reduce(
      (rowsLeft, filter) => (filter.field === 'result' && filter.value ? rowsLeft.filter((kpi) => resultOf(kpi) === filter.value) : rowsLeft),
      list,
    );

  const target = (kpi: MyKpiResult) => (kpi.target === null ? '—' : formatKpiValue(kpi.target, kpi.unit));
  const columns: ColumnDef<KpiRow>[] = [
    {
      id: 'kpi',
      header: t('weldhr.me.goals.kpis.table.kpi'),
      width: HR_COL.main,
      render: (kpi) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{kpi.kpiName}</p>
          {/* What the hidden columns would show, once the list is too narrow for them. */}
          <p className="truncate text-xs text-muted-foreground tabular-nums @lg:hidden">
            {formatKpiValue(kpi.value, kpi.unit)} / {target(kpi)}
          </p>
        </div>
      ),
    },
    {
      id: 'value',
      header: t('weldhr.me.goals.kpis.table.value'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[120px]'),
      render: (kpi) => <span className="font-semibold tabular-nums">{formatKpiValue(kpi.value, kpi.unit)}</span>,
    },
    {
      id: 'target',
      header: t('weldhr.me.goals.kpis.table.target'),
      width: cn(HR_COL.fixed, HR_COL.hideMd, 'w-[110px]'),
      render: (kpi) => <span className="tabular-nums text-muted-foreground">{target(kpi)}</span>,
    },
    {
      id: 'result',
      header: t('weldhr.me.goals.kpis.table.result'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[120px]'),
      render: (kpi) => <KpiResultBadge kpi={kpi} />,
    },
    {
      id: 'period',
      header: t('weldhr.me.goals.kpis.table.period'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[200px]'),
      render: (kpi) => (
        <span className="block truncate tabular-nums text-muted-foreground">
          {formatDate(kpi.periodStart)} – {formatDate(kpi.periodEnd)}
        </span>
      ),
    },
  ];

  return (
    <HrListContainer>
      <PanelEntityList<KpiRow>
        items={rows}
        isLoading={isLoading}
        error={data ? null : error ? new Error(errorMessage(error, t('weldhr.me.goals.loadFailed'))) : null}
        columns={columns}
        onRowClick={(kpi) => openPanel({ type: MY_KPI_PANEL_TYPE, id: kpi.kpiId })}
        objectPanel={{ type: MY_KPI_PANEL_TYPE }}
        groups={groups}
        filters={filters}
        applyFilters={applyFilters}
        searchFields={['kpiName']}
        searchPlaceholder={t('weldhr.me.goals.kpis.searchPlaceholder')}
        emptyState={{
          icon: emptyIcon(Target),
          title: t('weldhr.me.goals.kpis.listEmpty.title'),
          description: t('weldhr.me.goals.kpis.listEmpty.description'),
        }}
      />
    </HrListContainer>
  );
}

const MILESTONE_STATUSES = ['in_progress', 'planned', 'achieved', 'missed'] as const;
const MILESTONE_TYPES = ['goal', 'milestone', 'certification'] as const;

export function MyMilestonesList() {
  const t = useTranslations();
  const { data, isLoading, error } = useMyHrPerformance();
  const { open: openPanel } = useObjectPanel();
  const milestones = data?.milestones ?? [];

  // By status, what is being worked on first; an unknown status goes last.
  const groups: GroupConfig<MyMilestone>[] = [
    ...MILESTONE_STATUSES.map((status, index) => ({
      id: status,
      label: t(`weldhr.status.milestone.${status}`),
      sortOrder: index + 1,
      filter: (m: MyMilestone) => m.status === status,
    })),
    {
      id: 'other',
      label: t('weldhr.leave.requests.groups.other'),
      sortOrder: 9,
      filter: (m: MyMilestone) => !(MILESTONE_STATUSES as readonly string[]).includes(m.status),
    },
  ];

  const filters: FilterConfig[] = [
    {
      field: 'status',
      label: t('weldhr.me.goals.milestones.table.status'),
      operators: ['is'],
      options: MILESTONE_STATUSES.map((status) => ({ value: status, label: t(`weldhr.status.milestone.${status}`) })),
    },
    {
      field: 'type',
      label: t('weldhr.me.goals.milestones.table.type'),
      operators: ['is'],
      options: MILESTONE_TYPES.map((type) => ({ value: type, label: t(`weldhr.status.milestoneType.${type}`) })),
    },
  ];
  const applyFilters = (rows: MyMilestone[], active: ActiveFilter[]) =>
    active.reduce((list, filter) => {
      if (!filter.value) return list;
      if (filter.field === 'status') return list.filter((m) => m.status === filter.value);
      if (filter.field === 'type') return list.filter((m) => m.type === filter.value);
      return list;
    }, rows);

  const columns: ColumnDef<MyMilestone>[] = [
    {
      id: 'milestone',
      header: t('weldhr.me.goals.milestones.table.milestone'),
      width: HR_COL.main,
      render: (m) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{m.title}</p>
          {/* What the hidden columns would show, once the list is too narrow for them. */}
          <p className="truncate text-xs text-muted-foreground tabular-nums @lg:hidden">
            {[t(`weldhr.status.milestoneType.${m.type}`), m.dueDate ? formatDate(m.dueDate) : null].filter(Boolean).join(' · ')}
          </p>
        </div>
      ),
    },
    {
      id: 'type',
      header: t('weldhr.me.goals.milestones.table.type'),
      width: cn(HR_COL.fixed, HR_COL.hideMd, 'w-[120px]'),
      render: (m) => <span className="block truncate">{t(`weldhr.status.milestoneType.${m.type}`)}</span>,
    },
    {
      id: 'due',
      header: t('weldhr.me.goals.milestones.table.due'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[110px]'),
      render: (m) => <span className="tabular-nums">{m.dueDate ? formatDate(m.dueDate) : '—'}</span>,
    },
    {
      id: 'achieved',
      header: t('weldhr.me.goals.milestones.table.achieved'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[110px]'),
      render: (m) => <span className="tabular-nums text-muted-foreground">{m.achievedAt ? formatDate(m.achievedAt) : '—'}</span>,
    },
    {
      id: 'client',
      header: t('weldhr.me.goals.milestones.table.client'),
      width: cn(HR_COL.fixed, HR_COL.hideXl, 'w-[150px]'),
      render: (m) => <span className="block truncate text-muted-foreground">{m.companyName ?? '—'}</span>,
    },
    {
      id: 'status',
      header: t('weldhr.me.goals.milestones.table.status'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[120px]'),
      render: (m) => <StatusBadge group="milestone" status={m.status} />,
    },
  ];

  return (
    <HrListContainer>
      <PanelEntityList<MyMilestone>
        items={milestones}
        isLoading={isLoading}
        error={data ? null : error ? new Error(errorMessage(error, t('weldhr.me.goals.loadFailed'))) : null}
        columns={columns}
        onRowClick={(m) => openPanel({ type: MY_MILESTONE_PANEL_TYPE, id: m.id })}
        objectPanel={{ type: MY_MILESTONE_PANEL_TYPE }}
        groups={groups}
        filters={filters}
        applyFilters={applyFilters}
        searchFields={['title', 'description', 'companyName']}
        searchPlaceholder={t('weldhr.me.goals.milestones.searchPlaceholder')}
        emptyState={{
          icon: emptyIcon(Flag),
          title: t('weldhr.me.goals.milestones.listEmpty.title'),
          description: t('weldhr.me.goals.milestones.listEmpty.description'),
        }}
      />
    </HrListContainer>
  );
}
