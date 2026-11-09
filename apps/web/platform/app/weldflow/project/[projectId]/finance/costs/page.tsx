import { useEffect, useMemo, useState } from 'react';
import { isApiError } from '@weldsuite/api-client';
import type { ActiveFilter, FilterConfig } from '@weldsuite/ui/components/list-toolbar';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { COST_SOURCES } from '@weldsuite/app-api-client/schemas/project-finance';
import type { CostLine } from '@weldsuite/app-api-client/domains/project-finance';
import { EntityList, type HeaderColumn } from '@/components/entity-list';
import { LIST_CELL_CLASS, LIST_MENU_CELL_CLASS, LIST_ROW_CLASS, ListText, ListTitle } from '@/app/weldflow/components/list-cells';
import { SubNavToolbar } from '@/app/weldflow/components/sub-nav';
import { useProjectCosts, useProjectFinance } from '@/hooks/queries/use-project-finance-queries';
import { cn } from '@/lib/utils';
import { useLineText } from '../_components/cost-line';
import { FinanceListIllustration } from '../_components/finance-list-illustration';
import { FinanceErrorState, PercentOnlyNotice, SourceBadge, useFinanceEnv } from '../_components/finance-parts';
import { COST_FILTER_FIELDS, toCostQuery } from '../_lib/cost-filters';
import { formatMoney } from '../_lib/finance';

const PAGE_SIZE = 25;

const COLUMN_WIDTHS = {
  description: 'min-w-[100px] flex-1',
  source: 'w-[110px]',
  details: 'hidden w-[220px] @4xl:flex',
  status: 'hidden w-[110px] @3xl:flex',
  date: 'hidden w-[110px] @xl:flex',
  amount: 'w-[110px] justify-end',
  committed: 'hidden w-[110px] justify-end @2xl:flex',
} as const;

