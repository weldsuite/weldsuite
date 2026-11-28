import { useMemo, useState } from 'react';
import { useInfiniteAccountingInvoices } from '@/hooks/queries/use-accounting-queries';
import { Eye, MailWarning, ReceiptText } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { useRouter } from '@/lib/router';
import { EmptyStateIllustration, type ColumnDef, type FilterConfig, type GroupConfig } from '@/components/entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { WeldbooksEntityList, type WeldbooksListSelection } from '@/components/accounting/weldbooks-entity-list';
import { useBulkRemind } from '@/components/accounting/bulk-remind';
import { ContactCell, RowAmount, RowChip, RowDate, RowTitle, StatusChip } from '@/components/accounting/weldbooks-row-cells';
import { isInvoiceEmailAvailable, isRemindersAvailable } from '@/hooks/queries/use-weldbooks-sales-queries';
import type { EmailHistoryEntry } from '@/lib/api/domains/weldbooks-sales';
import { getLocale } from '@/lib/i18n';
import { plural } from '@/lib/i18n/plural';
import { daysOverdue, isOpenForPayment, isUndelivered, viewCount } from '@/lib/weldbooks/invoice-activity';
import { NewCreditNoteDialog } from './components/new-credit-note-dialog';
import { useTranslations } from '@weldsuite/i18n/client';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { applyExclusions, pillValue } from '@/lib/weldbooks/list-filters';
import { INVOICE_VIEWS, isOpenInvoice, useFillFilteredList } from '@/lib/weldbooks/list-views';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { useUrlPillFilters } from '@/lib/weldbooks/use-url-pill-filters';

/** The statuses the Status filter offers, in the order an invoice moves through them. */
const INVOICE_STATUSES = ['draft', 'finalized', 'sent', 'partial', 'overdue', 'paid', 'cancelled', 'uncollectible'] as const;

/** The filters the address carries: `?status=overdue`, `?show=open`. */
const URL_FILTER_FIELDS = ['status', 'show'] as const;
const URL_FILTER_VALUES = { status: INVOICE_STATUSES, show: INVOICE_VIEWS };

interface InvoiceRow {
  id: string;
  type?: string;
  invoiceNumber: string | null;
  contactName: string | null;
  contactId?: string | null;
  issueDate: string | null;
  dueDate: string | null;
  totalAmount: number | null;
  total?: string | number | null;
  currency?: string | null;
  status: string;
  balanceDue?: string | null;
  // Phase 4 (Rust only): each is left out of the JSON while it holds its default.
  reminderLevel?: number;
  remindersPaused?: boolean;
  viewedAt?: string | null;
  emailHistory?: EmailHistoryEntry[] | null;
}

/** An overdue invoice that waits for money: the ones "Send reminders" can pick. */
function isRemindable(invoice: InvoiceRow): boolean {
  return invoice.type !== 'credit_note' && isOpenForPayment(invoice) && daysOverdue(invoice) > 0;
}

