/**
 * "Last calculated ..." with the Recalculate now button. A manual run is
 * started with `POST /runs`; the newest run is polled until it is done, and the
 * plans reload when it finishes.
 */

import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { getLocale, getTranslations } from '@/lib/i18n';
import { usePlanningRunStatus, useStartPlanningRun } from '@/hooks/queries/use-replenishment-queries';

/** A moment as "today 02:00" style text in the user's locale (date and time). */
function formatMoment(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function RunStatus() {
  const t = getTranslations('weldstashReplenishment').run;
  const locale = getLocale();
  const { can } = usePermissions();
  const { latest, running } = usePlanningRunStatus();
  const start = useStartPlanningRun();

  const finished = latest?.status === 'done' ? latest.finishedAt : null;
  let text: string;
  if (running) text = t.running;
  else if (latest?.status === 'failed') text = t.failed.replace('{error}', latest.error ?? '');
  else if (finished) text = t.lastCalculated.replace('{when}', formatMoment(finished, locale));
  else text = t.never;

  const recalculate = async () => {
    try {
      await start.mutateAsync();
      toast.success(t.started);
    } catch (err) {
      toast.error((err as Error).message || t.startFailed);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <span
        className={latest?.status === 'failed' && !running ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
        role="status"
        aria-live="polite"
      >
        {text}
      </span>
      {can('inventory:manage') && (
        <Button size="sm" variant="outline" disabled={running || start.isPending} onClick={() => void recalculate()}>
          <RefreshCw className={`mr-1 size-4 ${running ? 'animate-spin' : ''}`} />
          {running ? t.calculating : t.recalculate}
        </Button>
      )}
    </div>
  );
}
