/** The latest cost lines, with a link to all of them. A caller without finance rights does not see the card. */

import { Link } from '@/lib/router';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useProjectCosts } from '@/hooks/queries/use-project-finance-queries';
import { Amounts, useLineText } from './cost-line';
import { SourceBadge, useFinanceEnv } from './finance-parts';
import type { CostLine } from '@weldsuite/app-api-client/domains/project-finance';

function Item({ line, currency }: Readonly<{ line: CostLine; currency: string | null }>) {
  const { title, meta } = useLineText(line);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-t py-2.5 first:border-t-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <SourceBadge source={line.source} />
          <span className="truncate text-sm font-medium">{title}</span>
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">{meta}</div>
      </div>
      <Amounts line={line} currency={currency} />
    </li>
  );
}

function RecentList({ lines, currency }: Readonly<{ lines: CostLine[]; currency: string | null }>) {
  const { copy } = useFinanceEnv();
  if (lines.length === 0) return <p className="mt-3 text-sm text-muted-foreground">{copy.overview.recent.empty}</p>;
  return (
    <ul className="mt-2">
      {lines.map((line) => (
        <Item key={line.id} line={line} currency={currency} />
      ))}
    </ul>
  );
}

export function RecentCosts({ currency }: Readonly<{ currency: string | null }>) {
  const { projectId, copy } = useFinanceEnv();
  const costs = useProjectCosts(projectId, {}, 5);
  const lines = costs.data?.pages[0]?.data ?? [];
  return (
    <section aria-labelledby="finance-recent-title" className="rounded-lg border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="finance-recent-title" className="text-sm font-semibold">
          {copy.overview.recent.title}
        </h2>
        <Link href={`/weldflow/project/${projectId}/finance/costs`} className="text-sm text-primary hover:underline">
          {copy.overview.recent.all}
        </Link>
      </div>
      {costs.isLoading ? (
        <div className="mt-3 flex flex-col gap-2" role="status" aria-busy="true">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-10" />
          ))}
        </div>
      ) : (
        <RecentList lines={lines} currency={currency} />
      )}
    </section>
  );
}