export default function InvoicesPage() {
  const [search, setSearch] = useState('');
  // The Status and Show filters live in the address, so a link from To process or the
  // overview opens the list already filtered and the filter survives navigation.
  const { activeFilters, onFiltersChange } = useUrlPillFilters(URL_FILTER_FIELDS, URL_FILTER_VALUES);
  const show = pillValue(activeFilters, 'show');
  const router = useRouter();
  const [creditOpen, setCreditOpen] = useState(false);
  const canUpdate = useCan('invoices:update');
  const canCreate = useCan('invoices:create');
  const emailOn = isInvoiceEmailAvailable();
  const remindersOn = isRemindersAvailable();
  const salesColumns = emailOn || remindersOn;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // A new invoice is written on its own page, next to a live preview of the PDF.
  const newInvoice = () => router.push('/weldbooks/invoices/add');
  // `type=invoice` is every invoice that is not a credit note; Show → Credit notes lists those instead.
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteAccountingInvoices({
    type: show === 'credit_notes' ? 'credit_note' : 'invoice',
    search,
    status: pillValue(activeFilters, 'status'),
    overdue: show === 'overdue' ? 'true' : undefined,
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
  const tv = t.weldbooksConnected.listViews;
  const tl = t.weldbooksSales.list;
  const { labels } = useJurisdictionLabels();

  // The server filters on an `is` status; an `is not` one narrows the rows it sent.
  const loaded = applyExclusions((data?.rows ?? []) as unknown as InvoiceRow[], activeFilters, { status: (inv) => inv.status });
  // Open and overdue leave out drafts, paid and cancelled invoices: the server has no such filter, so the
  // rows loaded so far are narrowed and pages keep loading until the view has enough.
  const narrowed = show === 'open' || show === 'overdue' || show === 'undelivered';
  const narrowFilter = show === 'undelivered' ? isUndelivered : isOpenInvoice;
  const invoices = narrowed ? loaded.filter(narrowFilter) : loaded;
  useFillFilteredList({
    active: narrowed,
    shown: invoices.length,
    hasMore: hasNextPage,
    isLoadingMore: isFetchingNextPage,
    loadMore: () => void fetchNextPage(),
  });

  // Bulk reminders: overdue invoices that wait for money are selectable (edition feature `books-reminders`).
  const remindable = useMemo(() => invoices.filter(isRemindable), [invoices]);
  const selectedShown = useMemo(() => new Set(remindable.filter((inv) => selected.has(inv.id)).map((inv) => inv.id)), [remindable, selected]);
  const bulk = useBulkRemind(
    (id) => invoices.find((inv) => inv.id === id)?.invoiceNumber ?? id,
    () => setSelected(new Set()),
  );
  const selection: WeldbooksListSelection<InvoiceRow> | undefined =
    remindersOn && canUpdate
      ? {
          selectedIds: selectedShown,
          onToggle: (id) =>
            setSelected((current) => {
              const next = new Set(current);
              if (!next.delete(id)) next.add(id);
              return next;
            }),
          onToggleAll: (checked) => setSelected(checked ? new Set(remindable.map((inv) => inv.id)) : new Set()),
          isSelectable: isRemindable,
          actions: (
            <Button type="button" size="sm" disabled={bulk.pending} onClick={() => bulk.start([...selectedShown])}>
              {plural(selectedShown.size, tl.sendReminders, getLocale())}
            </Button>
          ),
        }
      : undefined;

  const filterConfigs: FilterConfig[] = [
    { field: 'status', label: tip.colStatus, options: INVOICE_STATUSES.map((value) => ({ value, label: tsl[value] })) },
    {
      field: 'show',
      label: tv.filterLabel,
      options: [
        { value: 'open', label: tv.open },
        { value: 'overdue', label: tv.overdue },
        { value: 'credit_notes', label: labels.creditNotes },
        ...(emailOn ? [{ value: 'undelivered', label: tl.undelivered }] : []),
      ],
    },
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
      render: (inv) =>
        salesColumns ? (
          <div className="flex min-w-0 flex-col">
            <RowTitle>{inv.invoiceNumber ?? '—'}</RowTitle>
            <FollowUpLine invoice={inv} />
          </div>
        ) : (
          <RowTitle>{inv.invoiceNumber ?? '—'}</RowTitle>
        ),
    },
    {
      id: 'contact',
      header: tip.colContact,
      width: 'hidden shrink-0 @4xl/list:flex w-[200px]',
      render: (inv) => <ContactCell name={inv.contactName} contactId={inv.contactId} />,
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
    ...(salesColumns ? salesListColumns(tl, formatMoney) : []),
    {
      id: 'status',
      header: tip.colStatus,
      width: salesColumns ? 'shrink-0 w-[140px]' : 'shrink-0 w-[110px]',
      render: (inv) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <StatusChip status={inv.status}>{tsl[inv.status as keyof typeof tsl] ?? inv.status}</StatusChip>
          {isUndelivered(inv) ? (
            <span className="inline-flex text-red-600 dark:text-red-400" title={tl.bounced}>
              <MailWarning className="size-4" aria-hidden />
              <span className="sr-only">{tl.bounced}</span>
            </span>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <>
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
      onFiltersChange={onFiltersChange}
      searchQuery={search}
      onSearchChange={setSearch}
      searchPlaceholder={tip.searchPlaceholder}
      createButton={{
        label: tip.newInvoice,
        onClick: newInvoice,
        // A credit note is written against an invoice: this picks it (edition feature `books-invoice-email`).
        more: emailOn && canCreate ? [{ label: tl.newCreditNote, onClick: () => setCreditOpen(true) }] : undefined,
      }}
      selection={selection}
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
    {bulk.dialogs}
    {creditOpen ? <NewCreditNoteDialog open={creditOpen} onOpenChange={setCreditOpen} /> : null}
    </>
  );
}

type ListCopy = ReturnType<typeof useI18n>['t']['weldbooksSales']['list'];

/** "12 days overdue · viewed 3 times": what the extra columns say, for a list too narrow to show them. */
function FollowUpLine({ invoice }: Readonly<{ invoice: InvoiceRow }>) {
  const { t } = useI18n();
  const tl = t.weldbooksSales.list;
  const late = daysOverdue(invoice);
  const views = viewCount(invoice);
  const parts = [
    late > 0 ? plural(late, tl.daysOverdue, getLocale()) : null,
    views > 0 ? plural(views, tl.subViewed, getLocale()) : null,
    isUndelivered(invoice) ? tl.bounced.toLowerCase() : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  return (
    <span className="truncate text-xs text-muted-foreground @5xl/list:hidden" data-testid="follow-up-line">
      {parts.join(' · ')}
    </span>
  );
}

/** Balance due, days overdue, last reminder and views: the columns the sales phase adds. */
function salesListColumns(tl: ListCopy, formatMoney: (value: string | number | null | undefined, currency?: string | null) => string): ColumnDef<InvoiceRow>[] {
  return [
    {
      id: 'balanceDue',
      header: tl.colBalance,
      width: 'hidden shrink-0 @5xl/list:flex w-[110px]',
      render: (inv) => <RowAmount>{formatMoney(inv.balanceDue, inv.currency)}</RowAmount>,
    },
    {
      id: 'daysOverdue',
      header: tl.colOverdue,
      width: 'hidden shrink-0 @5xl/list:flex w-[110px]',
      render: (inv) => {
        const late = daysOverdue(inv);
        return late > 0 ? (
          <span className="truncate text-xs font-medium text-red-600 tabular-nums dark:text-red-400">{plural(late, tl.daysOverdue, getLocale())}</span>
        ) : null;
      },
    },
    {
      id: 'reminder',
      header: tl.colReminder,
      width: 'hidden shrink-0 @6xl/list:flex w-[100px]',
      render: (inv) =>
        (inv.reminderLevel ?? 0) > 0 ? (
          <RowChip tone="amber">{tl.reminderLevel.replace('{level}', String(inv.reminderLevel))}</RowChip>
        ) : null,
    },
    {
      id: 'viewed',
      header: tl.colViewed,
      width: 'hidden shrink-0 @4xl/list:flex w-[64px]',
      render: (inv) => {
        const views = viewCount(inv);
        return views > 0 ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
            <Eye className="size-3.5" aria-hidden />
            <span aria-hidden>{views}</span>
            <span className="sr-only">{plural(views, tl.viewedTimes, getLocale())}</span>
          </span>
        ) : null;
      },
    },
  ];
}
