/** One cost line as the lists show it: source, what it is, where it comes from and what it costs. */

import type { CostLine } from '@weldsuite/app-api-client/domains/project-finance';
import { formatMoney } from '../_lib/finance';
import { useFinanceEnv } from './finance-parts';

/** The title and the line under it, from the line and its source. */
export function useLineText(line: CostLine): { title: string; meta: string } {
  const { copy, format, intlLocale } = useFinanceEnv();
  const day = new Intl.DateTimeFormat(intlLocale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${line.date}T00:00:00Z`));
  if (line.source === 'time') {
    return {
      title: format(copy.costs.timeTitle, { week: line.title ?? '' }),
      meta: format(copy.costs.timeMeta, {
        hours: new Intl.NumberFormat(intlLocale, { maximumFractionDigits: 2 }).format(line.hours ?? 0),
        people: line.people ?? 0,
      }),
    };
  }
  return { title: line.title ?? line.reference ?? line.id, meta: [line.reference, day].filter(Boolean).join(' · ') };
}

export function Amounts({ line, currency }: Readonly<{ line: CostLine; currency: string | null }>) {
  const { intlLocale } = useFinanceEnv();
  const committed = Number(line.committed) !== 0;
  return (
    <div className="text-right tabular-nums">
      <div className="text-sm font-semibold">{formatMoney(line.amount, currency, intlLocale, 2)}</div>
      {committed ? <div className="text-xs text-muted-foreground">+ {formatMoney(line.committed, currency, intlLocale, 2)}</div> : null}
    </div>
  );
}
