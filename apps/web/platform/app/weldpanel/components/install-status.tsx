/**
 * Whether a project's snippet is working: a status badge, the time of the last
 * event and the three steps to get the first one. Used on the Overview and at
 * the top of the project's Install tab.
 *
 * It polls through `useWeldPanelInstall` until the first event is in. A paused
 * project says so instead: the collector drops its events, so a "receiving"
 * from before the pause would mislead.
 */

import { ArrowRight, CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldPanelInstall } from '@/hooks/queries/use-weldpanel-queries';

interface InstallStatusProps {
  projectId: string;
  paused: boolean;
  /** Add a link to the project's install instructions (for the Overview). */
  showLink?: boolean;
}

function StepIcon({ done, spinning }: Readonly<{ done: boolean; spinning: boolean }>) {
  if (done) return <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />;
  if (spinning) return <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />;
  return <Circle className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

export function InstallStatus({ projectId, paused, showLink = false }: Readonly<InstallStatusProps>) {
  const { t, format, language } = useI18n();
  const ti = t.weldpanel.install;
  const { data: install, isLoading, isError, refetch } = useWeldPanelInstall(projectId);

  const receiving = install?.status === 'receiving';
  const waiting = install?.status === 'waiting' && !paused;

  let pill = <Skeleton className="h-5 w-32 rounded-full" />;
  if (paused) {
    pill = <Badge variant="warning">{ti.paused}</Badge>;
  } else if (install) {
    pill = receiving ? (
      <Badge variant="success">
        <span className="size-1.5 rounded-full bg-current" aria-hidden />
        {ti.receiving}
      </Badge>
    ) : (
      <Badge variant="secondary">{ti.waiting}</Badge>
    );
  }

  let detail: React.ReactNode = <Skeleton className="h-4 w-48" />;
  if (paused) {
    detail = ti.pausedNote;
  } else if (install?.lastEventAt) {
    detail = format(ti.lastEvent, {
      time: new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(install.lastEventAt)),
    });
  } else if (receiving) {
    detail = ti.arriving;
  } else if (install) {
    detail = ti.noEvents;
  }

  const steps = [ti.steps.paste, ti.steps.open, ti.steps.wait];

  return (
    <section aria-labelledby={`install-status-${projectId}`} className="space-y-4 rounded-lg border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`install-status-${projectId}`} className="text-base font-medium">
          {ti.statusTitle}
        </h2>
        {pill}
      </div>

      {isError ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span>{ti.loadFailed}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
            {t.weldpanel.retry}
          </Button>
        </div>
      ) : (
        <div className="text-sm text-muted-foreground" aria-live="polite" aria-busy={isLoading}>
          {detail}
        </div>
      )}

      {!isError && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{ti.checklistTitle}</h3>
          <ol className="space-y-1.5">
            {steps.map((step, index) => {
              const done = receiving && !paused;
              const last = index === steps.length - 1;
              return (
                <li key={step} className="flex items-center gap-2 text-sm">
                  <StepIcon done={done} spinning={last && waiting} />
                  <span className={done ? 'text-muted-foreground' : undefined}>{step}</span>
                </li>
              );
            })}
          </ol>
          {waiting && <p className="text-xs text-muted-foreground">{ti.pollHint}</p>}
        </div>
      )}

      {showLink && (
        <Button asChild variant="outline" size="sm">
          <Link href={`/weldpanel/projects/${projectId}`}>
            {ti.openProject}
            <ArrowRight />
          </Link>
        </Button>
      )}
    </section>
  );
}
