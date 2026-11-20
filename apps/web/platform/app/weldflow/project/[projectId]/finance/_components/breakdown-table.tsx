/** Cost by deliverable: budget share, labour, expenses, purchases, actual, committed, forecast and variance. */

import type { FinanceRow, ProjectFinance } from '@weldsuite/app-api-client/domains/project-finance';
import { EntityList, type HeaderColumn } from '@/components/entity-list';
import { LIST_CELL_CLASS, LIST_MENU_CELL_CLASS, LIST_ROW_CLASS, ListTitle } from '@/app/weldflow/components/list-cells';
import { cn } from '@/lib/utils';
import { formatMoney, formatPercent, formatSigned } from '../_lib/finance';
import { FinanceListIllustration } from './finance-list-illustration';
import { useFinanceEnv } from './finance-parts';

type AmountKey = 'budget' | 'labour' | 'expenses' | 'purchases' | 'actual' | 'committed' | 'forecast' | 'variance';
type AmountValues = Readonly<Record<AmountKey, string | null>>;

/** A list row: a deliverable (or the "other work" line), or the total under them. */
type Item = { id: string; kind: 'row'; row: FinanceRow } | { id: string; kind: 'total' };

/** The amount columns, the secondary ones muted and shown only where the list is wide enough. */
const COLUMNS: readonly { id: AmountKey; width: string; muted?: boolean }[] = [
  { id: 'budget', width: 'hidden w-[100px] @2xl:flex' },
  { id: 'labour', width: 'hidden w-[100px] @6xl:flex', muted: true },
  { id: 'expenses', width: 'hidden w-[100px] @6xl:flex', muted: true },
  { id: 'purchases', width: 'hidden w-[100px] @6xl:flex', muted: true },
  { id: 'actual', width: 'w-[100px]' },
  { id: 'committed', width: 'hidden w-[100px] @5xl:flex', muted: true },
  { id: 'forecast', width: 'hidden w-[100px] @3xl:flex' },
  { id: 'variance', width: 'hidden w-[90px] @xl:flex' },
];
const TITLE_WIDTH = 'min-w-[100px] flex-1';
const DONE_WIDTH = 'w-[64px]';
const NUMBER_HEADER = 'justify-end text-right';

function varianceClass(value: string | null): string {
  const n = Number(value);
  if (value === null || n === 0) return 'text-muted-foreground';
  return n > 0 ? 'text-orange-800 dark:text-orange-300' : 'text-green-700 dark:text-green-400';
}

function sum(rows: readonly FinanceRow[], key: 'labour' | 'expenses' | 'purchases'): string {
  return String(rows.reduce((total, row) => total + Number(row[key] ?? 0), 0));
}

/** One amount cell: a dash for zero, the variance signed and coloured, the total in bold. */
function AmountText({
  id,
  value,
  currency,
  muted,
  total,
}: Readonly<{ id: AmountKey; value: string | null; currency: string | null; muted?: boolean; total: boolean }>) {
  const { intlLocale } = useFinanceEnv();
  const base = cn('truncate text-sm tabular-nums', total && 'font-semibold');
  if (id === 'variance') {
    return <span className={cn(base, 'font-medium', varianceClass(value))}>{formatSigned(value, currency, intlLocale)}</span>;
  }
  if (value !== null && Number(value) === 0) return <span className={cn(base, 'text-muted-foreground')}>–</span>;
  return (
    <span className={cn(base, muted && !total ? 'text-gray-600 dark:text-muted-foreground' : 'text-gray-900 dark:text-foreground')}>
      {formatMoney(value, currency, intlLocale)}
    </span>
  );
}

export function BreakdownTable({ finance }: Readonly<{ finance: ProjectFinance }>) {
  const { copy, intlLocale } = useFinanceEnv();
  const b = copy.overview.breakdown;
  const { currency, rows, figures } = finance;
  // Without finance rights there are no amounts to list: the percent of the work done is all there is.
  const amounts = finance.canSeeAmounts;

  const totals: AmountValues = {
    budget: figures.budget,
    labour: sum(rows, 'labour'),
    expenses: sum(rows, 'expenses'),
    purchases: sum(rows, 'purchases'),
    actual: figures.actual,
    committed: figures.committed,
    forecast: figures.forecast,
    variance: figures.variance,
  };
  const items: Item[] = [
    ...rows.map((row): Item => ({ id: row.id ?? 'other', kind: 'row', row })),
    ...(amounts && rows.length > 0 ? [{ id: 'total', kind: 'total' } as const] : []),
  ];

  // EntityList adds the 40px header spacer of the menu column itself.
  const headerColumns: HeaderColumn[] = [
    { id: 'deliverable', header: b.deliverable, width: TITLE_WIDTH },
    { id: 'done', header: b.done, width: DONE_WIDTH, className: NUMBER_HEADER },
    ...(amounts ? COLUMNS.map((column) => ({ id: column.id, header: b[column.id], width: column.width, className: NUMBER_HEADER })) : []),
  ];

  const renderRow = (item: Item) => {
    const total = item.kind === 'total';
    const values: AmountValues = total ? totals : item.row;
    return (
      <div key={item.id} className={cn(LIST_ROW_CLASS, 'cursor-default')}>
        <div className={cn(LIST_CELL_CLASS, TITLE_WIDTH)}>
          {total ? (
            <span className="truncate text-sm font-semibold text-gray-900 dark:text-foreground">{b.total}</span>
          ) : (
            <ListTitle code={item.row.code} title={item.row.title ?? b.other} />
          )}
        </div>
        <div className={cn(LIST_CELL_CLASS, DONE_WIDTH, 'justify-end')}>
          {total ? null : (
            <span className="text-sm tabular-nums text-gray-600 dark:text-muted-foreground">{formatPercent(item.row.percentDone, intlLocale)}%</span>
          )}
        </div>
        {amounts
          ? COLUMNS.map((column) => (
              <div key={column.id} className={cn(LIST_CELL_CLASS, column.width, 'justify-end')}>
                <AmountText id={column.id} value={values[column.id]} currency={currency} muted={column.muted} total={total} />
              </div>
            ))
          : null}
        <div className={LIST_MENU_CELL_CLASS} />
      </div>
    );
  };

  return (
    // Pulled out of the page padding, so the list runs edge to edge like every other list.
    <section aria-labelledby="finance-breakdown-title" className="@container -mx-3 md:-mx-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border/70 px-4 pb-3">
        <h2 id="finance-breakdown-title" className="text-sm font-semibold">
          {b.title}
        </h2>
        <span className="text-xs text-muted-foreground">{b.subtitle}</span>
      </div>
      <EntityList<Item>
        items={items}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={[]}
        renderRow={renderRow}
        hideTopBar
        emptyState={{ icon: <FinanceListIllustration />, title: b.empty, description: '' }}
        emptyStateClassName="min-h-[18rem]"
      />
    </section>
  );
}
