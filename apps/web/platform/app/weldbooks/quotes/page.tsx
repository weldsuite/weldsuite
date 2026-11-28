/**
 * Sales → Quotes (edition feature `books-quotes`): the quotes of the entity's
 * contacts. The status filter lives in the address (`?status=sent`), the
 * search asks the server, and rows load a page at a time. A row opens the
 * quote panel; "New quote" opens the quote form.
 */

import { useState } from 'react';
import { CheckCircle2, Eye, Mail, ScrollText } from 'lucide-react';
import { EmptyStateIllustration, type ColumnDef, type FilterConfig } from '@/components/entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { ContactCell, RowAmount, RowChip, RowDate, RowTitle } from '@/components/accounting/weldbooks-row-cells';
import { EditionUnavailablePage } from '@/components/edition-unavailable-page';
import { QuoteStatusChip } from '@/components/objects/quote/quote-parts';
import { isQuotesAvailable, useInfiniteQuotes } from '@/hooks/queries/use-weldbooks-sales-queries';
import { QUOTE_STATUSES, type QuoteRow } from '@/lib/api/domains/weldbooks-sales';
import { getLocale } from '@/lib/i18n';
import { plural } from '@/lib/i18n/plural';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { pillValue } from '@/lib/weldbooks/list-filters';
import { useUrlPillFilters } from '@/lib/weldbooks/use-url-pill-filters';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

const URL_FILTER_FIELDS = ['status'] as const;
const URL_FILTER_VALUES = { status: QUOTE_STATUSES };

export default function QuotesPage() {
  const { t } = useI18n();
  const copy = t.weldbooksSales.quotes;
  const router = useRouter();
  const { open: openPanel } = useObjectPanel();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const [search, setSearch] = useState('');
  const { activeFilters, onFiltersChange } = useUrlPillFilters(URL_FILTER_FIELDS, URL_FILTER_VALUES);
  // Quotes open as stacked panels over this page, deep-linked with `?stack=`.
  useObjectPanelUrlSync('/weldbooks/quotes');
  const query = useInfiniteQuotes({ search: search.trim() || undefined, status: pillValue(activeFilters, 'status') });

  // The Rust backend only (`books-quotes`); the route guard shows the same page for a direct URL.
  if (!isQuotesAvailable()) return <EditionUnavailablePage />;

  const newQuote = () => router.push('/weldbooks/quotes/add');
  const statusLabels = copy.status as Readonly<Record<string, string>>;
  const filters: FilterConfig[] = [
    {
      field: 'status',
      label: copy.colStatus,
      options: QUOTE_STATUSES.map((value) => ({ value, label: statusLabels[value] ?? value })),
    },
  ];

  const columns: ColumnDef<QuoteRow>[] = [
    {
      id: 'number',
      header: copy.colNumber,
      width: 'min-w-0 flex-1 gap-2 @2xl/list:min-w-[200px]',
      render: (quote) => (
        <div className="flex min-w-0 flex-col">
          <RowTitle>{quote.quoteNumber ?? quote.name ?? '—'}</RowTitle>
          {quote.quoteNumber && quote.name ? <span className="truncate text-xs text-muted-foreground">{quote.name}</span> : null}
        </div>
      ),
    },
    {
      id: 'contact',
      header: copy.colContact,
      width: 'hidden shrink-0 @4xl/list:flex w-[200px]',
      render: (quote) => <ContactCell name={quote.contactName} contactId={quote.contactId} />,
    },
    {
      id: 'validUntil',
      header: copy.colValidUntil,
      width: 'hidden shrink-0 @5xl/list:flex w-[120px]',
      render: (quote) => <RowDate>{formatDate(quote.validUntil)}</RowDate>,
    },
    {
      id: 'total',
      header: copy.colTotal,
      width: 'shrink-0 w-[130px]',
      render: (quote) => <RowAmount>{formatMoney(quote.total, quote.currency)}</RowAmount>,
    },
    {
      id: 'progress',
      header: copy.colProgress,
      width: 'hidden shrink-0 @6xl/list:flex w-[230px] gap-1',
      render: (quote) => (
        <>
          {quote.sentAt ? (
            <RowChip tone="blue" icon={<Mail />}>
              {copy.chipSent}
            </RowChip>
          ) : null}
          {quote.viewedAt ? (
            <RowChip tone="indigo" icon={<Eye />}>
              {copy.chipViewed}
            </RowChip>
          ) : null}
          {quote.acceptedAt ? (
            <RowChip tone="green" icon={<CheckCircle2 />}>
              {copy.chipAccepted}
            </RowChip>
          ) : null}
          {quote.invoiceIds.length > 0 ? (
            <RowChip tone="purple">{plural(quote.invoiceIds.length, copy.chipInvoices, getLocale())}</RowChip>
          ) : null}
        </>
      ),
    },
    {
      id: 'status',
      header: copy.colStatus,
      width: 'shrink-0 w-[110px]',
      render: (quote) => <QuoteStatusChip status={quote.status} />,
    },
  ];

  const empty = {
    icon: (
      <EmptyStateIllustration>
        <ScrollText className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
      </EmptyStateIllustration>
    ),
    title: copy.empty,
    description: copy.emptyDescription,
    action: { label: copy.newQuote, onClick: newQuote },
  };

  return (
    <WeldbooksEntityList<QuoteRow>
      items={query.data?.rows ?? []}
      isLoading={query.isLoading}
      error={query.isError ? new Error(copy.loadFailed) : null}
      columns={columns}
      hasMore={query.hasNextPage}
      isLoadingMore={query.isFetchingNextPage}
      onLoadMore={() => void query.fetchNextPage()}
      onRowClick={(quote) => openPanel({ type: 'quote', id: quote.id })}
      getRowLabel={(quote) => quote.quoteNumber ?? quote.name ?? copy.colNumber}
      filters={filters}
      activeFilters={activeFilters}
      onFiltersChange={onFiltersChange}
      searchQuery={search}
      onSearchChange={setSearch}
      searchPlaceholder={copy.searchPlaceholder}
      createButton={{ label: copy.newQuote, onClick: newQuote }}
      emptyState={empty}
    />
  );
}
