/**
 * Pieces every Finance screen shares: the project and locale it works in, the
 * loading and error states, the percentages-only notice and the source badge.
 */

import { AlertCircle, Info } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import type { CostSource } from '@weldsuite/app-api-client/domains/project-finance';
import { useParams } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { intlLocaleOf } from '../../raid/_lib/locale';

/** The project of the route and the user's number and date locale. */
export function useFinanceEnv() {
  const { projectId } = useParams<{ projectId: string }>();
  const { t, format, language } = useI18n();
  return { projectId, t, copy: t.flowFinance, format, intlLocale: intlLocaleOf(language) };
}

export function FinanceLoadingState() {
  const { copy } = useFinanceEnv();
  return (
    <div role="status" aria-busy="true" aria-label={copy.title} className="flex flex-col gap-4">
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))]">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-lg" />
    </div>
  );
}

export function FinanceErrorState({ onRetry }: Readonly<{ onRetry: () => void }>) {
  const { copy } = useFinanceEnv();
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center">
      <div className="rounded-full bg-muted p-3">
        <AlertCircle aria-hidden className="size-6 text-muted-foreground" />
      </div>
      <h2 className="text-base font-semibold">{copy.states.loadFailedTitle}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{copy.states.loadFailedDescription}</p>
      <Button type="button" variant="outline" onClick={onRetry}>
        {copy.states.retry}
      </Button>
    </div>
  );
}

/** Shown to a member without finance rights: the figures are percentages. */
export function PercentOnlyNotice({ message }: Readonly<{ message?: string }>) {
  const { copy } = useFinanceEnv();
  return (
    <div role="note" className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
      <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{message ?? copy.states.percentOnly}</span>
    </div>
  );
}

const SOURCE_STYLES: Record<CostSource, string> = {
  time: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200',
  bill: 'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200',
  journal: 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-200',
  purchase_order: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  declaration: 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-200',
};

export function SourceBadge({ source }: Readonly<{ source: CostSource }>) {
  const { copy } = useFinanceEnv();
  return (
    <Badge variant="secondary" className={cn('border-transparent font-medium', SOURCE_STYLES[source])}>
      {copy.sources[source]}
    </Badge>
  );
}

/** A labelled figure tile. */
export function Tile({
  label,
  value,
  note,
  tone = 'default',
}: Readonly<{ label: string; value: string; note?: string; tone?: 'default' | 'warning' | 'good' }>) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-card p-4',
        tone === 'warning' && 'border-orange-300 bg-orange-50 dark:border-orange-900 dark:bg-orange-950/30',
      )}
    >
      <div className={cn('text-xs text-muted-foreground', tone === 'warning' && 'text-orange-800 dark:text-orange-300')}>{label}</div>
      <div
        className={cn(
          'mt-1 text-2xl font-semibold tabular-nums',
          tone === 'warning' && 'text-orange-900 dark:text-orange-200',
          tone === 'good' && 'text-green-700 dark:text-green-400',
        )}
      >
        {value}
      </div>
      {note ? <div className={cn('mt-0.5 text-xs text-muted-foreground', tone === 'warning' && 'text-orange-800 dark:text-orange-300')}>{note}</div> : null}
    </div>
  );
}
