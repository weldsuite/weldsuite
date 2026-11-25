import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { Button } from '@weldsuite/ui/components/button';
import type { Sprint } from '@weldsuite/app-api-client/schemas/flow-agile';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useSprintReport } from '@/hooks/queries/use-flow-agile-queries';
import { SprintPicker } from '@/components/weldflow/agile/sprint-picker';
import { sprintDay } from '@/app/weldflow/lib/sprint-metrics';
import { intlLocaleOf, shortDate } from '../../gantt/dependencies/_lib/format';
import { SprintActions } from './sprint-actions';

export const SPRINT_STATUS_TONE: Record<string, SoftTone> = {
  planned: 'neutral',
  active: 'success',
  completed: 'neutral',
  cancelled: 'warning',
};

/** The status of a sprint as a soft badge. */
export function SprintStatusBadge({ status }: Readonly<{ status: string }>) {
  const { t } = useI18n();
  const labels = t.flowAgile.sprintStatus;
  return <SoftBadge tone={SPRINT_STATUS_TONE[status] ?? 'neutral'}>{status in labels ? labels[status as keyof typeof labels] : status}</SoftBadge>;
}

/** "Nov 18 – Dec 1", or the "no dates" text. */
export function useSprintDates(): (sprint: Pick<Sprint, 'startDate' | 'endDate'>) => string {
  const { t, language, format } = useI18n();
  const locale = intlLocaleOf(language);
  return (sprint) =>
    sprint.startDate && sprint.endDate
      ? format(t.flowAgileSprints.dateRange, { start: shortDate(sprint.startDate, locale), end: shortDate(sprint.endDate, locale) })
      : t.flowAgileSprints.noDates;
}

/**
 * The row above the Pipeline of a sprint project: the sprint picker, then the
 * picked sprint's status, dates, day, goal and progress, with a link to its
 * page and Start or Complete sprint.
 */
export function SprintBar({
  projectId,
  sprints,
  sprint,
  onSprintChange,
}: Readonly<{
  projectId: string;
  sprints: readonly Sprint[];
  /** The picked sprint; null for all open work. */
  sprint: Sprint | null;
  onSprintChange?: (sprintId: string | null) => void;
}>) {
  const { t, format } = useI18n();
  const copy = t.flowAgileSprints.bar;
  const dates = useSprintDates();
  const report = useSprintReport(projectId, sprint && sprint.status !== 'planned' ? sprint.id : null);
  const day = sprint?.status === 'active' ? sprintDay(sprint) : null;

  const total = report.data ? report.data.committed.points + report.data.added.points - report.data.removed.points : null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-gray-200 px-4 py-2 dark:border-border">
      {onSprintChange ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t.flowAgileSprints.picker.label}</span>
          <SprintPicker sprints={sprints} value={sprint?.id ?? null} onChange={onSprintChange} />
        </div>
      ) : null}

      {sprint ? (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <SprintStatusBadge status={sprint.status} />
            <span className="text-muted-foreground tabular-nums">
              {dates(sprint)}
              {day ? ` · ${format(copy.day, { day: day.day, total: day.total })}` : ''}
            </span>
            {sprint.goal ? <span className="min-w-0 max-w-md truncate" title={sprint.goal}>{format(copy.goal, { goal: sprint.goal })}</span> : null}
            {sprint.status === 'planned' ? <span className="text-muted-foreground">{copy.plannedHint}</span> : null}
          </div>

          {report.data && total !== null ? (
            <div className="flex flex-wrap items-center gap-x-3 text-sm tabular-nums">
              <span>{format(copy.progress, { done: report.data.completed.points, total })}</span>
              {report.data.added.points > 0 ? (
                <span className="text-amber-700 dark:text-amber-400">{format(copy.added, { points: report.data.added.points })}</span>
              ) : null}
            </div>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/weldflow/project/${projectId}/sprints/${sprint.id}`}>{copy.sprintPage}</Link>
            </Button>
            <SprintActions
              projectId={projectId}
              sprint={sprint}
              onCompleted={(result) => onSprintChange?.(result.nextSprintId)}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
