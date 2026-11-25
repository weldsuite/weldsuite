import { useMemo } from 'react';
import type { PhaseSummary } from '@weldsuite/app-api-client/domains/project-schedule';
import type { Sprint } from '@weldsuite/app-api-client/schemas/flow-agile';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useProjectDelivery, useProjectSprints } from '@/hooks/queries/use-flow-agile-queries';
import { useOpenBacklogPoints } from '@/hooks/queries/use-flow-agile-sprint-queries';
import { averageVelocity } from '@/app/weldflow/lib/delivery';
import { dayNumber, todayNumber } from '@/app/weldflow/lib/sprint-metrics';
import { dateOfDay, monthTicks, xOf, type Timeline } from '../../dependencies/_lib/gantt';
import { intlLocaleOf, shortDate } from '../../dependencies/_lib/format';
import { forecastPhase, placeSprintsInPhases, sprintsOfCapacityLeft, type ForecastState } from '../_lib/phase-sprints';

const PHASE_BAR: Record<PhaseSummary['status'], string> = {
  passed: 'bg-emerald-500/80 dark:bg-emerald-500/60',
  active: 'bg-blue-500/80 dark:bg-blue-500/60',
  upcoming: 'bg-muted-foreground/30',
};

const FORECAST_TONE: Record<ForecastState, SoftTone> = {
  onPlan: 'success',
  late: 'warning',
  unknown: 'neutral',
  done: 'success',
};

/** The sprint's last day: its end date, else a sprint length after its start. */
function sprintEndDay(sprint: Sprint, lengthDays: number): number | null {
  const end = dayNumber(sprint.endDate);
  if (end !== null) return end;
  const start = dayNumber(sprint.startDate);
  return start === null ? null : start + lengthDays - 1;
}

/** The days the timeline covers: every phase and sprint date and today, with a margin. */
function buildTimeline(phases: readonly PhaseSummary[], sprints: readonly Sprint[], lengthDays: number, today: number): Timeline | null {
  const days: number[] = [];
  for (const phase of phases) {
    for (const date of [phase.plannedStart, phase.plannedEnd]) {
      const day = dayNumber(date);
      if (day !== null) days.push(day);
    }
  }
  if (days.length === 0) return null;
  for (const sprint of sprints) {
    const start = dayNumber(sprint.startDate);
    const end = sprintEndDay(sprint, lengthDays);
    if (start !== null) days.push(start);
    if (end !== null) days.push(end);
  }
  days.push(today);
  const startDay = Math.min(...days) - 7;
  const endDay = Math.max(...days) + 14;
  return { startDay, endDay, pxPerDay: 1, width: endDay - startDay + 1 };
}

/**
 * Gantt, Phases: the phases as bars by their planned dates, each sprint inside
 * the phase that holds its start date, a marker for today and, for the phase that
 * is running, a forecast from the open backlog points and the average velocity.
 * Shown for a hybrid project, and for any project that has sprints.
 */
