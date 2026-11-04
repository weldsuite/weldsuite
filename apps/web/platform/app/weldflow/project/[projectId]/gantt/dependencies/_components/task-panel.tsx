import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import type { DependencyType, ProjectSchedule, ScheduleTask, TaskDependency } from '@weldsuite/app-api-client/domains/project-schedule';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import {
  useApplyScheduleMove,
  useDeleteTaskDependency,
  useMoveTaskDates,
  useScheduleMovePreview,
  useUpdateTaskDependency,
} from '@/hooks/queries/use-project-schedule-queries';
import { linksOfTask } from '../_lib/gantt';
import { fill, intlLocaleOf, shortDate, taskLabel } from '../_lib/format';
import { FIELD_CLASS } from './add-dependency-dialog';

const TYPES: readonly DependencyType[] = ['fs', 'ss', 'ff', 'sf'];

interface PanelProps {
  projectId: string;
  schedule: ProjectSchedule;
  task: ScheduleTask | null;
  canWrite: boolean;
  onAddLink: (initial: { predecessorId?: string; successorId?: string }) => void;
}

function LinkRow({
  link,
  other,
  canWrite,
  projectId,
}: Readonly<{ link: TaskDependency; other: ScheduleTask | undefined; canWrite: boolean; projectId: string }>) {
  const { t } = useI18n();
  const copy = t.flowSchedule.dependencies;
  const update = useUpdateTaskDependency();
  const remove = useDeleteTaskDependency(projectId);
  const [lag, setLag] = useState(String(link.lagDays));
  useEffect(() => setLag(String(link.lagDays)), [link.lagDays]);

  const save = async (data: { type?: DependencyType; lagDays?: number }) => {
    try {
      await update.mutateAsync({ id: link.id, data });
    } catch {
      toast.error(copy.states.updateFailed);
      setLag(String(link.lagDays));
    }
  };
  const label = other ? taskLabel(other) : '?';

  return (
    <div className="flex items-end gap-2 rounded-md border p-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground tabular-nums">{label}</div>
        <div className="truncate text-sm">{other?.title}</div>
      </div>
      <label className="grid gap-0.5 text-xs text-muted-foreground">
        {copy.panel.type}
        <select
          className={cn(FIELD_CLASS, 'w-[4.5rem]')}
          value={link.type}
          disabled={!canWrite}
          onChange={(event) => void save({ type: event.target.value as DependencyType })}
        >
          {TYPES.map((kind) => (
            <option key={kind} value={kind}>
              {t.flowSchedule.linkTypes[kind]}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-0.5 text-xs text-muted-foreground" title={copy.panel.lagHint}>
        {copy.panel.lag}
        <input
          type="number"
          className={cn(FIELD_CLASS, 'w-16')}
          value={lag}
          disabled={!canWrite}
          onChange={(event) => setLag(event.target.value)}
          onBlur={() => {
            const next = Number(lag);
            if (Number.isInteger(next) && next !== link.lagDays && Math.abs(next) <= 3650) void save({ lagDays: next });
            else setLag(String(link.lagDays));
          }}
        />
      </label>
      {canWrite && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={fill(copy.panel.remove, { task: label })}
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(link.id, {
              onSuccess: () => toast.success(copy.states.removed),
              onError: () => toast.error(copy.states.removeFailed),
            })
          }
        >
          <X aria-hidden className="size-4" />
        </Button>
      )}
    </div>
  );
}

/** The impact of moving the selected task, before it is saved. */
function ImpactSection({ projectId, schedule, task, canWrite }: Readonly<{ projectId: string; schedule: ProjectSchedule; task: ScheduleTask; canWrite: boolean }>) {
  const { t, language } = useI18n();
  const copy = t.flowSchedule.dependencies.impact;
  const locale = intlLocaleOf(language);
  const current = task.plannedStart ?? '';
  const [startDate, setStartDate] = useState(current);
  useEffect(() => setStartDate(task.plannedStart ?? ''), [task.id, task.plannedStart]);
  const changed = startDate !== '' && startDate !== current && !task.done;
  const move = changed ? { taskId: task.id, startDate } : null;
  const preview = useScheduleMovePreview(projectId, move);
  const apply = useApplyScheduleMove(projectId);
  const moveDates = useMoveTaskDates(projectId);
  const byId = new Map(schedule.tasks.map((other) => [other.id, other]));
  const impact = preview.data;

  const save = async () => {
    if (!impact) return;
    try {
      if (schedule.settings.autoSchedule) await apply.mutateAsync({ taskId: task.id, startDate });
      else await moveDates.mutateAsync({ taskId: task.id, startDate: impact.task.startDate, dueDate: impact.task.dueDate });
      toast.success(copy.applied);
    } catch {
      toast.error(copy.applyFailed);
    }
  };

  const dependents = impact ? impact.moved.filter((moved) => moved.taskId !== task.id) : [];
  const finishLimitDays = impact ? Math.max(0, impact.finishShiftDays) : 0;

  return (
    <section aria-labelledby="impact-title" className="rounded-lg border bg-card p-4">
      <h2 id="impact-title" className="text-sm font-semibold">
        {copy.title}
      </h2>
      <label className="mt-3 grid gap-1 text-xs text-muted-foreground">
        {copy.startLabel}
        <input type="date" className={FIELD_CLASS} value={startDate} disabled={!task.scheduled && !canWrite} onChange={(event) => setStartDate(event.target.value)} />
      </label>

      {changed && preview.isLoading && <p className="mt-3 text-sm text-muted-foreground">{copy.loading}</p>}
      {changed && preview.isError && (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
          {copy.failed}
        </p>
      )}
      {changed && impact && (
        <div className="mt-3 grid gap-3 text-sm">
          <p>
            {dependents.length === 0 && impact.deliverables.length === 0
              ? copy.summaryNone
              : fill(copy.summary, { count: dependents.length, deliverables: impact.deliverables.length })}
          </p>
          <ul className="grid gap-1">
            {impact.moved.map((moved) => {
              const other = byId.get(moved.taskId);
              return (
                <li key={moved.taskId} className="flex items-center gap-2">
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{other ? taskLabel(other) : ''}</span>
                  <span className="min-w-0 flex-1 truncate">{other?.title}</span>
                  <span className={cn('shrink-0 text-xs tabular-nums', moved.shiftDays > 0 ? 'text-orange-700 dark:text-orange-400' : 'text-muted-foreground')}>
                    {moved.taskId === task.id
                      ? `${shortDate(moved.toStart, locale)} to ${shortDate(moved.toFinish, locale)}`
                      : fill(copy.movedBy, { days: moved.shiftDays })}
                  </span>
                </li>
              );
            })}
            {impact.deliverables.map((deliverable) => (
              <li key={deliverable.id} className="flex items-center gap-2">
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{deliverable.code}</span>
                <span className="min-w-0 flex-1 truncate">{deliverable.title}</span>
                <span className="shrink-0 text-xs tabular-nums text-orange-700 dark:text-orange-400">{fill(copy.movedBy, { days: deliverable.shiftDays })}</span>
              </li>
            ))}
            {impact.before.goLiveSlackDays !== null && impact.after.goLiveSlackDays !== null && (
              <li className="flex items-center gap-2">
                <span className="min-w-0 flex-1">{copy.goLiveFloat}</span>
                <span className={cn('shrink-0 text-xs tabular-nums', impact.exceedsGoLive ? 'text-red-700 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400')}>
                  {fill(copy.floatChange, { before: impact.before.goLiveSlackDays, after: impact.after.goLiveSlackDays })}
                </span>
              </li>
            )}
          </ul>
          {impact.newConflicts.length > 0 && (
            <div>
              <div className="text-xs font-medium text-red-700 dark:text-red-400">{copy.newConflicts}</div>
              <ul className="mt-1 grid gap-0.5 text-xs">
                {impact.newConflicts.map((conflict) => (
                  <li key={conflict.linkId}>
                    {fill(copy.conflictLine, {
                      task: byId.get(conflict.successorId) ? taskLabel(byId.get(conflict.successorId) as ScheduleTask) : '',
                      predecessor: byId.get(conflict.predecessorId) ? taskLabel(byId.get(conflict.predecessorId) as ScheduleTask) : '',
                    })}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className={cn('text-xs', impact.exceedsGoLive || finishLimitDays > impact.scheduleLimitDays ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground')}>
            {limitMessageOf(copy, impact, finishLimitDays)}
          </p>
          {!impact.autoSchedule && <p className="text-xs text-muted-foreground">{copy.applyOffNote}</p>}
          {canWrite && (
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={() => void save()} disabled={apply.isPending || moveDates.isPending}>
                {impact.autoSchedule ? copy.apply : copy.applyMoveOnly}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setStartDate(current)}>
                {copy.cancel}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function limitMessageOf(
  copy: { exceeds: string; overLimit: string; withinLimit: string },
  impact: { exceedsGoLive: boolean; scheduleLimitDays: number; after: { goLiveSlackDays: number | null } },
  finishLimitDays: number,
): string {
  if (impact.exceedsGoLive) return fill(copy.exceeds, { days: Math.abs(impact.after.goLiveSlackDays ?? 0) });
  const values = { days: finishLimitDays, limit: impact.scheduleLimitDays };
  if (finishLimitDays > impact.scheduleLimitDays) return fill(copy.overLimit, values);
  return fill(copy.withinLimit, values);
}

function taskStatusText(task: ScheduleTask, copy: { critical: string; done: string; float: string; unscheduled: string }): string {
  if (task.critical) return copy.critical;
  if (task.done) return copy.done;
  if (task.totalFloat !== null) return fill(copy.float, { days: task.totalFloat });
  return copy.unscheduled;
}

/** The selected task: what it waits for, what waits for it, and what a move would do. */
export function TaskPanel({ projectId, schedule, task, canWrite, onAddLink }: Readonly<PanelProps>) {
  const { t, language } = useI18n();
  const copy = t.flowSchedule.dependencies.panel;
  const locale = intlLocaleOf(language);
  if (!task) {
    return (
      <aside aria-label={copy.label} className="rounded-lg border border-dashed bg-card p-4 text-sm text-muted-foreground">
        {copy.select}
      </aside>
    );
  }
  const { predecessors, successors } = linksOfTask(schedule, task.id);
  const byId = new Map(schedule.tasks.map((other) => [other.id, other]));
  const status = taskStatusText(task, copy);

  return (
    <aside aria-label={copy.label} className="grid content-start gap-4">
      <section className="rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">{taskLabel(task)}</span>
          <span className={cn('rounded-full px-2 py-0.5 text-xs', task.critical ? 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300' : 'bg-muted text-muted-foreground')}>
            {status}
          </span>
        </div>
        <h2 className="mt-1 text-base font-semibold">{task.title}</h2>
        {task.plannedStart && task.plannedFinish && (
          <p className="mt-0.5 text-xs text-muted-foreground">{`${shortDate(task.plannedStart, locale)} to ${shortDate(task.plannedFinish, locale)}`}</p>
        )}

        {([
          [copy.waitsFor, predecessors, 'predecessorId'],
          [copy.blocks, successors, 'successorId'],
        ] as const).map(([heading, links, otherKey]) => (
          <div key={heading} className="mt-4">
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{heading}</h3>
            {links.length === 0 ? (
              <p className="text-sm text-muted-foreground">{copy.none}</p>
            ) : (
              <div className="grid gap-2">
                {links.map((link) => (
                  <LinkRow key={link.id} link={link} other={byId.get(link[otherKey])} canWrite={canWrite} projectId={projectId} />
                ))}
              </div>
            )}
          </div>
        ))}

        {canWrite && (
          <Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => onAddLink({ successorId: task.id })}>
            <Plus aria-hidden className="size-3.5" />
            {copy.linkAnother}
          </Button>
        )}
      </section>

      <ImpactSection projectId={projectId} schedule={schedule} task={task} canWrite={canWrite} />
    </aside>
  );
}
