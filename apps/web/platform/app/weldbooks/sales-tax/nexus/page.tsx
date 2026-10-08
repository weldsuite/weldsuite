import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Check, MapPin, Search } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useNexusOverview } from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { NexusRow } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { CardsSkeleton, EmptyState, ErrorState, RowsSkeleton } from '../shared/query-states';
import { SalesTaxFrame } from '../shared/sales-tax-frame';
import { RegisterStateLink } from '../shared/setup-links';
import { fill } from '../shared/text';
import { ALERT_FILTERS, alertVariant, countByAlert, filterNexusRows, statusVariant, type AlertFilter } from './nexus-model';
import { NexusProgressBar } from './nexus-progress-bar';

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

function NexusTableRow({ row, canRegister }: Readonly<{ row: NexusRow; canRegister: boolean }>) {
  const { t } = useI18n();
  const tn = t.weldbooksUs.salesTax.center.nexus;
  const agencyStatuses = t.weldbooksUs.salesTax.center.agencyStatuses as Record<string, string>;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const alerts = tn.alerts as Record<string, string>;
  const statuses = tn.statuses as Record<string, string>;

  return (
    <TableRow data-testid={`nexus-row-${row.stateCode}`} data-alert={row.alert}>
      <TableCell>
        <Link
          to="/weldbooks/sales-tax/nexus/$state"
          params={{ state: row.stateCode }}
          className="font-medium text-primary hover:underline"
        >
          {row.stateName}
        </Link>
        <span className="ml-2 text-xs text-muted-foreground">{row.stateCode}</span>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={alertVariant(row.alert)}>{alerts[row.alert]}</Badge>
          <Badge variant={statusVariant(row.status, row.registered)}>{statuses[row.status]}</Badge>
        </div>
      </TableCell>
      <TableCell>
        <NexusProgressBar row={row} />
        {row.pending ? (
          <p className="mt-1 max-w-[16rem] whitespace-normal text-xs text-amber-700 dark:text-amber-400">
            {fill(tn.pending, { date: formatDate(row.pending.collectFrom), crossed: formatDate(row.pending.exceededOn) })}
          </p>
        ) : null}
      </TableCell>
      <TableCell className="whitespace-nowrap text-right tabular-nums">
        {row.thresholdSales === null
          ? formatMoney(row.salesTotal)
          : fill(tn.ofThreshold, { amount: formatMoney(row.salesTotal), threshold: formatMoney(row.thresholdSales) })}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap text-right tabular-nums md:table-cell">
        {row.thresholdTransactions === null
          ? '—'
          : fill(tn.transactionsOf, { count: row.transactionCount, threshold: row.thresholdTransactions })}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap lg:table-cell">{row.exceededOn ? formatDate(row.exceededOn) : '—'}</TableCell>
      <TableCell className="hidden whitespace-nowrap lg:table-cell">
        {row.collectFrom ? (
          <span className="inline-flex items-center gap-1">
            {formatDate(row.collectFrom)}
            {!row.collectFromVerified ? (
              <Badge variant="outline" title={tn.unverified}>
                ?
              </Badge>
            ) : null}
          </span>
        ) : (
          '—'
        )}
      </TableCell>
      <TableCell>
        {row.registered ? (
          <span className="inline-flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
            <Check className="h-4 w-4" aria-hidden="true" />
            {tn.registeredYes}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">
            {row.agencyStatus ? (agencyStatuses[row.agencyStatus] ?? row.agencyStatus) : tn.registeredNo}
          </span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-2">
          {row.alert === 'register' && canRegister ? (
            <Button asChild size="sm">
              <RegisterStateLink stateCode={row.stateCode}>{tn.register}</RegisterStateLink>
            </Button>
          ) : null}
          <Button asChild variant="outline" size="sm">
            <Link to="/weldbooks/sales-tax/nexus/$state" params={{ state: row.stateCode }}>
              {tn.viewDetails}
            </Link>
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function NexusContent() {
  const { t } = useI18n();
  const tn = t.weldbooksUs.salesTax.center.nexus;
  const { can } = usePermissions();
  const { formatDate } = useWeldbooksFormat();
  const [asOf, setAsOf] = useState('');
  const [alert, setAlert] = useState<AlertFilter>('all');
  const [search, setSearch] = useState('');
  const query = useNexusOverview(asOf || undefined);
  const data = query.data;
  const rows = useMemo(() => (data ? filterNexusRows(data.rows, { alert, query: search }) : []), [data, alert, search]);
  const counts = useMemo(() => countByAlert(data?.rows ?? []), [data]);
  const filterLabels = tn.filters as Record<AlertFilter, string>;

  return (
    <div className="space-y-4">
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

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="nexus-alert">{tn.filters.alert}</Label>
          <Select value={alert} onValueChange={(value) => setAlert(value as AlertFilter)}>
            <SelectTrigger id="nexus-alert" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ALERT_FILTERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {filterLabels[value]}
                  {value !== 'all' && data ? ` (${counts[value]})` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="nexus-search">{tn.filters.search}</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id="nexus-search"
              className="w-56 pl-8"
              placeholder={tn.filters.search}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="nexus-as-of">{tn.asOf}</Label>
          <Input
            id="nexus-as-of"
            type="date"
            className="w-40"
            value={asOf}
            onChange={(event) => setAsOf(event.target.value)}
          />
        </div>
        {data ? <p className="pb-2 text-xs text-muted-foreground">{fill(t.weldbooksUs.salesTax.center.common.asOfDate, { date: formatDate(data.asOf) })}</p> : null}
      </div>

      {query.isLoading ? (
        <>
          <CardsSkeleton count={4} />
          <RowsSkeleton rows={8} />
        </>
      ) : query.isError && !data ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={MapPin} title={tn.empty} description={tn.emptyDescription} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tn.columns.state}</TableHead>
                  <TableHead>{tn.columns.status}</TableHead>
                  <TableHead>{tn.columns.progress}</TableHead>
                  <TableHead className="text-right">{tn.columns.sales}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{tn.columns.transactions}</TableHead>
                  <TableHead className="hidden lg:table-cell">{tn.columns.exceededOn}</TableHead>
                  <TableHead className="hidden lg:table-cell">{tn.columns.collectFrom}</TableHead>
                  <TableHead>{tn.columns.registered}</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">{tn.columns.actions}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <NexusTableRow key={row.stateCode} row={row} canRegister={can('taxes:create')} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
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
