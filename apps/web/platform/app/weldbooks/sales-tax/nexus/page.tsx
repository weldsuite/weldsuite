import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Check, MapPin } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { EmptyStateIllustration, type ActiveFilter, type ColumnDef, type FilterConfig } from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  RowChip,
  RowDate,
  RowNumberChip,
  RowText,
  RowTitle,
  StatusChip,
  type ChipTone,
} from '@/components/accounting/weldbooks-row-cells';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useNexusOverview } from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { NexusAlert, NexusRow, NexusStatus } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { CardsSkeleton, ErrorState } from '../shared/query-states';
import { SalesTaxFrame } from '../shared/sales-tax-frame';
import { RegisterStateLink } from '../shared/setup-links';
import { fill } from '../shared/text';
import { ALERT_FILTERS, countByAlert } from './nexus-model';
import { NexusProgressBar } from './nexus-progress-bar';

/** A nexus row as the list takes it: the state code is the row's id. */
type NexusListRow = NexusRow & { id: string };

const ALERT_TONE: Record<NexusAlert, ChipTone> = {
  register: 'red',
  watch: 'amber',
  registered: 'green',
  ok: 'gray',
};

function statusTone(status: NexusStatus, registered: boolean): ChipTone {
  if (status === 'exceeded') return registered ? 'gray' : 'red';
  if (status === 'approaching') return 'amber';
  return 'gray';
}

/** The alert filter works on the loaded states: `is` keeps the alert, `is not` drops it. */
function applyAlertFilters(items: NexusListRow[], activeFilters: ActiveFilter[]): NexusListRow[] {
  let result = items;
  for (const filter of activeFilters) {
    if (filter.field !== 'alert' || !filter.operator || !filter.value) continue;
    result =
      filter.operator === 'is'
        ? result.filter((row) => row.alert === filter.value)
        : result.filter((row) => row.alert !== filter.value);
  }
  return result;
}

interface SummaryCardProps {
  label: string;
  value: number;
  hint: string;
  tone?: 'danger' | 'warning' | 'success';
  testId: string;
}

