import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Truck } from 'lucide-react';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { RowAvatar, RowChip, RowText, RowTitle, StatusChip, type ChipTone } from '@/components/accounting/weldbooks-row-cells';
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
import { contactEmail, contactKindFilter, contactKindIcon, readKindFilter } from '../customers/components/contact-list-cells';
import { supplierTinStatus, type SupplierTinStatus } from './supplier-tax-status';

interface SupplierRow extends VendorTaxContact {
  vatNumber?: string | null;
}

const TIN_TONE: Record<Exclude<SupplierTinStatus, 'none'>, ChipTone> = {
  missing: 'amber',
  on_file: 'gray',
  matched: 'green',
  mismatch: 'red',
  pending: 'blue',
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
    contactKindFilter(tsp.filterKindLabel, t.accounting.contacts.kinds),
    {
      field: 'role',
      label: tsp.filterRoleLabel,
      options: [{ value: 'both', label: tsp.filterBoth.replace('{role}', labels.customerAndSupplier) }],
    },
    {
      field: 'archived',
      label: tsp.filterArchivedLabel,
      options: [
        { value: 'include', label: tsp.filterArchivedInclude },
        { value: 'only', label: tsp.filterArchivedOnly },
      ],
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
  const archivedFilter = filters.find((f) => f.field === 'archived' && f.value)?.value as 'include' | 'only' | undefined;

  const { data, isLoading } = useSupplierContacts({
    search,
    role: roleFilter ?? 'supplier',
    kind: readKindFilter(filters),
    only1099: form1099Filter !== undefined,
    archived: archivedFilter,
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
      width: 'min-w-[200px] flex-1 gap-2',
      render: (supplier) => (
        <>
          <RowAvatar name={supplier.name || '?'} icon={contactKindIcon(supplier)} />
          <RowTitle>{supplier.name}</RowTitle>
        </>
      ),
    },
    {
      id: 'email',
      header: tsp.colEmail,
      width: 'w-[240px]',
      render: (c) => <RowText>{contactEmail(c)}</RowText>,
    },
    {
      id: 'role',
      header: tsp.colRole,
      width: 'w-[170px]',
      render: (c) =>
        c.role ? (
          <StatusChip tone={c.role === 'both' ? 'indigo' : 'purple'}>
            <span className="capitalize">{c.role === 'both' ? labels.customerAndSupplier : c.role}</span>
          </StatusChip>
        ) : (
          <RowText />
        ),
    },
    {
      id: 'vat',
      header: labels.taxId,
      width: 'w-[180px]',
      render: (c) => <RowText>{c.vatNumber}</RowText>,
    },
    ...(show1099
      ? ([
          {
            id: 'form1099',
            header: ts.col1099,
            width: 'w-[110px]',
            render: (c) =>
              c.is1099Vendor ? (
                <RowChip tone="blue">{c.default1099Form ? ts.formShort[c.default1099Form] : ts.vendor1099}</RowChip>
              ) : (
                <RowText />
              ),
          },
          {
            id: 'tin',
            header: ts.colTin,
            width: 'w-[220px] gap-2',
            render: (c) => {
              const status = supplierTinStatus(c);
              if (status === 'none') return <RowText />;
              return (
                <>
                  <StatusChip tone={TIN_TONE[status]}>{ts.tinStatus[status]}</StatusChip>
                  {c.tinMasked ? <RowText className="font-mono text-xs">{c.tinMasked}</RowText> : null}
                </>
              );
            },
          },
          {
            id: 'w9',
            header: ts.colW9,
            width: 'w-[110px]',
            render: (c) =>
              c.w9?.receivedAt || c.w9?.legalName ? (
                <StatusChip tone="green">{ts.w9Received}</StatusChip>
              ) : c.is1099Vendor ? (
                <StatusChip tone="amber">{ts.w9Missing}</StatusChip>
              ) : (
                <RowText />
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
        description: tsp.emptyDescription,
        action: {
          label: tsp.newSupplier,
          onClick: () => navigate({ to: '/weldbooks/customers/add' }),
        },
      }}
    />
  );
}
