import { Check, Flag } from 'lucide-react';
import type { PhaseSummary } from '@weldsuite/app-api-client/domains/project-schedule';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { fill, intlLocaleOf, shortDate } from '../../dependencies/_lib/format';

/** The lifecycle stepper: each phase with its dates, its state and the gate that ends it. */
export function Lifecycle({ phases }: Readonly<{ phases: readonly PhaseSummary[] }>) {
  const { t, language } = useI18n();
  const copy = t.flowSchedule.phases;
  const locale = intlLocaleOf(language);

  return (
    <section aria-label={copy.stepperLabel} className="overflow-x-auto rounded-lg border bg-card p-4">
      <ol className="flex min-w-max gap-0">
        {phases.map((phase, index) => {
          const done = phase.status === 'passed';
          const current = phase.status === 'active';
          const last = index === phases.length - 1;
          const dates =
            phase.plannedStart && phase.plannedEnd
              ? fill(copy.datesRange, { start: shortDate(phase.plannedStart, locale), end: shortDate(phase.plannedEnd, locale) })
              : phase.plannedEnd
                ? shortDate(phase.plannedEnd, locale)
                : copy.noDates;
          const gate = done
            ? fill(copy.gatePassed, { number: phase.gateNumber, date: phase.passedAt ? shortDate(phase.passedAt, locale) : '' })
            : phase.plannedEnd
              ? fill(copy.gatePlanned, { number: phase.gateNumber, date: shortDate(phase.plannedEnd, locale) })
              : fill(copy.gateOpen, { number: phase.gateNumber });
          return (
            <li key={phase.id} className="w-44 shrink-0 pr-3" aria-current={current ? 'step' : undefined}>
              <div className="flex items-center">
                <span
                  aria-hidden
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded-full border-2',
                    done && 'border-emerald-600 bg-emerald-600 text-white',
                    current && 'border-blue-600 bg-blue-600',
                    !done && !current && 'border-neutral-300 bg-background',
                  )}
                >
                  {done && <Check className="size-3" strokeWidth={3.5} />}
                  {current && <span className="size-1.5 rounded-full bg-white" />}
                </span>
                <span aria-hidden className={cn('ml-1 h-0.5 flex-1', last ? 'bg-transparent' : done ? 'bg-emerald-600' : 'bg-border')} />
              </div>
              <div className="mt-2 text-sm font-semibold">{phase.name}</div>
              <div className="text-xs text-muted-foreground">{dates}</div>
              <div className={cn('text-xs', done ? 'text-emerald-700 dark:text-emerald-400' : current ? 'text-blue-700 dark:text-blue-400' : 'text-muted-foreground')}>
                {done ? copy.stateDone : current ? copy.stateCurrent : copy.stateUpcoming}
              </div>
              <div
                className={cn(
                  'mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs',
                  done ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : current ? 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300' : 'bg-muted text-muted-foreground',
                )}
              >
                <Flag aria-hidden className="size-3" />
                {gate}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
