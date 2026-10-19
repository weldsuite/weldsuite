import { useMemo } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Building2, SlidersHorizontal } from 'lucide-react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyStateIllustration, type ActiveFilter, type ColumnDef, type FilterConfig } from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  RowAmount,
  RowChip,
  RowDate,
  RowNumberChip,
  RowText,
  RowTitle,
  StatusChip,
} from '@/components/accounting/weldbooks-row-cells';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { AGENCY_STATUS_TONE } from '@/components/objects/sales-tax-agency/sales-tax-agency-model';
import { useSalesTaxAgencies } from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import { AGENCY_STATUSES, type AgencyStatus, type SalesTaxAgency } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { salesTaxStateName } from '@/lib/weldbooks/us-sales-tax-states';
import { dueDayText } from '../setup/format';
import { SalesTaxSetupGate, useSalesTaxSetupAccess } from '../setup/setup-gate';
import { useSetupTexts } from '../setup/setup-texts';

/** Registered agencies first, then pending, monitoring and closed; by state within each. */
function sortAgencies(rows: readonly SalesTaxAgency[]): SalesTaxAgency[] {
  const rank = (status: AgencyStatus) => AGENCY_STATUSES.indexOf(status);
  return [...rows].sort((a, b) => rank(a.status) - rank(b.status) || a.stateCode.localeCompare(b.stateCode) || a.name.localeCompare(b.name));
}

/** The status filter works on the loaded list: `is` keeps the status, `is not` drops it. */
function applyStatusFilters(items: SalesTaxAgency[], activeFilters: ActiveFilter[]): SalesTaxAgency[] {
  let result = items;
  for (const filter of activeFilters) {
    if (filter.field !== 'status' || !filter.operator || !filter.value) continue;
    result =
      filter.operator === 'is'
        ? result.filter((agency) => agency.status === filter.value)
        : result.filter((agency) => agency.status !== filter.value);
  }
  return result;
}

function AgenciesList() {
  const { t, format } = useSetupTexts();
  const ta = t.agencies;
  const navigate = useNavigate();
  // Each agency opens in the shared object panel (type 'sales_tax_agency'), the
  // same panel/fullscreen shell as WeldCRM companies, synced to `?stack=`.
  const { open: openPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldbooks/sales-tax/agencies');
  const { canCreate } = useSalesTaxSetupAccess();
  const { formatMoney, formatDate } = useWeldbooksFormat();

  const agencies = useSalesTaxAgencies();
  const rows = useMemo(() => sortAgencies(agencies.data ?? []), [agencies.data]);

  const goToRegister = () => void navigate({ to: '/weldbooks/sales-tax/agencies/new' });

  const filters: FilterConfig[] = [
    {
      field: 'status',
      label: ta.filterStatus,
      options: AGENCY_STATUSES.map((value) => ({ value, label: t.statuses[value] })),
    },
  ];

  const columns: ColumnDef<SalesTaxAgency>[] = [
    {
      id: 'state',
      header: ta.columns.state,
      width: 'min-w-[260px] flex-1 gap-2',
      render: (agency) => (
        <>
          <RowNumberChip>{agency.stateCode}</RowNumberChip>
          <RowTitle chips={agency.level === 'local' ? <RowChip tone="gray">{ta.localBadge}</RowChip> : null}>
            {salesTaxStateName(agency.stateCode)}
          </RowTitle>
          <RowText className="min-w-0 flex-1">{agency.name}</RowText>
        </>
      ),
    },
    {
      id: 'status',
      header: ta.columns.status,
      width: 'w-[110px]',
      render: (agency) => <StatusChip tone={AGENCY_STATUS_TONE[agency.status] ?? 'gray'}>{t.statuses[agency.status] ?? agency.status}</StatusChip>,
    },
    {
      id: 'filing',
      header: ta.columns.filing,
      width: 'w-[100px]',
      render: (agency) => <RowText>{t.frequencies[agency.filingFrequency] ?? agency.filingFrequency}</RowText>,
    },
    {
      id: 'due',
      header: ta.columns.due,
      width: 'w-[150px]',
      render: (agency) => <RowText>{dueDayText(agency.dueDay, t.dueDay, format)}</RowText>,
    },
    {
      id: 'payable',
      header: ta.columns.payable,
      width: 'w-[110px]',
      render: (agency) => (
        <RowAmount>{agency.liabilityAccount ? formatMoney(agency.liabilityAccount.balance ?? '0') : null}</RowAmount>
      ),
    },
    {
      id: 'registration',
      header: ta.columns.registration,
      width: 'w-[130px]',
      render: (agency) => <RowText>{agency.registrationNumber}</RowText>,
    },
    {
      id: 'registeredFrom',
      header: ta.columns.registeredFrom,
      width: 'w-[120px]',
      render: (agency) => <RowDate>{agency.registeredFrom ? formatDate(agency.registeredFrom) : null}</RowDate>,
    },
  ];

  if (agencies.isError) {
    return (
      <div className="p-4 sm:p-6">
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{ta.loadError}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void agencies.refetch()}>
              {t.common.retry}
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <WeldbooksEntityList<SalesTaxAgency>
      items={rows}
      isLoading={agencies.isLoading}
      columns={columns}
      onRowClick={(agency) => openPanel({ type: 'sales_tax_agency', id: agency.id })}
      getRowLabel={(agency) => agency.name}
      filters={filters}
      applyFilters={applyStatusFilters}
      actionButtons={
        <Button asChild variant="outline" size="sm" className="h-8">
          <Link to="/weldbooks/sales-tax/settings">
            <SlidersHorizontal className="h-4 w-4" aria-hidden />
            <span className="hidden md:inline">{ta.engineSettings}</span>
          </Link>
        </Button>
      }
      createButton={canCreate ? { label: ta.register, onClick: goToRegister } : undefined}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <Building2 className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: ta.emptyTitle,
        description: ta.emptyDescription,
        action: canCreate ? { label: ta.register, onClick: goToRegister } : undefined,
      }}
      noResultsState={{ title: ta.emptyFiltered, description: '' }}
    />
  );
}

export default function SalesTaxAgenciesPage() {
  return (
    <SalesTaxSetupGate>
      <AgenciesList />
    </SalesTaxSetupGate>
  );
}
