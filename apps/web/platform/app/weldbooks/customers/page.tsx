import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAccountingCustomers } from '@/hooks/queries/use-accounting-queries';
import { Users } from 'lucide-react';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { RowAvatar, RowChip, RowText, RowTitle, StatusChip } from '@/components/accounting/weldbooks-row-cells';
import { EmptyStateIllustration, type ColumnDef, type FilterConfig, type ActiveFilter } from '@/components/entity-list';
import type { ContactKind, ContactPerson } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { contactEmail, contactKindFilter, contactKindIcon, readKindFilter } from './components/contact-list-cells';

interface CustomerRow {
  id: string;
  name: string;
  kind?: ContactKind | null;
  email?: string | null;
  contactPerson?: ContactPerson | null;
  role?: string | null;
  vatNumber?: string | null;
  archivedAt?: string | null;
}

export default function AccountingCustomersPage() {
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const navigate = useNavigate();
  const { t } = useI18n();
  const tcp = t.accounting.customersPage;
  const { labels } = useJurisdictionLabels();

  // Backend expands role=customer → customer + both. This pill lets the user
  // narrow to only the dual-role entries when they want to audit them.
  const filterConfigs: FilterConfig[] = [
    contactKindFilter(tcp.filterKindLabel, t.accounting.contacts.kinds),
    {
      field: 'role',
      label: tcp.filterRoleLabel,
      options: [{ value: 'both', label: tcp.filterBoth.replace('{role}', labels.customerAndSupplier) }],
    },
    {
      field: 'archived',
      label: tcp.filterArchivedLabel,
      options: [
        { value: 'include', label: tcp.filterArchivedInclude },
        { value: 'only', label: tcp.filterArchivedOnly },
      ],
    },
  ];
  const archivedFilter = filters.find((f) => f.field === 'archived' && f.value)?.value as 'include' | 'only' | undefined;

  const roleFilter = filters.find((f) => f.field === 'role' && f.value)?.value as
    | 'both'
    | undefined;

  const { data, isLoading } = useAccountingCustomers({
    search,
    role: roleFilter ?? 'customer',
    kind: readKindFilter(filters),
    archived: archivedFilter,
  });

  const customers = (data?.data ?? []) as CustomerRow[];

  const columns: ColumnDef<CustomerRow>[] = [
    {
      id: 'name',
      header: tcp.colName,
      width: 'min-w-[200px] flex-1 gap-2',
      render: (customer) => (
        <>
          <RowAvatar name={customer.name || '?'} icon={contactKindIcon(customer)} />
          <RowTitle
            chips={customer.archivedAt ? <RowChip tone="gray">{t.accounting.contacts.archived}</RowChip> : null}
          >
            {customer.name}
          </RowTitle>
        </>
      ),
    },
    {
      id: 'email',
      header: tcp.colEmail,
      width: 'w-[240px]',
      render: (c) => <RowText>{contactEmail(c)}</RowText>,
    },
    {
      id: 'role',
      header: tcp.colRole,
      width: 'w-[170px]',
      render: (c) =>
        c.role ? (
          <StatusChip tone={c.role === 'both' ? 'indigo' : 'blue'}>
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
  ];

  return (
    <WeldbooksEntityList<CustomerRow>
      items={customers}
      isLoading={isLoading}
      columns={columns}
      onRowClick={(c) => navigate({ to: '/weldbooks/customers/$id', params: { id: c.id } })}
      filters={filterConfigs}
      searchQuery={search}
      onSearchChange={setSearch}
      activeFilters={filters}
      onFiltersChange={setFilters}
      searchPlaceholder={tcp.searchPlaceholder}
      createButton={{
        label: tcp.newCustomer,
        onClick: () => navigate({ to: '/weldbooks/customers/add' }),
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <Users className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: tcp.noCustomers,
        description: tcp.emptyDescription,
        action: {
          label: tcp.newCustomer,
          onClick: () => navigate({ to: '/weldbooks/customers/add' }),
        },
      }}
    />
  );
}
