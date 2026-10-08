import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { FileCheck2, Plus } from 'lucide-react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
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
import { useExemptionCertificates } from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import type { CertificateFilter, CertificateStatus } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { CustomerPicker } from '../setup/customer-picker';
import { SalesTaxSetupGate, useSalesTaxSetupAccess } from '../setup/setup-gate';
import { useSetupTexts } from '../setup/setup-texts';
import { EXPIRING_WINDOWS, STATUS_FILTER_ORDER } from './certificate-model';
import { CertificatesTable } from './certificates-table';

type StatusFilter = CertificateStatus | 'all';
type WindowFilter = 'any' | `${(typeof EXPIRING_WINDOWS)[number]}`;

function CertificatesList() {
  const { t, plural } = useSetupTexts();
  const tc = t.certificates;
  const { canCreate } = useSalesTaxSetupAccess();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [expiring, setExpiring] = useState<WindowFilter>('any');
  const [partyId, setPartyId] = useState('');

  const filter = useMemo<CertificateFilter>(
    () => ({
      status: status === 'all' ? undefined : status,
      expiringWithinDays: expiring === 'any' ? undefined : Number(expiring),
      partyId: partyId || undefined,
    }),
    [status, expiring, partyId],
  );
  const query = useExemptionCertificates(filter);
  const rows = query.data ?? [];
  const filtered = status !== 'all' || expiring !== 'any' || partyId !== '';

  let body: React.ReactNode;
  if (query.isLoading) {
    body = (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  } else if (query.isError) {
    body = (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>{tc.loadError}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
            {t.common.retry}
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (rows.length === 0) {
    body = (
      <Card>
        <CardContent className="space-y-3 py-10 text-center">
          <FileCheck2 className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
          <p className="font-medium">{filtered ? tc.emptyFiltered : tc.emptyTitle}</p>
          {!filtered ? <p className="mx-auto max-w-xl text-sm text-muted-foreground">{tc.emptyDescription}</p> : null}
          {canCreate && !filtered ? (
            <Button asChild>
              <Link to="/weldbooks/sales-tax/certificates/new">{tc.add}</Link>
            </Button>
          ) : null}
        </CardContent>
      </Card>
    );
  } else {
    body = (
      <>
        <CertificatesTable certificates={rows} />
        <p className="text-sm text-muted-foreground">{plural(rows.length, tc.count)}</p>
      </>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{tc.title}</h1>
          <p className="text-sm text-muted-foreground">{tc.subtitle}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to="/weldbooks/sales-tax/certificates/reports">{tc.reports}</Link>
          </Button>
          {canCreate ? (
            <Button asChild>
              <Link to="/weldbooks/sales-tax/certificates/new">
                <Plus className="mr-2 h-4 w-4" aria-hidden />
                {tc.add}
              </Link>
            </Button>
          ) : null}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
          <SelectTrigger className="w-44" aria-label={tc.filters.status}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{tc.filters.allStatuses}</SelectItem>
            {STATUS_FILTER_ORDER.map((s) => (
              <SelectItem key={s} value={s}>
                {tc.statuses[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={expiring} onValueChange={(value) => setExpiring(value as WindowFilter)}>
          <SelectTrigger className="w-52" aria-label={tc.filters.expiring}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">{`${tc.filters.expiring}: ${tc.filters.anyTime}`}</SelectItem>
            {EXPIRING_WINDOWS.map((days) => (
              <SelectItem key={days} value={String(days)}>
                {`${tc.filters.expiring}: ${tc.filters.withinDays.replace('{days}', String(days))}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="w-64">
          <CustomerPicker
            value={partyId}
            onChange={setPartyId}
            ariaLabel={tc.filters.customer}
            placeholder={tc.filters.allCustomers}
            allLabel={tc.filters.allCustomers}
            searchPlaceholder={tc.form.customerSearch}
            emptyText={tc.form.customerEmpty}
          />
        </div>
      </div>

      {body}
    </div>
  );
}

export default function ExemptionCertificatesPage() {
  return (
    <SalesTaxSetupGate>
      <CertificatesList />
    </SalesTaxSetupGate>
  );
}
