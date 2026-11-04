/**
 * The tasks behind a risk (mitigation) or an issue (resolution): progress,
 * the linked tasks with a done checkbox, and the two ways to add one.
 */

import { Link2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import type { LinkedObject, RaidItem } from '@weldsuite/app-api-client/domains/project-control';
import { useObjectPanel } from '@/components/object-panel';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useDeleteControlLink, useSetRaidTaskDone } from '@/hooks/queries/use-project-control-queries';
import { intlLocaleOf } from '../_lib/locale';
import { formatShortDate, progressPercent } from '../_lib/raid';
import { OwnerCell } from './raid-parts';
import { useRaid } from './raid-context';

interface DetailTasksProps {
  item: RaidItem;
  /** The tasks linked to the item; undefined while the detail loads. */
  tasks: LinkedObject[] | undefined;
  onCreateTask: () => void;
  onLinkTask: () => void;
}

function TaskRow({ link }: Readonly<{ link: LinkedObject }>) {
  const { t, language, format } = useI18n();
  const copy = t.projects.raid;
  const { projectId, abilities, now } = useRaid();
  const { open: openObjectPanel } = useObjectPanel();
  const setDone = useSetRaidTaskDone(projectId);
  const unlink = useDeleteControlLink();
  const task = link.target;
  const done = task.status === 'done';
  const cancelled = task.status === 'cancelled';
  let dueLabel: string = copy.tasks.done;
  if (!done) dueLabel = task.dueDate ? formatShortDate(task.dueDate, intlLocaleOf(language), now) : copy.tasks.noDate;

  const toggle = async () => {
    try {
      await setDone.mutateAsync({ taskId: task.id, done: !done });
    } catch {
      toast.error(copy.toasts.taskUpdateFailed);
    }
  };

  const remove = async () => {
    try {
      await unlink.mutateAsync(link.id);
      toast.success(copy.toasts.taskUnlinked);
    } catch {
      toast.error(copy.toasts.unlinkFailed);
    }
  };

  return (
    <li className="flex items-center gap-2.5 border-b px-3 py-2.5 last:border-b-0">
      <input
        type="checkbox"
        checked={done}
        disabled={!abilities.updateTasks || cancelled || setDone.isPending}
        onChange={() => void toggle()}
        aria-label={format(done ? copy.tasks.markNotDone : copy.tasks.markDone, { title: task.title })}
        className="size-4 shrink-0 accent-foreground"
      />
      <button
        type="button"
        onClick={() => openObjectPanel({ type: 'task', id: task.id })}
        className={cn(
          'min-w-0 flex-1 truncate text-left text-[13px] outline-none hover:underline focus-visible:underline',
          (done || cancelled) && 'text-muted-foreground line-through',
        )}
      >
        {task.title}
      </button>
      <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
        {dueLabel}
      </span>
      <OwnerCell ownerId={task.ownerId} withName={false} />
      {abilities.update ? (
        <Button type="button" variant="ghost" size="icon-xs" onClick={() => void remove()} disabled={unlink.isPending} aria-label={copy.tasks.unlink} title={copy.tasks.unlink}>
          <X aria-hidden />
        </Button>
      ) : null}
    </li>
  );
}

export function DetailTasks({ item, tasks, onCreateTask, onLinkTask }: Readonly<DetailTasksProps>) {
  const { t, format } = useI18n();
  const copy = t.projects.raid.tasks;
  const { abilities } = useRaid();
  const isRisk = item.kind === 'risk';
  const percent = progressPercent(item.taskProgress);

  return (
    <section aria-labelledby="raid-tasks-title" className="px-6 pt-6">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 id="raid-tasks-title" className="text-sm font-semibold">
          {isRisk ? copy.mitigation : copy.resolution}{' '}
          <span className="font-medium text-muted-foreground">
            {format(copy.progress, { done: item.taskProgress.done, total: item.taskProgress.total })}
          </span>
        </h2>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={item.taskProgress.total}
        aria-valuenow={item.taskProgress.done}
        className="mb-2 h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-foreground/80" style={{ width: `${percent}%` }} />
      </div>

      {tasks === undefined ? <Skeleton className="h-24 rounded-lg" /> : null}
      {tasks?.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-[13px] text-muted-foreground">{copy.none}</p>
      ) : null}
      {tasks && tasks.length > 0 ? (
        <ul className="rounded-lg border">
          {tasks.map((link) => (
            <TaskRow key={link.id} link={link} />
          ))}
        </ul>
      ) : null}

      {abilities.update ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {abilities.createTasks ? (
            <Button type="button" variant="outline" size="sm" onClick={onCreateTask}>
              <Plus aria-hidden />
              {isRisk ? copy.createMitigation : copy.createResolution}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={onLinkTask}>
            <Link2 aria-hidden />
            {copy.linkExisting}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
