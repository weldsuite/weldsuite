/**
 * The sprint parts of the Backlog: the active sprint as a compact summary, and
 * each planned sprint as a section with an editable goal, its planned points
 * against the forecast (the average velocity of the last completed sprints)
 * and Start sprint.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useDroppable } from '@dnd-kit/core';
import { toast } from 'sonner';
import type { Sprint } from '@weldsuite/app-api-client/schemas/flow-agile';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useDateLocale } from '@/lib/i18n/date-locale';
import { cn } from '@/lib/utils';
import { apiMessage } from '@/app/weldflow/project/[projectId]/close/_lib/api-error';
import { daysLeft, sprintPlan, sumPoints, type BacklogItem } from '@/app/weldflow/lib/backlog';
import { useStartSprint, useUpdateSprint } from '@/hooks/queries/use-flow-agile-queries';

function useSprintDates(sprint: Sprint): string | null {
  const { t, format } = useI18n();
  const { formatShort } = useDateLocale();
  if (!sprint.startDate || !sprint.endDate) return null;
  return format(t.flowAgileBacklog.sprint.dates, { start: formatShort(sprint.startDate), end: formatShort(sprint.endDate) });
}

// ── Active ──────────────────────────────────────────────────────────────────

export function ActiveSprintCard({
  sprint,
  items,
  projectId,
  canWrite,
}: Readonly<{ sprint: Sprint; items: readonly BacklogItem[]; projectId: string; canWrite: boolean }>) {
  const { t, plural, format } = useI18n();
  const copy = t.flowAgileBacklog.sprint;
  const dates = useSprintDates(sprint);
  const { setNodeRef, isOver } = useDroppable({ id: sprint.id, disabled: !canWrite });
  const total = sumPoints(items);
  const done = sumPoints(items.filter((item) => item.status === 'done'));
  const share = total > 0 ? Math.round((done / total) * 100) : 0;
  const left = daysLeft(sprint.endDate, new Date());
  const remaining = left === null ? null : left === 0 ? copy.ended : left === 1 ? copy.endsToday : plural(left, copy.daysLeft);

  return (
    <section
      ref={setNodeRef}
      aria-label={sprint.name}
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-lg border border-border px-4 py-3 transition-colors',
        isOver && 'border-blue-400 bg-blue-50/60 dark:bg-blue-500/5',
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-[15px] font-semibold">{sprint.name}</h2>
        <SoftBadge tone="success">{t.flowAgile.sprintStatus.active}</SoftBadge>
        {dates || remaining ? <span className="text-[13px] text-muted-foreground">{[dates, remaining].filter(Boolean).join(' · ')}</span> : null}
        {sprint.goal ? <span className="min-w-0 truncate text-[13px]">{format(copy.goal, { goal: sprint.goal })}</span> : null}
      </div>
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-2 text-[13px]">
          <span
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={share}
            aria-valuetext={format(copy.pointsProgress, { done, total })}
            className="block h-1.5 w-28 overflow-hidden rounded-full bg-muted"
          >
            <span className="block h-full bg-blue-600" style={{ width: `${share}%` }} />
          </span>
          <span className="tabular-nums">{format(copy.pointsProgress, { done, total })}</span>
        </span>
        <Link href={`/weldflow/project/${projectId}/sprints/${sprint.id}`} className="text-sm font-medium text-primary hover:underline">
          {copy.openBoard}
        </Link>
      </div>
    </section>
  );
}

// ── Planned ─────────────────────────────────────────────────────────────────

function PlanBar({ items, forecast }: Readonly<{ items: readonly BacklogItem[]; forecast: number | null }>) {
  const { t, plural, format } = useI18n();
  const copy = t.flowAgileBacklog.sprint;
  const plan = sprintPlan(items, forecast);
  const pts = (n: number) => plural(n, t.flowAgile.points);
  const overShare = plan.over ? 1 - plan.plannedShare : 0;
  const markerAt = plan.forecast !== null ? (plan.forecast / Math.max(plan.points, plan.forecast, 1)) * 100 : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
        <span>
          {plan.forecast === null
            ? format(copy.planned, { points: pts(plan.points) })
            : format(copy.plannedForecast, { points: pts(plan.points), forecast: pts(plan.forecast) })}
        </span>
        {plan.over === null ? null : (
          <span
            className={cn(
              'inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium',
              plan.over
                ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'
                : 'border-green-300 bg-green-50 text-green-800 dark:border-green-500/40 dark:bg-green-500/10 dark:text-green-200',
            )}
          >
            {plan.over ? <AlertTriangle aria-hidden className="h-3.5 w-3.5" /> : <CheckCircle2 aria-hidden className="h-3.5 w-3.5" />}
            {plan.over ? copy.overForecast : copy.withinForecast}
          </span>
        )}
      </div>
      <div aria-hidden="true" className="relative h-2 rounded-full bg-muted">
        <div className="absolute inset-y-0 left-0 rounded-full bg-blue-600" style={{ width: `${plan.plannedShare * 100}%` }} />
        {overShare > 0 ? (
          <div
            className="absolute inset-y-0 rounded-r-full bg-amber-500"
            style={{ left: `${plan.plannedShare * 100}%`, width: `${overShare * 100}%` }}
          />
        ) : null}
        {markerAt !== null ? <div className="absolute -inset-y-1 w-0.5 bg-foreground" style={{ left: `${markerAt}%` }} /> : null}
      </div>
      <span className="text-xs text-muted-foreground">{plan.forecast === null ? copy.noForecast : copy.forecastExplain}</span>
    </div>
  );
}

export function PlannedSprintSection({
  sprint,
  items,
  forecast,
  activeSprint,
  projectId,
  canWrite,
  children,
}: Readonly<{
  sprint: Sprint;
  items: readonly BacklogItem[];
  forecast: number | null;
  activeSprint: Sprint | undefined;
  projectId: string;
  canWrite: boolean;
  children: ReactNode;
}>) {
  const { t, plural, format } = useI18n();
  const copy = t.flowAgileBacklog;
  const dates = useSprintDates(sprint);
  const [open, setOpen] = useState(true);
  const [goal, setGoal] = useState(sprint.goal ?? '');
  useEffect(() => setGoal(sprint.goal ?? ''), [sprint.goal]);
  const updateSprint = useUpdateSprint(projectId);
  const startSprint = useStartSprint(projectId);
  const headingId = `sprint-${sprint.id}`;

  const saveGoal = () => {
    const next = goal.trim();
    if (next === (sprint.goal ?? '').trim()) return;
    updateSprint.mutate(
      { id: sprint.id, input: { goal: next === '' ? null : next } },
      { onError: (error) => toast.error(apiMessage(error, t.flowAgile.shared.saveFailed)) },
    );
  };

  const start = () =>
    startSprint.mutate(
      { id: sprint.id },
      {
        onSuccess: () => toast.success(format(copy.sprint.started, { name: sprint.name })),
        onError: (error) => toast.error(apiMessage(error, copy.sprint.startFailed)),
      },
    );

  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section aria-labelledby={headingId} className="overflow-hidden rounded-lg border border-border">
      <div className="flex flex-col gap-3.5 border-b border-border bg-muted/40 px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <button
              type="button"
              aria-expanded={open}
              aria-label={format(open ? copy.backlog.collapse : copy.backlog.expand, { name: sprint.name })}
              onClick={() => setOpen((value) => !value)}
              className="-ml-1 flex h-6 w-6 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Chevron aria-hidden className="h-4 w-4" />
            </button>
            <h2 id={headingId} className="text-[15px] font-semibold">
              {sprint.name}
            </h2>
            <SoftBadge tone="neutral">{t.flowAgile.sprintStatus.planned}</SoftBadge>
            <span className="text-[13px] text-muted-foreground">
              {[dates, plural(items.length, copy.backlog.items)].filter(Boolean).join(' · ')}
            </span>
          </div>
          {canWrite ? (
            <div className="flex items-center gap-2.5">
              {activeSprint ? <span className="text-xs text-muted-foreground">{format(copy.sprint.startBlocked, { name: activeSprint.name })}</span> : null}
              <Button type="button" size="sm" onClick={start} disabled={!!activeSprint || startSprint.isPending}>
                {copy.sprint.startSprint}
              </Button>
            </div>
          ) : null}
        </div>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
          {copy.sprint.goalLabel}
          <Input
            value={goal}
            readOnly={!canWrite}
            placeholder={copy.sprint.goalPlaceholder}
            maxLength={2000}
            onChange={(event) => setGoal(event.target.value)}
            onBlur={saveGoal}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            className="h-9 bg-background text-sm font-normal text-foreground"
          />
        </label>
        <PlanBar items={items} forecast={forecast} />
      </div>
      {open ? children : null}
    </section>
  );
}