function SummaryCard({ label, value, hint, tone, testId }: Readonly<SummaryCardProps>) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p
          className={cn(
            'text-2xl font-semibold tabular-nums',
            value > 0 && tone === 'danger' && 'text-destructive',
            value > 0 && tone === 'warning' && 'text-amber-600 dark:text-amber-400',
            value > 0 && tone === 'success' && 'text-emerald-600 dark:text-emerald-400',
          )}
          data-testid={testId}
        >
          {value}
        </p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function NexusContent() {
  const { t } = useI18n();
  const tn = t.weldbooksUs.salesTax.center.nexus;
  const { can } = usePermissions();
  const navigate = useNavigate();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const [asOf, setAsOf] = useState('');
  const query = useNexusOverview(asOf || undefined);
  const data = query.data;
  const rows = useMemo<NexusListRow[]>(() => (data?.rows ?? []).map((row) => ({ ...row, id: row.stateCode })), [data]);
  const counts = useMemo(() => countByAlert(data?.rows ?? []), [data]);
  const filterLabels = tn.filters as Record<string, string>;
  const alerts = tn.alerts as Record<string, string>;
  const statuses = tn.statuses as Record<string, string>;
  const agencyStatuses = t.weldbooksUs.salesTax.center.agencyStatuses as Record<string, string>;
  const canRegister = can('taxes:create');

  const filters: FilterConfig[] = [
    {
      field: 'alert',
      label: tn.filters.alert,
      options: ALERT_FILTERS.filter((value): value is NexusAlert => value !== 'all').map((value) => ({
        value,
        label: `${filterLabels[value]} (${counts[value]})`,
      })),
    },
  ];

  const columns: ColumnDef<NexusListRow>[] = [
    {
      id: 'state',
      header: tn.columns.state,
      width: 'min-w-[200px] flex-1 gap-2',
      render: (row) => (
        <>
          <RowNumberChip>{row.stateCode}</RowNumberChip>
          <RowTitle>{row.stateName}</RowTitle>
        </>
      ),
    },
    {
      id: 'status',
      header: tn.columns.status,
      width: 'w-[190px] gap-1.5',
      render: (row) => (
        <>
          <StatusChip tone={ALERT_TONE[row.alert]}>{alerts[row.alert]}</StatusChip>
          <RowChip tone={statusTone(row.status, row.registered)}>{statuses[row.status]}</RowChip>
        </>
      ),
    },
    {
      id: 'progress',
      header: tn.columns.progress,
      width: 'w-[210px]',
      render: (row) => (
        <span
          className="min-w-0"
          title={
            row.pending
              ? fill(tn.pending, { date: formatDate(row.pending.collectFrom), crossed: formatDate(row.pending.exceededOn) })
              : undefined
          }
        >
          <NexusProgressBar row={row} />
        </span>
      ),
    },
    {
      id: 'sales',
      header: tn.columns.sales,
      width: 'w-[170px]',
      render: (row) => (
        <RowText className="tabular-nums">
          {row.thresholdSales === null
            ? formatMoney(row.salesTotal)
            : fill(tn.ofThreshold, { amount: formatMoney(row.salesTotal), threshold: formatMoney(row.thresholdSales) })}
        </RowText>
      ),
    },
    {
      id: 'transactions',
      header: tn.columns.transactions,
      width: 'hidden 2xl:flex w-[120px]',
      render: (row) => (
        <RowText className="tabular-nums">
          {row.thresholdTransactions === null
            ? null
            : fill(tn.transactionsOf, { count: row.transactionCount, threshold: row.thresholdTransactions })}
        </RowText>
      ),
    },
    {
      id: 'exceededOn',
      header: tn.columns.exceededOn,
      width: 'hidden 2xl:flex w-[110px]',
      render: (row) => <RowDate>{row.exceededOn ? formatDate(row.exceededOn) : null}</RowDate>,
    },
    {
      id: 'collectFrom',
      header: tn.columns.collectFrom,
      width: 'hidden xl:flex w-[130px] gap-1.5',
      render: (row) => (
        <>
          <RowDate>{row.collectFrom ? formatDate(row.collectFrom) : null}</RowDate>
          {row.collectFrom && !row.collectFromVerified ? (
            <span title={tn.unverified}>
              <RowChip tone="gray">?</RowChip>
            </span>
          ) : null}
        </>
      ),
    },
    {
      id: 'registered',
      header: tn.columns.registered,
      width: 'w-[120px]',
      render: (row) =>
        row.registered ? (
          <span className="inline-flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
            <Check className="h-4 w-4" aria-hidden="true" />
            {tn.registeredYes}
          </span>
        ) : (
          <RowText>{row.agencyStatus ? (agencyStatuses[row.agencyStatus] ?? row.agencyStatus) : tn.registeredNo}</RowText>
        ),
    },
    {
      id: 'actions',
      header: tn.columns.actions,
      width: 'w-[90px] justify-end',
      render: (row) =>
        row.alert === 'register' && canRegister ? (
          <Button asChild size="sm" className="h-7">
            <RegisterStateLink stateCode={row.stateCode}>{tn.register}</RegisterStateLink>
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      {query.isLoading ? <CardsSkeleton count={4} /> : null}
      {data ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard
            label={tn.summary.register}
            value={data.summary.exceededUnregistered}
            hint={tn.summary.registerHint}
            tone="danger"
            testId="nexus-summary-register"
          />
          <SummaryCard
            label={tn.summary.watch}
            value={data.summary.approaching}
            hint={tn.summary.watchHint}
            tone="warning"
            testId="nexus-summary-watch"
          />
          <SummaryCard
            label={tn.summary.registered}
            value={data.summary.exceededRegistered}
            hint={tn.summary.registeredHint}
            tone="success"
            testId="nexus-summary-registered"
          />
          <SummaryCard label={tn.summary.monitored} value={data.summary.monitored} hint={tn.summary.monitoredHint} testId="nexus-summary-monitored" />
        </div>
      ) : null}

      {query.isError && !data ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className="overflow-hidden rounded-md border">
          <WeldbooksEntityList<NexusListRow>
            items={rows}
            isLoading={query.isLoading}
            columns={columns}
            onRowClick={(row) => void navigate({ to: '/weldbooks/sales-tax/nexus/$state', params: { state: row.stateCode } })}
            getRowLabel={(row) => `${row.stateName}: ${tn.viewDetails}`}
            filters={filters}
            applyFilters={applyAlertFilters}
            searchFields={['stateName', 'stateCode']}
            searchPlaceholder={tn.filters.search}
            leftActionButtons={
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {tn.asOf}
                <Input
                  type="date"
                  className="h-8 w-40"
                  value={asOf}
                  onChange={(event) => setAsOf(event.target.value)}
                />
              </label>
            }
            emptyState={{
              icon: (
                <EmptyStateIllustration>
                  <MapPin className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
                </EmptyStateIllustration>
              ),
              title: tn.empty,
              description: tn.emptyDescription,
            }}
            noResultsState={{ title: tn.empty, description: tn.emptyDescription }}
          />
        </div>
      )}
      {data ? <p className="text-xs text-muted-foreground">{fill(t.weldbooksUs.salesTax.center.common.asOfDate, { date: formatDate(data.asOf) })}</p> : null}
      <p className="text-xs text-muted-foreground">{tn.legend}</p>
    </div>
  );
}

/** The nexus monitor: sales into each state against its economic nexus threshold, nearest first. */
export default function NexusMonitorPage() {
  const { t } = useI18n();
  const tn = t.weldbooksUs.salesTax.center.nexus;
  return (
    <SalesTaxFrame title={tn.title} subtitle={tn.subtitle}>
      <NexusContent />
    </SalesTaxFrame>
  );
}
