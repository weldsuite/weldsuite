/** The text of one cost line: what it is, and where it comes from. */

import type { CostLine } from '@weldsuite/app-api-client/domains/project-finance';
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
