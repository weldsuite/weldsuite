import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Badge } from '@weldsuite/ui/components/badge';
import { Truck } from 'lucide-react';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  EmptyStateIllustration,
  type ColumnDef,
  type FilterConfig,
  type ActiveFilter,
} from '@/components/entity-list';
import { useSupplierContacts } from '@/hooks/queries/use-weldbooks-1099-queries';
import type { VendorTaxContact } from '@/lib/api/domains/weldbooks-1099';
import { useI18n } from '@/lib/i18n/provider';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { supplierTinStatus, type SupplierTinStatus } from './supplier-tax-status';

interface SupplierRow extends VendorTaxContact {
  vatNumber?: string | null;
}

const TIN_BADGE: Record<Exclude<SupplierTinStatus, 'none'>, 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'> = {
  missing: 'warning',
  on_file: 'outline',
  matched: 'success',
  mismatch: 'destructive',
  pending: 'secondary',
};

export default function AccountingSuppliersPage() {
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const navigate = useNavigate();
  const { t } = useI18n();
  const tsp = t.accounting.suppliersPage;
  const ts = t.weldbooksUs.form1099.suppliers;
  const { labels, features } = useJurisdictionLabels();
  const show1099 = features.form1099;

  // Backend expands role=supplier → supplier + both. This pill lets the user
  // narrow to only the dual-role entries when auditing.
  const filterConfigs: FilterConfig[] = [
    {
      field: 'role',
      label: tsp.filterRoleLabel,
      options: [{ value: 'both', label: tsp.filterBoth }],
    },
    ...(show1099
      ? [
          {
            field: 'form1099',
            label: ts.filterLabel,
            options: [
              { value: 'only', label: ts.filterOnly },
              { value: 'missing_tin', label: ts.filterMissingTin },
            ],
          },
        ]
      : []),
  ];

  const roleFilter = filters.find((f) => f.field === 'role' && f.value)?.value as 'both' | undefined;
  const form1099Filter = show1099 ? filters.find((f) => f.field === 'form1099' && f.value)?.value : undefined;

  const { data, isLoading } = useSupplierContacts({
    search,
    role: roleFilter ?? 'supplier',
    only1099: form1099Filter !== undefined,
  });

  const allSuppliers = (data?.data ?? []) as SupplierRow[];
  const suppliers =
    form1099Filter === 'missing_tin'
      ? allSuppliers.filter((s) => supplierTinStatus(s) === 'missing')
      : allSuppliers;

  const columns: ColumnDef<SupplierRow>[] = [
    {
      id: 'name',
      header: tsp.colName,
      width: 'flex-1',
      render: (supplier) => <span className="font-medium">{supplier.name}</span>,
    },
    {
      id: 'email',
      header: tsp.colEmail,
      width: 'flex-1',
      render: (c) => <span className="text-muted-foreground">{c.email ?? '—'}</span>,
    },
    {
      id: 'role',
      header: tsp.colRole,
      width: 'w-[140px]',
      render: (c) => (
        <Badge variant="outline" className="capitalize">
          {c.role === 'both' ? tsp.roleBoth : c.role ?? '—'}
        </Badge>
      ),
    },
    {
      id: 'vat',
      header: labels.taxId,
      width: 'w-[180px]',
      render: (c) => <span className="text-muted-foreground">{c.vatNumber ?? '—'}</span>,
    },
    ...(show1099
      ? ([
          {
            id: 'form1099',
            header: ts.col1099,
            width: 'w-[110px]',
            render: (c) =>
              c.is1099Vendor ? (
                <Badge variant="secondary">{c.default1099Form ? ts.formShort[c.default1099Form] : ts.vendor1099}</Badge>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
          },
          {
            id: 'tin',
            header: ts.colTin,
            width: 'w-[190px]',
            render: (c) => {
              const status = supplierTinStatus(c);
              if (status === 'none') return <span className="text-muted-foreground">—</span>;
              return (
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={TIN_BADGE[status]}>{ts.tinStatus[status]}</Badge>
                  {c.tinMasked ? <span className="font-mono text-xs text-muted-foreground">{c.tinMasked}</span> : null}
                </span>
              );
            },
          },
          {
            id: 'w9',
            header: ts.colW9,
            width: 'w-[110px]',
            render: (c) =>
              c.w9?.receivedAt || c.w9?.legalName ? (
                <Badge variant="success">{ts.w9Received}</Badge>
              ) : c.is1099Vendor ? (
                <Badge variant="warning">{ts.w9Missing}</Badge>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
          },
        ] satisfies ColumnDef<SupplierRow>[])
      : []),
  ];

  return (
    <WeldbooksEntityList<SupplierRow>
      items={suppliers}
      isLoading={isLoading}
      columns={columns}
      onRowClick={(s) => navigate({ to: '/weldbooks/customers/$id', params: { id: s.id } })}
      filters={filterConfigs}
      searchQuery={search}
      onSearchChange={setSearch}
      activeFilters={filters}
      onFiltersChange={setFilters}
      searchPlaceholder={tsp.searchPlaceholder}
      createButton={{
        label: tsp.newSupplier,
        onClick: () =>
          // Same create form as customers — the role selector lets the user
          // pick 'supplier' or 'both' at creation time.
          navigate({ to: '/weldbooks/customers/add' }),
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <Truck className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: tsp.noSuppliers,
        description: tsp.searchPlaceholder,
        action: {
          label: tsp.newSupplier,
          onClick: () => navigate({ to: '/weldbooks/customers/add' }),
        },
      }}
    />
  );
}