/** One cost line as a standard list row: what it is, its source and details, and what it costs. */
function Row({ line, currency }: Readonly<{ line: CostLine; currency: string | null }>) {
  const { intlLocale } = useFinanceEnv();
  const { title, meta } = useLineText(line);
  const date = new Intl.DateTimeFormat(intlLocale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${line.date}T00:00:00Z`));
  const committed = Number(line.committed) === 0 ? null : `+ ${formatMoney(line.committed, currency, intlLocale, 2)}`;
  // The date has its own column, so a bill or purchase shows only its reference here.
  const details = line.source === 'time' ? meta : line.reference;
  return (
    <div className={cn(LIST_ROW_CLASS, 'cursor-default')}>
      <div className={cn(LIST_CELL_CLASS, COLUMN_WIDTHS.description)}>
        <ListTitle title={title} />
      </div>
      <div className={cn(LIST_CELL_CLASS, COLUMN_WIDTHS.source)}>
        <SourceBadge source={line.source} />
      </div>
      <div className={cn(LIST_CELL_CLASS, COLUMN_WIDTHS.details)}>
        <ListText text={details} />
      </div>
      <div className={cn(LIST_CELL_CLASS, COLUMN_WIDTHS.status, 'capitalize')}>
        <ListText text={line.status} />
      </div>
      <div className={cn(LIST_CELL_CLASS, COLUMN_WIDTHS.date)}>
        <ListText text={date} />
      </div>
      <div className={cn(LIST_CELL_CLASS, COLUMN_WIDTHS.amount)}>
        <span className="truncate text-sm font-semibold tabular-nums text-gray-900 dark:text-foreground">
          {formatMoney(line.amount, currency, intlLocale, 2)}
        </span>
      </div>
      <div className={cn(LIST_CELL_CLASS, COLUMN_WIDTHS.committed)}>
        <span className="truncate text-sm tabular-nums text-gray-600 dark:text-muted-foreground">{committed ?? '—'}</span>
      </div>
      <div className={LIST_MENU_CELL_CLASS} />
    </div>
  );
}

function CostsList({
  costs,
  lines,
  filtered,
  currency,
}: Readonly<{ costs: ReturnType<typeof useProjectCosts>; lines: CostLine[]; filtered: boolean; currency: string | null }>) {
  const { copy } = useFinanceEnv();
  const c = copy.costs;
  // EntityList adds the 40px header spacer of the menu column itself.
  const headerColumns: HeaderColumn[] = [
    { id: 'description', header: c.columns.description, width: COLUMN_WIDTHS.description },
    { id: 'source', header: c.columns.source, width: COLUMN_WIDTHS.source },
    { id: 'details', header: c.columns.details, width: COLUMN_WIDTHS.details },
    { id: 'status', header: c.columns.status, width: COLUMN_WIDTHS.status },
    { id: 'date', header: c.columns.date, width: COLUMN_WIDTHS.date },
    { id: 'amount', header: c.columns.amount, width: COLUMN_WIDTHS.amount, className: 'text-right' },
    { id: 'committed', header: c.columns.committed, width: COLUMN_WIDTHS.committed, className: 'text-right' },
  ];
  return (
    <section aria-label={c.title} className="@container">
      <EntityList<CostLine>
        items={lines}
        isLoading={costs.isLoading}
        error={null}
        headerColumns={headerColumns}
        filters={[]}
        renderRow={(line) => <Row key={line.id} line={line} currency={currency} />}
        hideTopBar
        hasMore={costs.hasNextPage}
        isLoadingMore={costs.isFetchingNextPage}
        onLoadMore={() => void costs.fetchNextPage()}
        emptyState={{
          icon: <FinanceListIllustration />,
          title: c.emptyTitle,
          description: filtered ? c.emptyFiltered : c.emptyDescription,
        }}
        emptyStateClassName="min-h-[calc(100dvh-350px)]"
      />
    </section>
  );
}

/**
 * Finance › Costs: every line that counts toward the project, as a list under
 * the toolbar of the Finance tab (source and date filters).
 */
export default function FinanceCostsPage() {
  const { projectId, copy } = useFinanceEnv();
  const c = copy.costs;
  const finance = useProjectFinance(projectId);
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const query = useMemo(() => toCostQuery(filters), [filters]);
  const canSee = finance.data?.canSeeAmounts ?? false;
  const costs = useProjectCosts(projectId, query.filters, PAGE_SIZE, canSee);
  const lines = useMemo(() => {
    const loaded = costs.data?.pages.flatMap((page) => page.data) ?? [];
    return query.excludedSource ? loaded.filter((line) => line.source !== query.excludedSource) : loaded;
  }, [costs.data, query.excludedSource]);
  // "Source is not" drops lines after they load, so a page can come back short or empty, and an empty list
  // has no scroll trigger to load more: keep loading until a page's worth shows or there is no more.
  const { hasNextPage, isFetchingNextPage, isError: costsFailed, fetchNextPage } = costs;
  const short = !!query.excludedSource && lines.length < PAGE_SIZE;
  useEffect(() => {
    if (short && hasNextPage && !isFetchingNextPage && !costsFailed) void fetchNextPage();
  }, [short, hasNextPage, isFetchingNextPage, costsFailed, fetchNextPage]);
  const filtered = filters.some((filter) => filter.value);
  const denied = !canSee || (isApiError(costs.error) && costs.error.status === 403);

  const filterConfigs: FilterConfig[] = [
    {
      field: COST_FILTER_FIELDS.source,
      label: c.columns.source,
      options: COST_SOURCES.map((source) => ({ value: source, label: copy.sources[source] })),
    },
    { field: COST_FILTER_FIELDS.date, label: c.columns.date, options: [], filterType: 'date' },
  ];

  let body;
  if (finance.isLoading) body = <PageLoader fullScreen={false} className="h-auto min-h-[calc(100dvh-350px)] pb-0" />;
  else if (finance.isError || !finance.data) body = <FinanceErrorState onRetry={() => void finance.refetch()} />;
  else if (denied) body = <PercentOnlyNotice message={c.denied} />;
  else if (costs.isError) body = <FinanceErrorState onRetry={() => void costs.refetch()} />;
  else body = <CostsList costs={costs} lines={lines} filtered={filtered} currency={finance.data.currency} />;

  // The list runs edge to edge; a notice or a failed load keeps the page padding.
  const padded = !finance.isLoading && (finance.isError || !finance.data || denied || costs.isError);
  return (
    <>
      <SubNavToolbar filterConfigs={finance.data && !denied ? filterConfigs : undefined} filters={filters} onFiltersChange={setFilters} />
      {padded ? <div className="px-3 pt-4 md:px-4">{body}</div> : body}
    </>
  );
}
