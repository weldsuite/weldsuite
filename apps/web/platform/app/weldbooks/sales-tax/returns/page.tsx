import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { CalendarX, Loader2 } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  EmptyStateIllustration,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  RowAmount,
  RowDate,
  RowNumberChip,
  RowText,
  RowTitle,
  StatusChip,
  type ChipTone,
} from '@/components/accounting/weldbooks-row-cells';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useSalesTaxPeriods } from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { AgencyPeriods, PeriodRow, PeriodState } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { ErrorState } from '../shared/query-states';
import { SalesTaxFrame } from '../shared/sales-tax-frame';
import { dueCountdown, dueTone, fill } from '../shared/text';
import { useOpenReturn } from '../shared/use-open-return';
import {
  PERIOD_STATUS_FILTERS,
  filterAgencyPeriods,
  periodMatchesStatus,
  type PeriodStatusFilter,
} from './period-filters';

/** One filing period of an agency, as a list row. */
interface PeriodListRow {
  /** The period's tax calendar key. */
  id: string;
  agency: AgencyPeriods;
  period: PeriodRow;
}

const PERIOD_STATE_TONE: Record<PeriodState, ChipTone> = {
  upcoming: 'gray',
  in_progress: 'blue',
  due: 'amber',
  overdue: 'red',
  filed: 'green',
  paid: 'green',
};

const RETURN_STATUS_TONE: Record<string, ChipTone> = {
  open: 'gray',
  calculated: 'blue',
  reviewed: 'blue',
  filed: 'green',
  paid: 'green',
};

/** The key that tells which period is being opened. */
function periodKey(period: Pick<PeriodRow, 'agencyId' | 'periodEnd'>): string {
  return `${period.agencyId}:${period.periodEnd}`;
}

/** The agency and status filters work on the loaded periods: `is` keeps the match, `is not` drops it. */
function applyPeriodFilters(items: PeriodListRow[], activeFilters: ActiveFilter[]): PeriodListRow[] {
  let result = items;
  for (const filter of activeFilters) {
    if (!filter.operator || !filter.value) continue;
    const keep = filter.operator === 'is';
    if (filter.field === 'agency') {
      result = result.filter((row) => (row.agency.agencyId === filter.value) === keep);
    } else if (filter.field === 'status') {
      result = result.filter((row) => periodMatchesStatus(row.period, filter.value as PeriodStatusFilter) === keep);
    }
  }
  return result;
}

