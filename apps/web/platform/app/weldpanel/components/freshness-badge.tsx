/** How fresh a result is: "Data as of 14:32" and a `cached` marker; hover explains the one to two minute delay. */

import { Clock, RefreshCw } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useI18n } from '@/lib/i18n/provider';

interface FreshnessBadgeProps {
  dataAsOf: string | undefined;
  cached?: boolean;
  fetching?: boolean;
  onRefresh?: () => void;
  clampedToRetention?: boolean;
}

export function FreshnessBadge({ dataAsOf, cached, fetching, onRefresh, clampedToRetention }: Readonly<FreshnessBadgeProps>) {
  const { t, language } = useI18n();
  const tf = t.weldpanel.analytics.freshness;
  if (!dataAsOf) return null;
  const time = new Intl.DateTimeFormat(language, { timeStyle: 'short' }).format(new Date(dataAsOf));
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-default items-center gap-1">
            <Clock className="size-3.5" aria-hidden />
            <span>{tf.asOf.replace('{time}', time)}</span>
            {cached && <span className="rounded bg-muted px-1.5 py-0.5">{tf.cached}</span>}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{tf.hint}</TooltipContent>
      </Tooltip>
      {clampedToRetention && <span>{tf.clamped}</span>}
      {onRefresh && (
        <Button type="button" variant="ghost" size="icon" className="size-6" onClick={onRefresh} disabled={fetching} aria-label={tf.refresh}>
          <RefreshCw className={fetching ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
      )}
    </div>
  );
}
