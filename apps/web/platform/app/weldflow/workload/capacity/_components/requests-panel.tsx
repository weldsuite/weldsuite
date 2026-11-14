import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import type { ResourceRequest } from '@weldsuite/app-api-client/domains/flow-portfolio';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useBookResourceRequest, useSuggestions, useUpdateResourceRequest } from '@/hooks/queries/use-flow-portfolio-queries';
import { formatDay, intlLocaleOf } from '../_lib/capacity';

interface PanelProps {
  requests: ResourceRequest[];
  isLoading: boolean;
  /** May book people and cancel requests (portfolio:manage, or a project manager). */
  canBook: boolean;
  nameOf: (id: string) => string;
}

/** The people for one request, by free hours, with Assign and Book tentatively. */
function Suggestions({ request, canBook, nameOf }: Readonly<{ request: ResourceRequest; canBook: boolean; nameOf: (id: string) => string }>) {
  const { t, format } = useI18n();
  const copy = t.flowPortfolio.capacity.requests;
  const { data, isLoading, isError } = useSuggestions(request.id);
  const book = useBookResourceRequest();
  const need = Number(request.hoursPerWeek);
  const run = (memberId: string, tentative: boolean) =>
    book.mutate(
      { id: request.id, input: { memberId, tentative } },
      {
        onSuccess: () => toast.success(tentative ? t.flowPortfolio.capacity.bookedTentatively : t.flowPortfolio.capacity.booked),
        onError: () => toast.error(t.flowPortfolio.common.saveFailed),
      },
    );
  if (isLoading) {
    return (
      <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {copy.loadingSuggestions}
      </p>
    );
  }
  if (isError || !data) return <p className="mt-3 text-xs text-destructive">{t.flowPortfolio.common.loadFailed}</p>;
  return (
    <div className="mt-3">
      <h4 className="mb-2 text-xs font-semibold text-muted-foreground">{copy.suggested}</h4>
      {data.suggestions.length === 0 ? <p className="text-xs text-muted-foreground">{copy.noSuggestions}</p> : null}
      <ul className="flex flex-col gap-2">
        {data.suggestions.map((s) => {
          const pct = need > 0 ? Math.min(100, Math.round((s.freeHoursPerWeek / need) * 100)) : 0;
          return (
            <li key={s.memberId} className="rounded-lg border bg-background p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{nameOf(s.memberId)}</div>
                  <div className="truncate text-xs text-muted-foreground">{s.skills.join(', ')}</div>
                </div>
                {s.coversRequest ? <span className="text-xs font-medium text-green-700 dark:text-green-400">{copy.covered}</span> : null}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-1.5 bg-primary" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-xs whitespace-nowrap text-muted-foreground">{format(copy.free, { free: s.freeHoursPerWeek, need })}</span>
              </div>
              {canBook ? (
                <div className="mt-2.5 flex gap-1.5">
                  <Button size="sm" disabled={book.isPending} onClick={() => run(s.memberId, false)}>
                    {copy.assign}
                  </Button>
                  <Button size="sm" variant="outline" className="border-dashed" disabled={book.isPending} onClick={() => run(s.memberId, true)}>
                    {copy.bookTentatively}
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {data.suggestions.length > 0 && !data.suggestions.some((s) => s.coversRequest) ? (
        <p className="mt-2.5 text-xs text-muted-foreground">{format(copy.split, { need, total: data.totalFreeHoursPerWeek })}</p>
      ) : null}
      {data.truncated ? <p className="mt-1 text-xs text-muted-foreground">{copy.truncated}</p> : null}
    </div>
  );
}

/** Open resource requests of the portfolio; the first one shows its suggested people. */
export function RequestsPanel({ requests, isLoading, canBook, nameOf }: Readonly<PanelProps>) {
  const { t, format, language } = useI18n();
  const copy = t.flowPortfolio.capacity.requests;
  const locale = intlLocaleOf(language);
  const [selected, setSelected] = useState<string | null>(null);
  const update = useUpdateResourceRequest();
  const current = selected ?? requests[0]?.id ?? null;
  return (
    <aside aria-labelledby="req-title" className="max-w-[380px] min-w-0 flex-[1_1_320px] overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <h2 id="req-title" className="flex-1 text-[15px] font-semibold">
          {copy.title}
        </h2>
        <span className="rounded-full bg-muted px-2 text-xs font-semibold text-foreground/80">{format(copy.open, { count: requests.length })}</span>
      </div>
      {isLoading ? <Loader2 aria-hidden className="m-4 size-4 animate-spin text-muted-foreground" /> : null}
      {!isLoading && requests.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{copy.empty}</p> : null}
      {requests.map((request) => {
        const open = request.id === current;
        return (
          <article key={request.id} className={cn('border-b p-4 last:border-b-0', open && 'bg-muted/30')}>
            <button type="button" aria-expanded={open} onClick={() => setSelected(open ? '' : request.id)} className="block w-full text-left">
              <div className="text-xs text-muted-foreground">{request.projectName}</div>
              <h3 className="mt-1 text-sm font-semibold">
                {format(t.flowPortfolio.common.hoursPerWeek, { hours: Number(request.hoursPerWeek) })} · {request.skill}
              </h3>
              <div className="mt-0.5 text-sm text-foreground/80">
                {format(t.flowPortfolio.common.period, { from: formatDay(request.startsOn, locale), to: formatDay(request.endsOn, locale) })}
              </div>
            </button>
            {open ? <Suggestions request={request} canBook={canBook} nameOf={nameOf} /> : null}
            {open && canBook ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 text-muted-foreground"
                disabled={update.isPending}
                onClick={() =>
                  update.mutate({ id: request.id, input: { status: 'cancelled' } }, { onError: () => toast.error(t.flowPortfolio.common.saveFailed) })
                }
              >
                {copy.cancel}
              </Button>
            ) : null}
          </article>
        );
      })}
    </aside>
  );
}
