import { Check, Flag } from 'lucide-react';
import type { PhaseSummary } from '@weldsuite/app-api-client/domains/project-schedule';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { fill, intlLocaleOf, shortDate } from '../../dependencies/_lib/format';

type PhasesCopy = ReturnType<typeof useI18n>['t']['flowSchedule']['phases'];
type StepTone = 'done' | 'current' | 'upcoming';

const STATE_TEXT: Record<StepTone, string> = {
  done: 'text-emerald-700 dark:text-emerald-400',
  current: 'text-blue-700 dark:text-blue-400',
  upcoming: 'text-muted-foreground',
};

const GATE_BADGE: Record<StepTone, string> = {
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  current: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  upcoming: 'bg-muted text-muted-foreground',
};

function toneOf(status: PhaseSummary['status']): StepTone {
  if (status === 'passed') return 'done';
  if (status === 'active') return 'current';
  return 'upcoming';
}

function phaseDates(phase: PhaseSummary, copy: PhasesCopy, locale: string): string {
  if (phase.plannedStart && phase.plannedEnd) {
    return fill(copy.datesRange, { start: shortDate(phase.plannedStart, locale), end: shortDate(phase.plannedEnd, locale) });
  }
  if (phase.plannedEnd) return shortDate(phase.plannedEnd, locale);
  return copy.noDates;
}

function phaseGate(phase: PhaseSummary, tone: StepTone, copy: PhasesCopy, locale: string): string {
  if (tone === 'done') {
    return fill(copy.gatePassed, { number: phase.gateNumber, date: phase.passedAt ? shortDate(phase.passedAt, locale) : '' });
  }
  if (phase.plannedEnd) return fill(copy.gatePlanned, { number: phase.gateNumber, date: shortDate(phase.plannedEnd, locale) });
  return fill(copy.gateOpen, { number: phase.gateNumber });
}

function stepLineClass(last: boolean, done: boolean): string {
  if (last) return 'bg-transparent';
  return done ? 'bg-emerald-600' : 'bg-border';
}

function PhaseStep({ phase, last }: Readonly<{ phase: PhaseSummary; last: boolean }>) {
  const { t, language } = useI18n();
  const copy = t.flowSchedule.phases;
  const locale = intlLocaleOf(language);
  const tone = toneOf(phase.status);
  const done = tone === 'done';
  const current = tone === 'current';
  const stateText = { done: copy.stateDone, current: copy.stateCurrent, upcoming: copy.stateUpcoming }[tone];

  return (
    <li className="w-44 shrink-0 pr-3" aria-current={current ? 'step' : undefined}>
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
        <span aria-hidden className={cn('ml-1 h-0.5 flex-1', stepLineClass(last, done))} />
      </div>
      <div className="mt-2 text-sm font-semibold">{phase.name}</div>
      <div className="text-xs text-muted-foreground">{phaseDates(phase, copy, locale)}</div>
      <div className={cn('text-xs', STATE_TEXT[tone])}>{stateText}</div>
      <div className={cn('mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs', GATE_BADGE[tone])}>
        <Flag aria-hidden className="size-3" />
        {phaseGate(phase, tone, copy, locale)}
      </div>
    </li>
  );
}

/** The lifecycle stepper: each phase with its dates, its state and the gate that ends it. */
export function Lifecycle({ phases }: Readonly<{ phases: readonly PhaseSummary[] }>) {
  const { t } = useI18n();
  const copy = t.flowSchedule.phases;

  return (
    <section aria-label={copy.stepperLabel} className="overflow-x-auto rounded-lg border bg-card p-4">
      <ol className="flex min-w-max gap-0">
        {phases.map((phase, index) => (
          <PhaseStep key={phase.id} phase={phase} last={index === phases.length - 1} />
        ))}
      </ol>
    </section>
  );
}
