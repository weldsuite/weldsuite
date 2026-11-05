/**
 * Change requests that wait for approval, as "+€x if approved". They come from
 * the governance routes; the card stays out of the way when those are not
 * there or nothing is pending.
 */

import { Link } from '@/lib/router';
import type { ProjectFinance } from '@weldsuite/app-api-client/domains/project-finance';
import { usePendingChanges } from '@/hooks/queries/use-project-finance-queries';
import { formatMoney, formatSigned } from '../_lib/finance';
import { useFinanceEnv } from './finance-parts';

export function PendingChangeCard({ finance }: Readonly<{ finance: ProjectFinance }>) {
  const { projectId, copy, format, intlLocale } = useFinanceEnv();
  const pending = usePendingChanges(projectId, finance.canSeeAmounts);
  const changes = pending.data ?? [];
  const withCost = changes.filter((change) => change.costDelta !== 0);
  if (!finance.canSeeAmounts || withCost.length === 0) return null;

  const c = copy.overview.pending;
  const delta = withCost.reduce((total, change) => total + change.costDelta, 0);
  const first = withCost[0];
  const title = withCost.length === 1 ? format(c.one, { code: first.code ?? '' }) : format(c.many, { count: withCost.length });
  const budget = finance.figures.budget === null ? null : Number(finance.figures.budget) + delta;
  const note = budget === null ? undefined : format(c.budgetWould, { budget: formatMoney(String(budget), finance.currency, intlLocale) });

  return (
    <Link
      href={`/weldflow/project/${projectId}/governance/changes`}
      className="block rounded-lg border border-orange-300 bg-orange-50 p-4 text-foreground no-underline dark:border-orange-900 dark:bg-orange-950/30"
    >
      <div className="text-xs text-orange-800 dark:text-orange-300">
        {title}
        {withCost.length === 1 && first.title ? ` · ${first.title}` : ''}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{format(c.ifApproved, { amount: formatSigned(String(delta), finance.currency, intlLocale) })}</div>
      {note ? <div className="mt-0.5 text-xs text-orange-800 dark:text-orange-300">{note}</div> : null}
    </Link>
  );
}
