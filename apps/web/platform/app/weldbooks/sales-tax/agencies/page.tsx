import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Building2, Plus, SlidersHorizontal } from 'lucide-react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useSalesTaxAgencies } from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import { AGENCY_STATUSES, type AgencyStatus, type SalesTaxAgency } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { salesTaxStateName } from '@/lib/weldbooks/us-sales-tax-states';
import { dueDayText } from '../setup/format';
import { SalesTaxSetupGate, useSalesTaxSetupAccess } from '../setup/setup-gate';
import { useSetupTexts } from '../setup/setup-texts';
import { AgencyStatusBadge } from '../setup/status-badges';

type StatusFilter = AgencyStatus | 'all';

/** Registered agencies first, then pending, monitoring and closed; by state within each. */
function sortAgencies(rows: readonly SalesTaxAgency[]): SalesTaxAgency[] {
  const rank = (status: AgencyStatus) => AGENCY_STATUSES.indexOf(status);
  return [...rows].sort((a, b) => rank(a.status) - rank(b.status) || a.stateCode.localeCompare(b.stateCode) || a.name.localeCompare(b.name));
}

function AgenciesList() {
  const { t, format, plural } = useSetupTexts();
  const ta = t.agencies;
  const navigate = useNavigate();
  const { canCreate } = useSalesTaxSetupAccess();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const [status, setStatus] = useState<StatusFilter>('all');

  const agencies = useSalesTaxAgencies(status === 'all' ? undefined : { status });
  const rows = useMemo(() => sortAgencies(agencies.data ?? []), [agencies.data]);

  const open = (id: string) => void navigate({ to: '/weldbooks/sales-tax/agencies/$id', params: { id } });

  let body: React.ReactNode;
  if (agencies.isLoading) {
    body = (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  } else if (agencies.isError) {
    body = (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>{ta.loadError}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void agencies.refetch()}>
            {t.common.retry}
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (rows.length === 0) {
    body = (
      <Card>
        <CardContent className="space-y-3 py-10 text-center">
          <Building2 className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
          <p className="font-medium">{status === 'all' ? ta.emptyTitle : ta.emptyFiltered}</p>
          {status === 'all' ? <p className="mx-auto max-w-xl text-sm text-muted-foreground">{ta.emptyDescription}</p> : null}
          {canCreate && status === 'all' ? (
            <Button asChild>
              <Link to="/weldbooks/sales-tax/agencies/new">{ta.register}</Link>
            </Button>
          ) : null}
        </CardContent>
      </Card>
    );
  } else {
    body = (
      <>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{ta.columns.state}</TableHead>
                <TableHead>{ta.columns.agency}</TableHead>
                <TableHead>{ta.columns.status}</TableHead>
                <TableHead>{ta.columns.filing}</TableHead>
                <TableHead>{ta.columns.due}</TableHead>
                <TableHead className="text-right" title={ta.owedHelp}>
                  {ta.columns.payable}
                </TableHead>
                <TableHead>{ta.columns.registration}</TableHead>
                <TableHead>{ta.columns.registeredFrom}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((agency) => (
                <TableRow
                  key={agency.id}
                  className="cursor-pointer"
                  tabIndex={0}
                  onClick={() => open(agency.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') open(agency.id);
                  }}
                >
                  <TableCell className="whitespace-nowrap font-medium">
                    {salesTaxStateName(agency.stateCode)} ({agency.stateCode})
                    {agency.level === 'local' ? (
                      <Badge variant="outline" className="ml-2">
                        {ta.localBadge}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-[260px] truncate" title={agency.name}>
                    {agency.name}
                  </TableCell>
                  <TableCell>
                    <AgencyStatusBadge status={agency.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{t.frequencies[agency.filingFrequency] ?? agency.filingFrequency}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{dueDayText(agency.dueDay, t.dueDay, format)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {agency.liabilityAccount ? formatMoney(agency.liabilityAccount.balance ?? '0') : t.common.none}
                  </TableCell>
                  <TableCell>{agency.registrationNumber ?? t.common.none}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(agency.registeredFrom, t.common.none)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-sm text-muted-foreground">{plural(rows.length, ta.count)}</p>
      </>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{ta.title}</h1>
          <p className="text-sm text-muted-foreground">{ta.subtitle}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to="/weldbooks/sales-tax/settings">
              <SlidersHorizontal className="mr-2 h-4 w-4" aria-hidden />
              {ta.engineSettings}
            </Link>
          </Button>
          {canCreate ? (
            <Button asChild>
              <Link to="/weldbooks/sales-tax/agencies/new">
                <Plus className="mr-2 h-4 w-4" aria-hidden />
                {ta.register}
              </Link>
            </Button>
          ) : null}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
          <SelectTrigger className="w-48" aria-label={ta.filterStatus}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{ta.allStatuses}</SelectItem>
            {AGENCY_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {t.statuses[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {body}
    </div>
  );
}

export default function SalesTaxAgenciesPage() {
  return (
    <SalesTaxSetupGate>
      <AgenciesList />
    </SalesTaxSetupGate>
  );
}
