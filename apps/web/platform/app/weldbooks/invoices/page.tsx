import { useState } from 'react';
import { useInfiniteAccountingInvoices } from '@/hooks/queries/use-accounting-queries';
import { ReceiptText } from 'lucide-react';
import { useRouter } from '@/lib/router';
import { EmptyStateIllustration, type ActiveFilter, type ColumnDef, type FilterConfig, type GroupConfig } from '@/components/entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { ContactCell, RowAmount, RowDate, RowTitle, StatusChip } from '@/components/accounting/weldbooks-row-cells';
import { useTranslations } from '@weldsuite/i18n/client';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { applyExclusions, pillValue } from '@/lib/weldbooks/list-filters';

/** The statuses the Status filter offers, in the order an invoice moves through them. */
const INVOICE_STATUSES = ['draft', 'finalized', 'sent', 'partial', 'overdue', 'paid', 'cancelled', 'uncollectible'] as const;

interface InvoiceRow {
  id: string;
  invoiceNumber: string | null;
  contactName: string | null;
  issueDate: string | null;
  dueDate: string | null;
  totalAmount: number | null;
  total?: string | number | null;
  currency?: string | null;
  status: string;
}

export default function InvoicesPage() {
  const [search, setSearch] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const router = useRouter();
  // A new invoice is written on its own page, next to a live preview of the PDF.
  const newInvoice = () => router.push('/weldbooks/invoices/add');
  // Credit notes have a list of their own: `type=invoice` is every invoice that is not a credit note.
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteAccountingInvoices({
    type: 'invoice',
    search,
    status: pillValue(activeFilters, 'status'),
  });
  // Each invoice opens in the shared object panel (type 'invoice'), the same
  // panel/fullscreen shell as WeldCRM companies, synced to `?stack=`.
  const { open: openPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldbooks/invoices');
  const { t } = useI18n();
  const st = useTranslations();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const tip = t.accounting.invoicesPage;
  const tsl = t.accounting.statusLabels.invoice;

  // The server filters on an `is` status; an `is not` one narrows the rows it sent.
  const invoices = applyExclusions((data?.rows ?? []) as unknown as InvoiceRow[], activeFilters, { status: (inv) => inv.status });
  const filterConfigs: FilterConfig[] = [
    { field: 'status', label: tip.colStatus, options: INVOICE_STATUSES.map((value) => ({ value, label: tsl[value] })) },
  ];

  // Group by lifecycle status, most-urgent first. The trailing "other" group is
  // an explicit catch-all: EntityList drops items matching no group, so any
  // status outside the known set (e.g. cancelled/void) stays visible here.
  const knownStatuses = new Set(['overdue', 'finalized', 'sent', 'partial', 'draft', 'paid']);
  const groups: GroupConfig<InvoiceRow>[] = [
    { id: 'overdue', label: tip.groupOverdue, sortOrder: 1, filter: (i) => i.status === 'overdue' },
    { id: 'finalized', label: tip.groupFinalized, sortOrder: 2, filter: (i) => i.status === 'finalized' },
    { id: 'sent', label: tip.groupSent, sortOrder: 2, filter: (i) => i.status === 'sent' },
    {
      id: 'partial',
      label: st('sweep.weldbooks.records.groupPartiallyPaid'),
      sortOrder: 3,
      filter: (i) => i.status === 'partial',
    },
    { id: 'draft', label: tip.groupDraft, sortOrder: 4, filter: (i) => i.status === 'draft' },
    { id: 'paid', label: tip.groupPaid, sortOrder: 5, filter: (i) => i.status === 'paid' },
    { id: 'other', label: tip.groupOther, sortOrder: 6, filter: (i) => !knownStatuses.has(i.status) },
  ];

  const columns: ColumnDef<InvoiceRow>[] = [
    {
      id: 'number',
      header: tip.colNumber,
      width: 'min-w-0 flex-1 gap-2 @2xl/list:min-w-[200px]',
      render: (inv) => <RowTitle>{inv.invoiceNumber ?? '—'}</RowTitle>,
    },
    {
      id: 'contact',
      header: tip.colContact,
      width: 'hidden shrink-0 @4xl/list:flex w-[200px]',
      render: (inv) => <ContactCell name={inv.contactName} />,
    },
    {
      id: 'issueDate',
      header: tip.colDate,
      width: 'hidden shrink-0 @4xl/list:flex w-[120px]',
      render: (inv) => <RowDate>{formatDate(inv.issueDate)}</RowDate>,
    },
    {
      id: 'dueDate',
      header: tip.colDueDate,
      width: 'hidden shrink-0 @6xl/list:flex w-[120px]',
      render: (inv) => <RowDate>{formatDate(inv.dueDate)}</RowDate>,
    },
    {
      id: 'total',
      header: tip.colTotal,
      width: 'shrink-0 w-[130px]',
      render: (inv) => <RowAmount>{formatMoney(inv.total ?? inv.totalAmount, inv.currency)}</RowAmount>,
    },
    {
      id: 'status',
      header: tip.colStatus,
      width: 'shrink-0 w-[110px]',
      render: (inv) => <StatusChip status={inv.status}>{tsl[inv.status as keyof typeof tsl] ?? inv.status}</StatusChip>,
    },
  ];

  return (
    <WeldbooksEntityList<InvoiceRow>
      items={invoices}
      isLoading={isLoading}
      columns={columns}
      groups={groups}
      hasMore={hasNextPage}
      isLoadingMore={isFetchingNextPage}
      onLoadMore={() => void fetchNextPage()}
      onRowClick={(inv) => openPanel({ type: 'invoice', id: inv.id })}
      getRowLabel={(inv) => inv.invoiceNumber ?? tip.colNumber}
      filters={filterConfigs}
      activeFilters={activeFilters}
      onFiltersChange={setActiveFilters}
      searchQuery={search}
      onSearchChange={setSearch}
      searchPlaceholder={tip.searchPlaceholder}
      createButton={{
        label: tip.newInvoice,
        onClick: newInvoice,
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <ReceiptText className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: tip.noInvoices,
        description: tip.emptyDescription,
        action: {
          label: tip.newInvoice,
          onClick: newInvoice,
        },
      }}
    />
  );
}
