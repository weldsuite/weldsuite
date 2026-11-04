import { useMemo, useState } from 'react';
import { Receipt } from 'lucide-react';
import { isApiError } from '@weldsuite/api-client';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { COST_SOURCES, type CostSource } from '@weldsuite/app-api-client/schemas/project-finance';
import { useProjectCosts, type CostFilters } from '@/hooks/queries/use-project-finance-queries';
import { useProjectFinance } from '@/hooks/queries/use-project-finance-queries';
import { Amounts, useLineText } from '../_components/cost-line';
import { FinanceErrorState, PercentOnlyNotice, SourceBadge, useFinanceEnv } from '../_components/finance-parts';
import type { CostLine } from '@weldsuite/app-api-client/domains/project-finance';

const ALL = '__all__';

function Row({ line, currency }: Readonly<{ line: CostLine; currency: string | null }>) {
  const { intlLocale } = useFinanceEnv();
  const { title, meta } = useLineText(line);
  const date = new Intl.DateTimeFormat(intlLocale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${line.date}T00:00:00Z`));
  return (
    <tr className="border-t align-top">
      <td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground">{date}</td>
      <td className="px-2.5 py-2.5">
        <SourceBadge source={line.source} />
      </td>
      <td className="px-2.5 py-2.5">
        <div className="font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{meta}</div>
      </td>
      <td className="px-2.5 py-2.5 text-muted-foreground capitalize">{line.status ?? ''}</td>
      <td className="px-4 py-2.5">
        <Amounts line={line} currency={currency} />
      </td>
    </tr>
  );
}

function CostFilterBar({
  source,
  from,
  to,
  filtered,
  onSource,
  onFrom,
  onTo,
  onClear,
}: Readonly<{
  source: CostSource | undefined;
  from: string;
  to: string;
  filtered: boolean;
  onSource: (value: CostSource | undefined) => void;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  onClear: () => void;
}>) {
  const { copy } = useFinanceEnv();
  const c = copy.costs;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="finance-source">{c.filterSource}</Label>
        <Select value={source ?? ALL} onValueChange={(value) => onSource(value === ALL ? undefined : (value as CostSource))}>
          <SelectTrigger id="finance-source" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{c.allSources}</SelectItem>
            {COST_SOURCES.map((value) => (
              <SelectItem key={value} value={value}>
                {copy.sources[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="finance-from">{c.from}</Label>
        <Input id="finance-from" type="date" value={from} max={to || undefined} onChange={(event) => onFrom(event.target.value)} className="w-40" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="finance-to">{c.to}</Label>
        <Input id="finance-to" type="date" value={to} min={from || undefined} onChange={(event) => onTo(event.target.value)} className="w-40" />
      </div>
      {filtered ? (
        <Button type="button" variant="ghost" onClick={onClear}>
          {c.clear}
        </Button>
      ) : null}
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
  if (costs.isLoading) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-2">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-12" />
        ))}
      </div>
    );
  }
  if (costs.isError) return <FinanceErrorState onRetry={() => void costs.refetch()} />;
  if (lines.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center">
        <div className="rounded-full bg-muted p-3">
          <Receipt aria-hidden className="size-6 text-muted-foreground" />
        </div>
        <h3 className="text-base font-semibold">{c.emptyTitle}</h3>
        <p className="max-w-sm text-sm text-muted-foreground">{filtered ? c.emptyFiltered : c.emptyDescription}</p>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] border-collapse text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="px-4 py-2 text-left font-medium">
                {c.columns.date}
              </th>
              <th scope="col" className="px-2.5 py-2 text-left font-medium">
                {c.columns.source}
              </th>
              <th scope="col" className="px-2.5 py-2 text-left font-medium">
                {c.columns.description}
              </th>
              <th scope="col" className="px-2.5 py-2 text-left font-medium">
                {c.columns.status}
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                {c.columns.amount}
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <Row key={line.id} line={line} currency={currency} />
            ))}
          </tbody>
        </table>
      </div>
      {costs.hasNextPage ? (
        <div className="flex justify-center border-t p-3">
          <Button type="button" variant="outline" disabled={costs.isFetchingNextPage} onClick={() => void costs.fetchNextPage()}>
            {costs.isFetchingNextPage ? c.loadingMore : c.loadMore}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Finance › Costs: every line that counts toward the project, by source, with filters. */
export default function FinanceCostsPage() {
  const { projectId, copy } = useFinanceEnv();
  const c = copy.costs;
  const finance = useProjectFinance(projectId);
  const [source, setSource] = useState<CostSource | undefined>();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const filters = useMemo<CostFilters>(() => ({ source, from: from || undefined, to: to || undefined }), [source, from, to]);
  const canSee = finance.data?.canSeeAmounts ?? false;
  const costs = useProjectCosts(projectId, filters, 25, canSee);
  const lines = costs.data?.pages.flatMap((page) => page.data) ?? [];
  const filtered = !!source || !!from || !!to;

  if (finance.isLoading) return <Skeleton className="h-64 rounded-lg" role="status" aria-busy="true" />;
  if (finance.isError || !finance.data) return <FinanceErrorState onRetry={() => void finance.refetch()} />;
  if (!canSee) return <PercentOnlyNotice message={c.denied} />;
  const denied = isApiError(costs.error) && costs.error.status === 403;
  if (denied) return <PercentOnlyNotice message={c.denied} />;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold">{c.title}</h2>
        <p className="text-sm text-muted-foreground">{c.description}</p>
      </div>

      <CostFilterBar
        source={source}
        from={from}
        to={to}
        filtered={filtered}
        onSource={setSource}
        onFrom={setFrom}
        onTo={setTo}
        onClear={() => {
          setSource(undefined);
          setFrom('');
          setTo('');
        }}
      />

      <CostsList costs={costs} lines={lines} filtered={filtered} currency={finance.data.currency} />
      <p className="text-xs text-muted-foreground">{c.doubleCount}</p>
    </div>
  );
}
