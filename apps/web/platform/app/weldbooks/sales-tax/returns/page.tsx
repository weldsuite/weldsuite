import { useMemo, useState } from 'react';
import { CalendarX } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { useSalesTaxPeriods } from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { AgencyPeriods, PeriodRow } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { EmptyState, ErrorState, RowsSkeleton } from '../shared/query-states';
import { SalesTaxFrame } from '../shared/sales-tax-frame';
import { fill } from '../shared/text';
import { useOpenReturn } from '../shared/use-open-return';
import { AgencyPeriodsTable, periodKey } from './agency-periods-table';
import { PERIOD_STATUS_FILTERS, filterAgencyPeriods, type PeriodStatusFilter } from './period-filters';

function ReturnsContent() {
  const { t } = useI18n();
  const tc = t.weldbooksUs.salesTax.center;
  const tp = tc.periodsPage;
  const { can } = usePermissions();
  const { formatDate } = useWeldbooksFormat();
  const [agencyId, setAgencyId] = useState('all');
  const [status, setStatus] = useState<PeriodStatusFilter>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { open, openingKey } = useOpenReturn();

  const query = useSalesTaxPeriods({ from: from || undefined, to: to || undefined });
  const data = query.data;
  const agencies = useMemo(
    () => (data ? filterAgencyPeriods(data.agencies, { agencyId, status }) : []),
    [data, agencyId, status],
  );

  const statusLabels: Record<PeriodStatusFilter, string> = {
    all: tp.allStatuses,
    attention: tp.needsAttention,
    ...tc.periodStates,
  };
  const filtersActive = agencyId !== 'all' || status !== 'all' || from !== '' || to !== '';

  const openReturn = (agency: AgencyPeriods, period: PeriodRow) => {
    void open(periodKey(period), { agencyId: agency.agencyId, periodStart: period.periodStart, periodEnd: period.periodEnd });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="period-agency">{tp.agencyFilter}</Label>
          <Select value={agencyId} onValueChange={setAgencyId}>
            <SelectTrigger id="period-agency" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tp.allAgencies}</SelectItem>
              {(data?.agencies ?? []).map((agency) => (
                <SelectItem key={agency.agencyId} value={agency.agencyId}>
                  {agency.agencyName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="period-status">{tp.statusFilter}</Label>
          <Select value={status} onValueChange={(value) => setStatus(value as PeriodStatusFilter)}>
            <SelectTrigger id="period-status" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIOD_STATUS_FILTERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {statusLabels[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="period-from">{tc.common.from}</Label>
          <Input
            id="period-from"
            type="date"
            className="w-40"
            value={from}
            max={to || undefined}
            onChange={(event) => setFrom(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="period-to">{tc.common.to}</Label>
          <Input
            id="period-to"
            type="date"
            className="w-40"
            value={to}
            min={from || undefined}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
        {filtersActive ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setAgencyId('all');
              setStatus('all');
              setFrom('');
              setTo('');
            }}
          >
            {tc.common.resetFilters}
          </Button>
        ) : null}
      </div>

      {data ? (
        <p className="text-xs text-muted-foreground">
          {fill(tc.common.showingRange, { from: formatDate(data.from), to: formatDate(data.to) })}
        </p>
      ) : null}

      {query.isLoading ? (
        <RowsSkeleton rows={6} />
      ) : query.isError && !data ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : agencies.length === 0 ? (
        <EmptyState icon={CalendarX} title={tp.emptyTitle} description={tp.emptyDescription} />
      ) : (
        agencies.map((agency) => (
          <AgencyPeriodsTable
            key={agency.agencyId}
            agency={agency}
            canCreate={can('taxes:create')}
            openingKey={openingKey}
            onOpenReturn={openReturn}
          />
        ))
      )}
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
