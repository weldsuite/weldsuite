import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { FileCheck2 } from 'lucide-react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { EmptyStateIllustration, type ColumnDef } from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  RowChip,
  RowDate,
  RowText,
  RowTitle,
  StatusChip,
} from '@/components/accounting/weldbooks-row-cells';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { CERTIFICATE_STATUS_TONE } from '@/components/objects/tax-exemption-certificate/tax-exemption-certificate-model';
import { useExemptionCertificates } from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import type {
  CertificateFilter,
  CertificateStatus,
  ExemptionCertificate,
} from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { CustomerName, CustomerPicker } from '../setup/customer-picker';
import { SalesTaxSetupGate, useSalesTaxSetupAccess } from '../setup/setup-gate';
import { useSetupTexts } from '../setup/setup-texts';
import { EXPIRING_WINDOWS, STATUS_FILTER_ORDER } from './certificate-model';
import { CertificateExpiry } from './certificate-expiry';

type StatusFilter = CertificateStatus | 'all';
type WindowFilter = 'any' | `${(typeof EXPIRING_WINDOWS)[number]}`;

/** How many state chips fit in a row before the rest collapse into "+N". */
const MAX_STATE_CHIPS = 3;

function CertificatesList() {
  const { t, plural } = useSetupTexts();
  const tc = t.certificates;
  const navigate = useNavigate();
  // Each certificate opens in the shared object panel (type
  // 'tax_exemption_certificate'), the same panel/fullscreen shell as WeldCRM
  // companies, synced to `?stack=`.
  const { open: openPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldbooks/sales-tax/certificates');
  const { canCreate } = useSalesTaxSetupAccess();
  const { formatDate } = useWeldbooksFormat();
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
  // The filters run on the server: keep the last rows on screen (and the toolbar mounted) while the next set loads.
  const [lastRows, setLastRows] = useState<ExemptionCertificate[] | null>(null);
  useEffect(() => {
    if (query.data) setLastRows(query.data);
  }, [query.data]);
  const rows = query.data ?? lastRows ?? [];
  const loading = query.isLoading && lastRows === null;
  const filtered = status !== 'all' || expiring !== 'any' || partyId !== '';

  const goToNew = () => void navigate({ to: '/weldbooks/sales-tax/certificates/new' });

  const columns: ColumnDef<ExemptionCertificate>[] = [
    {
      id: 'customer',
      header: tc.columns.customer,
      width: 'min-w-[160px] flex-1 gap-2',
      render: (certificate) => (
        <RowTitle>
          <CustomerName partyId={certificate.partyId} />
        </RowTitle>
      ),
    },
    {
      id: 'states',
      header: tc.columns.states,
      width: 'w-[170px] gap-1',
      render: (certificate) => {
        const shown = certificate.states.slice(0, MAX_STATE_CHIPS);
        const more = certificate.states.length - shown.length;
        return (
          <span className="flex min-w-0 items-center gap-1" title={certificate.states.join(', ')}>
            {shown.map((code) => (
              <RowChip key={code} tone="gray">
                {code}
              </RowChip>
            ))}
            {more > 0 ? <RowChip tone="gray">+{more}</RowChip> : null}
          </span>
        );
      },
    },
    {
      id: 'reason',
      header: tc.columns.reason,
      width: 'w-[160px] gap-1.5',
      render: (certificate) => (
        <>
          <RowText>{tc.reasons[certificate.reason] ?? certificate.reason}</RowText>
          {!certificate.blanket ? <RowChip tone="gray">{tc.coverage.single}</RowChip> : null}
        </>
      ),
    },
    {
      id: 'number',
      header: tc.columns.number,
      width: 'hidden lg:flex w-[110px]',
      render: (certificate) => <RowText>{certificate.certificateNumber}</RowText>,
    },
    {
      id: 'expires',
      header: tc.columns.expires,
      width: 'w-[230px]',
      render: (certificate) => (
        <span className="min-w-0 truncate text-sm">
          <CertificateExpiry certificate={certificate} />
        </span>
      ),
    },
    {
      id: 'status',
      header: tc.columns.status,
      width: 'w-[100px]',
      render: (certificate) => (
        <StatusChip tone={CERTIFICATE_STATUS_TONE[certificate.status] ?? 'gray'}>
          {tc.statuses[certificate.status] ?? certificate.status}
        </StatusChip>
      ),
    },
    {
      id: 'lastUsed',
      header: tc.columns.lastUsed,
      width: 'hidden xl:flex w-[110px]',
      render: (certificate) =>
        certificate.lastUsedOn ? (
          <RowDate>{formatDate(certificate.lastUsedOn)}</RowDate>
        ) : (
          <RowText>{tc.expiry.neverUsed}</RowText>
        ),
    },
  ];

  if (query.isError && lastRows === null) {
    return (
      <div className="p-4 sm:p-6">
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{tc.loadError}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
              {t.common.retry}
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <>
      <WeldbooksEntityList<ExemptionCertificate>
        items={rows}
        isLoading={loading}
        columns={columns}
        onRowClick={(certificate) => openPanel({ type: 'tax_exemption_certificate', id: certificate.id })}
        getRowLabel={(certificate) =>
          [tc.reasons[certificate.reason] ?? certificate.reason, certificate.certificateNumber].filter(Boolean).join(' · ')
        }
        filters={[]}
        leftActionButtons={
          <>
            <Select value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
              <SelectTrigger className="h-8 w-40" aria-label={tc.filters.status}>
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
              <SelectTrigger className="h-8 w-52" aria-label={tc.filters.expiring}>
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

            <div className="w-52">
              <CustomerPicker
                value={partyId}
                onChange={setPartyId}
                ariaLabel={tc.filters.customer}
                placeholder={tc.filters.allCustomers}
                allLabel={tc.filters.allCustomers}
                searchPlaceholder={tc.form.customerSearch}
                emptyText={tc.form.customerEmpty}
                className="h-8"
              />
            </div>
          </>
        }
        actionButtons={
          <Button asChild variant="outline" size="sm" className="h-8">
            <Link to="/weldbooks/sales-tax/certificates/reports">{tc.reports}</Link>
          </Button>
        }
        createButton={canCreate ? { label: tc.add, onClick: goToNew } : undefined}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <FileCheck2 className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: filtered ? tc.emptyFiltered : tc.emptyTitle,
          description: filtered ? '' : tc.emptyDescription,
          action: !filtered && canCreate ? { label: tc.add, onClick: goToNew } : undefined,
        }}
      />
      {rows.length > 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{plural(rows.length, tc.count)}</p>
      ) : null}
    </>
  );
}

export default function ExemptionCertificatesPage() {
  return (
    <SalesTaxSetupGate>
      <CertificatesList />
    </SalesTaxSetupGate>
  );
}