function ReturnsContent() {
  const { t } = useI18n();
  const tc = t.weldbooksUs.salesTax.center;
  const tp = tc.periodsPage;
  const { can } = usePermissions();
  const navigate = useNavigate();
  const { formatDate, formatMoney } = useWeldbooksFormat();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { open, openingKey } = useOpenReturn();

  const query = useSalesTaxPeriods({ from: from || undefined, to: to || undefined });
  const data = query.data;
  const canCreate = can('taxes:create');
  const frequencies = tc.frequencies as Record<string, string>;
  const bases = tc.bases as Record<string, string>;
  const returnStatuses = tc.returnStatuses as Record<string, string>;

  const agencies = useMemo(
    () => (data ? filterAgencyPeriods(data.agencies, { agencyId: 'all', status: 'all' }) : []),
    [data],
  );
  const rows = useMemo<PeriodListRow[]>(
    () => agencies.flatMap((agency) => agency.periods.map((period) => ({ id: period.key, agency, period }))),
    [agencies],
  );

  const statusLabels: Record<PeriodStatusFilter, string> = {
    all: tp.allStatuses,
    attention: tp.needsAttention,
    ...tc.periodStates,
  };

  const filters: FilterConfig[] = [
    {
      field: 'agency',
      label: tp.agencyFilter,
      options: (data?.agencies ?? []).map((agency) => ({ value: agency.agencyId, label: agency.agencyName })),
    },
    {
      field: 'status',
      label: tp.statusFilter,
      options: PERIOD_STATUS_FILTERS.filter((value) => value !== 'all').map((value) => ({
        value,
        label: statusLabels[value],
      })),
    },
  ];

  const groups: GroupConfig<PeriodListRow>[] = agencies.map((agency, index) => ({
    id: agency.agencyId,
    label: agency.agencyName,
    sortOrder: index,
    filter: (row) => row.agency.agencyId === agency.agencyId,
    leadingContent: <RowNumberChip>{agency.stateCode}</RowNumberChip>,
    rightContent: (
      <span className="text-xs text-muted-foreground">
        {fill(tp.filingSetup, {
          frequency: frequencies[agency.filingFrequency] ?? agency.filingFrequency,
          day: agency.dueDay,
          basis: bases[agency.reportingBasis] ?? agency.reportingBasis,
        })}
      </span>
    ),
  }));

  const columns: ColumnDef<PeriodListRow>[] = [
    {
      id: 'period',
      header: tp.period,
      width: 'min-w-[200px] flex-1 gap-2',
      render: ({ period }) => (
        <RowTitle>
          {fill(tc.overview.periodRange, {
            start: formatDate(period.periodStart),
            end: formatDate(period.periodEnd),
          })}
        </RowTitle>
      ),
    },
    {
      id: 'dueDate',
      header: tp.dueDate,
      width: 'w-[190px] gap-2',
      render: ({ period }) => {
        const ret = period.return;
        const done = ret?.status === 'filed' || ret?.status === 'paid';
        const tone = dueTone(period.daysUntilDue);
        return (
          <>
            <RowDate>{formatDate(period.dueDate)}</RowDate>
            {done ? null : (
              <span
                className={cn(
                  'truncate text-xs',
                  tone === 'overdue'
                    ? 'font-medium text-destructive'
                    : tone === 'soon'
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-muted-foreground',
                )}
              >
                {dueCountdown(tc.due, period.daysUntilDue)}
              </span>
            )}
          </>
        );
      },
    },
    {
      id: 'state',
      header: tp.state,
      width: 'w-[110px]',
      render: ({ period }) => (
        <StatusChip tone={PERIOD_STATE_TONE[period.state] ?? 'gray'}>{tc.periodStates[period.state] ?? period.state}</StatusChip>
      ),
    },
    {
      id: 'return',
      header: tp.returnColumn,
      width: 'w-[190px] gap-2',
      render: ({ period }) => {
        const ret = period.return;
        if (!ret) return <RowText>{tp.noReturn}</RowText>;
        return (
          <>
            <StatusChip tone={RETURN_STATUS_TONE[ret.status] ?? 'gray'}>{returnStatuses[ret.status] ?? ret.status}</StatusChip>
            {period.amendments.map((amendment) => (
              <Link
                key={amendment.id}
                to="/weldbooks/sales-tax/returns/$id"
                params={{ id: amendment.id }}
                className="truncate text-xs text-primary hover:underline"
              >
                {tp.amended}
              </Link>
            ))}
          </>
        );
      },
    },
    {
      id: 'totalDue',
      header: tp.totalDue,
      width: 'w-[120px]',
      render: ({ period }) => <RowAmount>{period.return ? formatMoney(period.return.totalDue) : null}</RowAmount>,
    },
    {
      id: 'filed',
      header: tp.filed,
      width: 'hidden xl:flex w-[110px]',
      render: ({ period }) => (
        <span
          className="min-w-0"
          title={period.return?.confirmationNumber ? fill(tp.confirmation, { number: period.return.confirmationNumber }) : undefined}
        >
          <RowDate>{period.return?.filedAt ? formatDate(period.return.filedAt) : null}</RowDate>
        </span>
      ),
    },
    {
      id: 'actions',
      header: tc.common.actions,
      width: 'w-[120px] justify-end',
      render: ({ agency, period }) => {
        const ret = period.return;
        const opening = openingKey === periodKey(period);
        if (ret) {
          return (
            <Button asChild variant="outline" size="sm" className="h-7">
              <Link to="/weldbooks/sales-tax/returns/$id" params={{ id: ret.id }}>
                {tp.viewReturn}
              </Link>
            </Button>
          );
        }
        if (canCreate && period.state !== 'upcoming') {
          return (
            <Button
              size="sm"
              className="h-7"
              onClick={() =>
                void open(periodKey(period), {
                  agencyId: agency.agencyId,
                  periodStart: period.periodStart,
                  periodEnd: period.periodEnd,
                })
              }
              disabled={opening}
            >
              {opening ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {tp.openReturn}
            </Button>
          );
        }
        return null;
      },
    },
  ];

  if (query.isError && !data) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-md border">
        <WeldbooksEntityList<PeriodListRow>
          items={rows}
          isLoading={query.isLoading}
          columns={columns}
          groups={groups}
          onRowClick={({ period }) => {
            if (period.return) {
              void navigate({ to: '/weldbooks/sales-tax/returns/$id', params: { id: period.return.id } });
            }
          }}
          getRowLabel={({ agency, period }) => `${agency.agencyName}: ${period.periodEnd}`}
          filters={filters}
          applyFilters={applyPeriodFilters}
          leftActionButtons={
            <>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {tc.common.from}
                <Input
                  type="date"
                  className="h-8 w-36"
                  value={from}
                  max={to || undefined}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {tc.common.to}
                <Input
                  type="date"
                  className="h-8 w-36"
                  value={to}
                  min={from || undefined}
                  onChange={(event) => setTo(event.target.value)}
                />
              </label>
              {from !== '' || to !== '' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8"
                  onClick={() => {
                    setFrom('');
                    setTo('');
                  }}
                >
                  {tc.common.resetFilters}
                </Button>
              ) : null}
            </>
          }
          emptyState={{
            icon: (
              <EmptyStateIllustration>
                <CalendarX className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
              </EmptyStateIllustration>
            ),
            title: tp.emptyTitle,
            description: tp.emptyDescription,
          }}
          noResultsState={{ title: tp.emptyTitle, description: tp.emptyDescription }}
        />
      </div>
      {data ? (
        <p className="text-xs text-muted-foreground">
          {fill(tc.common.showingRange, { from: formatDate(data.from), to: formatDate(data.to) })}
        </p>
      ) : null}
    </div>
  );
}

/** Every filing period of each agency with its due date, state and return. */
export default function SalesTaxReturnsPage() {
  const { t } = useI18n();
  const tp = t.weldbooksUs.salesTax.center.periodsPage;
  return (
    <SalesTaxFrame title={tp.title} subtitle={tp.subtitle}>
      <ReturnsContent />
    </SalesTaxFrame>
  );
}
