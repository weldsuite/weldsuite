import { useState } from 'react';
import { Users } from 'lucide-react';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { RowAvatar, RowChip, RowText, RowTitle, StatusChip, type ChipTone } from '@/components/accounting/weldbooks-row-cells';
import {
  EmptyStateIllustration,
  type ColumnDef,
  type FilterConfig,
  type ActiveFilter,
} from '@/components/entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { useInfiniteContacts } from '@/hooks/queries/use-weldbooks-1099-queries';
import { useCreateIntent } from '@/hooks/use-create-intent';
import type { VendorTaxContact } from '@/lib/api/domains/weldbooks-1099';
import { useI18n } from '@/lib/i18n/provider';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { useUrlParam } from '@/lib/weldbooks/use-url-param';
import {
  contactEmail,
  contactKindFilter,
  contactKindIcon,
  contactRoleLabel,
  readKindFilter,
} from '../customers/components/contact-list-cells';
import { QuickAddContactDialog } from '../customers/components/quick-add-contact-dialog';
import { supplierTinStatus, type SupplierTinStatus } from '../suppliers/supplier-tax-status';

/** The roles the list can be narrowed to; no role is every contact. */
export const CONTACT_ROLES = ['customer', 'supplier'] as const;
export type ContactRoleView = (typeof CONTACT_ROLES)[number];

interface ContactRow extends VendorTaxContact {
  vatNumber?: string | null;
  archivedAt?: string | null;
}

const TIN_TONE: Record<Exclude<SupplierTinStatus, 'none'>, ChipTone> = {
  missing: 'amber',
  on_file: 'gray',
  matched: 'green',
  mismatch: 'red',
  pending: 'blue',
};

/**
 * The one Contacts list: customers, suppliers and contacts that are both. The Show filter
 * (All, Customers, Suppliers) is `?role=` in the address, so a link opens the list narrowed
 * and `/weldbooks/customers` and `/weldbooks/suppliers` redirect here with the role set.
 * The vendor tax columns (1099) show only where the jurisdiction has them, for suppliers.
 */
export default function ContactsPage() {
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const [role, setRole] = useUrlParam('role', CONTACT_ROLES);
  // A new contact is added in a popup, like WeldCRM's add company / person.
  const [addOpen, setAddOpen] = useState(false);
  // `?new=1` (the command palette's New contact) opens that popup.
  useCreateIntent(() => setAddOpen(true));
  // Each contact opens in the shared object panel (type 'weldbooks_contact'),
  // the same panel/fullscreen shell as WeldCRM companies, synced to `?stack=`.
  const { open: openPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldbooks/contacts');
  const { t } = useI18n();
  const tc = t.weldbooksConnected.contacts;
  const ts = t.weldbooksUs.form1099.suppliers;
  const tcp = t.accounting.customersPage;
  const { labels, features } = useJurisdictionLabels();
  const show1099 = features.form1099 && role === 'supplier';

  // The role pill narrows to the dual-role contacts when auditing; the Show filter above the list picks the role.
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

  const bothOnly = filters.find((f) => f.field === 'role' && f.value)?.value === 'both';
  const form1099Filter = show1099 ? filters.find((f) => f.field === 'form1099' && f.value)?.value : undefined;
  const archivedFilter = filters.find((f) => f.field === 'archived' && f.value)?.value as 'include' | 'only' | undefined;

  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteContacts({
    search,
    role: bothOnly ? 'both' : role,
    kind: readKindFilter(filters),
    only1099: form1099Filter !== undefined,
    archived: archivedFilter,
  });

  const allContacts = (data?.rows ?? []) as ContactRow[];
  const contacts =
    form1099Filter === 'missing_tin' ? allContacts.filter((c) => supplierTinStatus(c) === 'missing') : allContacts;

  const columns: ColumnDef<ContactRow>[] = [
    {
      id: 'name',
      header: tc.colName,
      width: 'min-w-0 flex-1 gap-2 @2xl/list:min-w-[200px]',
      render: (contact) => (
        <>
          <RowAvatar name={contact.name || '?'} icon={contactKindIcon(contact)} />
          <RowTitle
            chips={contact.archivedAt ? <RowChip tone="gray">{t.accounting.contacts.archived}</RowChip> : null}
          >
            {contact.name}
          </RowTitle>
        </>
      ),
    },
    {
      id: 'email',
      header: tc.colEmail,
      width: 'hidden shrink-0 @4xl/list:flex w-[240px]',
      render: (c) => <RowText>{contactEmail(c)}</RowText>,
    },
    {
      id: 'role',
      header: tc.colRole,
      width: 'shrink-0 w-[170px]',
      render: (c) =>
        c.role ? (
          <StatusChip tone={c.role === 'both' ? 'indigo' : c.role === 'supplier' ? 'purple' : 'blue'}>
            {contactRoleLabel(c.role, t.accounting.contacts.roles, labels)}
          </StatusChip>
        ) : (
          <RowText />
        ),
    },
    {
      id: 'vat',
      header: labels.taxId,
      width: 'hidden shrink-0 @6xl/list:flex w-[180px]',
      render: (c) => <RowText>{c.vatNumber}</RowText>,
    },
    ...(show1099
      ? ([
          {
            id: 'form1099',
            header: ts.col1099,
            width: 'hidden shrink-0 @6xl/list:flex w-[110px]',
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
            width: 'hidden shrink-0 @6xl/list:flex w-[220px] gap-2',
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
            width: 'hidden shrink-0 @6xl/list:flex w-[110px]',
            render: (c) =>
              c.w9?.receivedAt || c.w9?.legalName ? (
                <StatusChip tone="green">{ts.w9Received}</StatusChip>
              ) : c.is1099Vendor ? (
                <StatusChip tone="amber">{ts.w9Missing}</StatusChip>
              ) : (
                <RowText />
              ),
          },
        ] satisfies ColumnDef<ContactRow>[])
      : []),
  ];

  // A contact added from a narrowed list takes that role; from All it is a customer first.
  const newContactRole = role ?? 'customer';

  return (
    <>
      <WeldbooksEntityList<ContactRow>
        items={contacts}
        isLoading={isLoading}
        hasMore={hasNextPage}
        isLoadingMore={isFetchingNextPage}
        onLoadMore={() => void fetchNextPage()}
        columns={columns}
        onRowClick={(c) => openPanel({ type: 'weldbooks_contact', id: c.id })}
        getRowLabel={(c) => c.name}
        filters={filterConfigs}
        searchQuery={search}
        onSearchChange={setSearch}
        activeFilters={filters}
        onFiltersChange={setFilters}
        searchPlaceholder={tc.searchPlaceholder}
        leftActionButtons={
          <FilterSelect
            value={role}
            onChange={(next) => setRole(next as ContactRoleView | undefined)}
            options={[
              { value: 'customer', label: tc.roleCustomers },
              { value: 'supplier', label: labels.suppliers },
            ]}
            allLabel={tc.roleAll}
            ariaLabel={tc.filterRoleLabel}
          />
        }
        createButton={{
          label: tc.newContact,
          onClick: () => setAddOpen(true),
        }}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <Users className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: tc.noContacts,
          description: tc.emptyDescription,
          action: {
            label: tc.newContact,
            onClick: () => setAddOpen(true),
          },
        }}
      />

      <QuickAddContactDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        role={newContactRole}
        onCreated={(id) => id && openPanel({ type: 'weldbooks_contact', id })}
        onOpenExisting={(id) => openPanel({ type: 'weldbooks_contact', id })}
      />
    </>
  );
}