export function PhaseTimeline({ projectId, phases }: Readonly<{ projectId: string; phases: readonly PhaseSummary[] }>) {
  const { t, plural, format, language } = useI18n();
  const copy = t.flowAgileSprints.phases;
  const locale = intlLocaleOf(language);
  const delivery = useProjectDelivery(projectId);
  const sprintsQuery = useProjectSprints(projectId, delivery.available);
  const backlog = useOpenBacklogPoints(projectId, delivery.available);

  const sprints = useMemo(() => sprintsQuery.data ?? [], [sprintsQuery.data]);
  const visible = delivery.available && ((delivery.usesPhases && delivery.usesSprints) || sprints.length > 0);
  const lengthDays = delivery.settings.sprintLengthDays;
  const today = todayNumber();

  const live = useMemo(() => sprints.filter((sprint) => sprint.status !== 'cancelled'), [sprints]);
  const timeline = useMemo(() => buildTimeline(phases, live, lengthDays, today), [phases, live, lengthDays, today]);
  const placed = useMemo(() => placeSprintsInPhases(phases, live), [phases, live]);
  const ticks = useMemo(() => (timeline ? monthTicks(timeline) : []), [timeline]);

  if (!visible) return null;

  const active = phases.find((phase) => phase.status === 'active') ?? null;
  const activeSprint = sprints.find((sprint) => sprint.status === 'active') ?? null;
  const velocity = averageVelocity(sprints);
  const forecast =
    active && backlog.data
      ? forecastPhase({
          openPoints: backlog.data.open,
          velocity,
          sprintLengthDays: lengthDays,
          activeSprintEnd: activeSprint?.endDate ?? null,
          phaseEnd: active.plannedEnd,
        })
      : null;
  const capacity = active
    ? sprintsOfCapacityLeft({ sprintLengthDays: lengthDays, activeSprintEnd: activeSprint?.endDate ?? null, phaseEnd: active.plannedEnd })
    : null;

  const pct = (day: number) => (timeline ? (xOf(timeline, day) / timeline.width) * 100 : 0);
  const span = (startDay: number, endDay: number) => ({ left: `${pct(startDay)}%`, width: `${Math.max(pct(endDay + 1) - pct(startDay), 0.6)}%` });
  const monthFormat = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  const day = (value: number) => shortDate(dateOfDay(value), locale);

  const stateText: Record<ForecastState, string> = {
    onPlan: copy.stateOnPlan,
    late: copy.stateLate,
    unknown: copy.stateUnknown,
    done: copy.stateDone,
  };

  let verdict: string | null = null;
  if (forecast?.state === 'done') verdict = copy.nothingLeft;
  else if (forecast?.state === 'unknown') verdict = copy.noVelocity;
  else if (forecast && forecast.finishDay !== null) {
    const likely = format(forecast.sprintsLeft === 1 ? copy.likelyDoneOne : copy.likelyDone, {
      date: day(forecast.finishDay),
      count: forecast.sprintsLeft,
    });
    const behind =
      forecast.state === 'late' && active?.plannedEnd
        ? format(forecast.lateBySprints === 1 ? copy.behindPlanOne : copy.behindPlan, {
            end: shortDate(active.plannedEnd, locale),
            count: forecast.lateBySprints,
          })
        : null;
    verdict = behind ? `${likely} ${behind}` : likely;
  }

  const donePoints = backlog.data ? backlog.data.total - backlog.data.open : 0;
  const donePercent = backlog.data && backlog.data.total > 0 ? Math.round((donePoints / backlog.data.total) * 100) : 0;

  return (
    <section aria-labelledby="phase-timeline-title" className="grid gap-4 rounded-xl border bg-card p-4">
      <div>
        <h2 id="phase-timeline-title" className="text-base font-semibold">
          {copy.title}
        </h2>
        <p className="text-sm text-muted-foreground">{copy.description}</p>
      </div>

      {timeline === null ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{copy.noDates}</p>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[36rem]" role="group" aria-label={copy.timelineLabel}>
            <div className="grid grid-cols-[9rem_minmax(0,1fr)] items-end gap-x-3">
              <span />
              <div className="relative h-6 border-b text-xs text-muted-foreground" aria-hidden>
                {ticks.map((tick) => (
                  <span key={tick.day} className="absolute bottom-1 -translate-x-0 whitespace-nowrap" style={{ left: `${pct(tick.day)}%` }}>
                    {monthFormat.format(new Date(tick.day * 86_400_000))}
                  </span>
                ))}
              </div>
            </div>

            <ol className="relative grid gap-y-2 pt-2">
              {phases.map((phase) => {
                const start = dayNumber(phase.plannedStart);
                const end = dayNumber(phase.plannedEnd);
                const inPhase = placed.byPhase.get(phase.id) ?? [];
                return (
                  <li key={phase.id} className="grid grid-cols-[9rem_minmax(0,1fr)] items-center gap-x-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{phase.name}</p>
                      <p className="truncate text-xs text-muted-foreground tabular-nums">
                        {phase.plannedStart && phase.plannedEnd
                          ? format(t.flowAgileSprints.dateRange, { start: shortDate(phase.plannedStart, locale), end: shortDate(phase.plannedEnd, locale) })
                          : t.flowAgileSprints.noDates}
                      </p>
                    </div>
                    <div className="grid gap-1">
                      <div className="relative h-5">
                        {start !== null && end !== null ? (
                          <div
                            aria-hidden
                            className={cn('absolute inset-y-0 rounded-md', PHASE_BAR[phase.status])}
                            style={span(start, end)}
                          />
                        ) : null}
                      </div>
                      {inPhase.length > 0 ? (
                        <div className="relative h-5" role="list" aria-label={format(copy.sprintsInPhase, { phase: phase.name })}>
                          {inPhase.map((sprint) => {
                            const sStart = dayNumber(sprint.startDate) ?? dayNumber(sprint.endDate);
                            const sEnd = sprintEndDay(sprint, lengthDays);
                            if (sStart === null || sEnd === null) return null;
                            return (
                              <div
                                key={sprint.id}
                                role="listitem"
                                title={`${sprint.name} · ${day(sStart)} – ${day(sEnd)}`}
                                className={cn(
                                  'absolute inset-y-0 flex items-center justify-center overflow-hidden rounded border border-background px-1 text-[11px] font-medium text-white',
                                  sprint.status === 'completed' ? 'bg-violet-500/70' : 'bg-violet-600 dark:bg-violet-500',
                                  sprint.status === 'planned' && 'bg-violet-400/60 text-violet-950 dark:text-white',
                                )}
                                style={span(sStart, sEnd)}
                              >
                                <span className="truncate">{sprint.name}</span>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
              {/* Today: one line over every row. */}
              {today >= timeline.startDay && today <= timeline.endDay ? (
                <li aria-hidden className="pointer-events-none absolute inset-y-0 left-[9.75rem] right-0 list-none">
                  <div className="absolute inset-y-0" style={{ left: `${pct(today)}%` }}>
                    <div className="h-full w-px bg-destructive/70" />
                    <span className="absolute -top-1 left-1 -translate-y-full whitespace-nowrap rounded bg-destructive/10 px-1 text-[10px] font-medium text-destructive">
                      {copy.today}
                    </span>
                  </div>
                </li>
              ) : null}
            </ol>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-blue-500/80" />
          {copy.legendGate}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-violet-600" />
          {copy.legendSprint}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-px bg-destructive/70" />
          {copy.today}
        </span>
      </div>
      {placed.unplaced.length > 0 ? <p className="text-xs text-muted-foreground">{plural(placed.unplaced.length, copy.unplaced)}</p> : null}

      {active && forecast ? (
        <div className="grid gap-2 rounded-lg border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{format(copy.forecastTitle, { phase: active.name })}</h3>
            <SoftBadge tone={FORECAST_TONE[forecast.state]}>{stateText[forecast.state]}</SoftBadge>
          </div>
          {velocity ? <p className="text-xs text-muted-foreground">{format(copy.forecastBasis, { velocity })}</p> : null}
          {backlog.data ? (
            <div className="grid gap-1.5">
              <p className="text-sm tabular-nums">
                {[
                  format(copy.pointsLeft, { points: backlog.data.open }),
                  capacity === null ? null : plural(capacity, copy.capacityLeft),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <div
                role="progressbar"
                aria-label={format(t.flowAgileSprints.bar.progress, { done: donePoints, total: backlog.data.total })}
                aria-valuemin={0}
                aria-valuemax={backlog.data.total}
                aria-valuenow={donePoints}
                className="h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div className="h-full rounded-full bg-primary" style={{ width: `${donePercent}%` }} />
              </div>
            </div>
          ) : null}
          {verdict ? <p className="text-sm">{verdict}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
