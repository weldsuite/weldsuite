/** Cost by deliverable: budget share, labour, expenses, purchases, actual, committed, forecast and variance. */

import type { FinanceRow, ProjectFinance } from '@weldsuite/app-api-client/domains/project-finance';
import { cn } from '@/lib/utils';
import { formatMoney, formatPercent, formatSigned } from '../_lib/finance';
import { useFinanceEnv } from './finance-parts';

function Amount({ value, currency, locale, bold }: Readonly<{ value: string | null; currency: string | null; locale: string; bold?: boolean }>) {
  const zero = value !== null && Number(value) === 0;
  return <span className={cn(bold && 'font-medium', zero && 'text-muted-foreground')}>{zero ? '–' : formatMoney(value, currency, locale)}</span>;
}

function varianceClass(value: string | null): string {
  const n = Number(value);
  if (value === null || n === 0) return 'text-muted-foreground';
  return n > 0 ? 'text-orange-800 dark:text-orange-300' : 'text-green-700 dark:text-green-400';
}

export function BreakdownTable({ finance }: Readonly<{ finance: ProjectFinance }>) {
  const { copy, intlLocale } = useFinanceEnv();
  const b = copy.overview.breakdown;
  const { currency, rows, figures } = finance;
  // Without finance rights there are no amounts to tabulate: the percent of the work done is all there is.
  const amounts = finance.canSeeAmounts;

  if (rows.length === 0) {
    return (
      <section aria-labelledby="finance-breakdown-title" className="rounded-lg border bg-card p-6 text-center">
        <h2 id="finance-breakdown-title" className="text-sm font-semibold">
          {b.title}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{b.empty}</p>
      </section>
    );
  }

  const head = 'px-2.5 py-2 text-right font-medium';
  return (
    <section aria-labelledby="finance-breakdown-title" className="overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-baseline gap-x-3 border-b px-4 py-3">
        <h2 id="finance-breakdown-title" className="text-sm font-semibold">
          {b.title}
        </h2>
        <span className="text-xs text-muted-foreground">{b.subtitle}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[60rem] border-collapse text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="px-4 py-2 text-left font-medium">
                {b.deliverable}
              </th>
              <th scope="col" className={head}>
                {b.done}
              </th>
              {amounts ? (
                <>
                  {(['budget', 'labour', 'expenses', 'purchases', 'actual', 'committed', 'forecast'] as const).map((key) => (
                    <th key={key} scope="col" className={head}>
                      {b[key]}
                    </th>
                  ))}
                  <th scope="col" className={cn(head, 'pr-4')}>
                    {b.variance}
                  </th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Row key={row.id ?? 'other'} row={row} currency={currency} amounts={amounts} />
            ))}
            {amounts ? (
              <tr className="border-t bg-muted/40 font-semibold">
                <th scope="row" className="px-4 py-2.5 text-left">
                  {b.total}
                </th>
                <td />
                <td className="px-2.5 py-2.5 text-right">{formatMoney(figures.budget, currency, intlLocale)}</td>
                <td className="px-2.5 py-2.5 text-right">{formatMoney(sum(rows, 'labour'), currency, intlLocale)}</td>
                <td className="px-2.5 py-2.5 text-right">{formatMoney(sum(rows, 'expenses'), currency, intlLocale)}</td>
                <td className="px-2.5 py-2.5 text-right">{formatMoney(sum(rows, 'purchases'), currency, intlLocale)}</td>
                <td className="px-2.5 py-2.5 text-right">{formatMoney(figures.actual, currency, intlLocale)}</td>
                <td className="px-2.5 py-2.5 text-right">{formatMoney(figures.committed, currency, intlLocale)}</td>
                <td className="px-2.5 py-2.5 text-right">{formatMoney(figures.forecast, currency, intlLocale)}</td>
                <td className={cn('px-2.5 py-2.5 pr-4 text-right', varianceClass(figures.variance))}>{formatSigned(figures.variance, currency, intlLocale)}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {rows.some((row) => row.id === null) && amounts ? <p className="border-t px-4 py-2 text-xs text-muted-foreground">{b.otherNote}</p> : null}
    </section>
  );
}

function sum(rows: readonly FinanceRow[], key: 'labour' | 'expenses' | 'purchases'): string {
  return String(rows.reduce((total, row) => total + Number(row[key] ?? 0), 0));
}

function Row({ row, currency, amounts }: Readonly<{ row: FinanceRow; currency: string | null; amounts: boolean }>) {
  const { copy, intlLocale } = useFinanceEnv();
  const cell = 'px-2.5 py-2 text-right tabular-nums whitespace-nowrap';
  return (
    <tr className="border-t">
      <th scope="row" className="px-4 py-2 text-left font-medium whitespace-nowrap">
        {row.code ? <span className="mr-2 inline-block min-w-7 font-normal text-muted-foreground">{row.code}</span> : null}
        {row.title ?? copy.overview.breakdown.other}
      </th>
      <td className={cell}>{formatPercent(row.percentDone, intlLocale)}%</td>
      {amounts ? (
        <>
          <td className={cell}>
            <Amount value={row.budget} currency={currency} locale={intlLocale} />
          </td>
          <td className={cn(cell, 'text-muted-foreground')}>
            <Amount value={row.labour} currency={currency} locale={intlLocale} />
          </td>
          <td className={cn(cell, 'text-muted-foreground')}>
            <Amount value={row.expenses} currency={currency} locale={intlLocale} />
          </td>
          <td className={cn(cell, 'text-muted-foreground')}>
            <Amount value={row.purchases} currency={currency} locale={intlLocale} />
          </td>
          <td className={cell}>
            <Amount value={row.actual} currency={currency} locale={intlLocale} bold />
          </td>
          <td className={cn(cell, 'text-muted-foreground')}>
            <Amount value={row.committed} currency={currency} locale={intlLocale} />
          </td>
          <td className={cell}>
            <Amount value={row.forecast} currency={currency} locale={intlLocale} />
          </td>
          <td className={cn(cell, 'pr-4 font-semibold', varianceClass(row.variance))}>{formatSigned(row.variance, currency, intlLocale)}</td>
        </>
      ) : null}
    </tr>
  );
}
