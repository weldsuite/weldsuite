import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import type { DependencyType, ProjectSchedule } from '@weldsuite/app-api-client/domains/project-schedule';
import { useI18n } from '@/lib/i18n/provider';
import { useCreateTaskDependency } from '@/hooks/queries/use-project-schedule-queries';
import { wouldCycle } from '../_lib/gantt';
import { taskLabel } from '../_lib/format';

export const FIELD_CLASS =
  'h-9 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50';

const TYPES: readonly DependencyType[] = ['fs', 'ss', 'ff', 'sf'];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  schedule: ProjectSchedule;
  /** Pre-selected ends, when opened from the task panel. */
  initial?: { predecessorId?: string; successorId?: string };
}

/** Link two tasks of the project by type and lag. */
export function AddDependencyDialog({ open, onOpenChange, projectId, schedule, initial }: Readonly<Props>) {
  const { t } = useI18n();
  const copy = t.flowSchedule.dependencies.dialog;
  const [predecessorId, setPredecessorId] = useState(initial?.predecessorId ?? '');
  const [successorId, setSuccessorId] = useState(initial?.successorId ?? '');
  const [type, setType] = useState<DependencyType>('fs');
  const [lag, setLag] = useState('0');
  const create = useCreateTaskDependency(projectId);

  const same = predecessorId !== '' && predecessorId === successorId;
  const cycle = predecessorId !== '' && successorId !== '' && !same && wouldCycle(schedule, predecessorId, successorId);
  const lagNumber = Number(lag);
  const valid = predecessorId !== '' && successorId !== '' && !same && !cycle && Number.isInteger(lagNumber) && Math.abs(lagNumber) <= 3650;

  const submit = async () => {
    try {
      await create.mutateAsync({ predecessorId, successorId, type, lagDays: lagNumber });
      toast.success(copy.created);
      onOpenChange(false);
    } catch {
      toast.error(copy.failed);
    }
  };

  const options = schedule.tasks.filter((task) => task.status !== 'cancelled');
  const taskSelect = (id: string, value: string, set: (next: string) => void) => (
    <select id={id} className={FIELD_CLASS} value={value} onChange={(event) => set(event.target.value)}>
      <option value="">{t.flowSchedule.dependencies.panel.pickTask}</option>
      {options.map((task) => (
        <option key={task.id} value={task.id}>
          {`${taskLabel(task)} ${task.title}`}
        </option>
      ))}
    </select>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1 text-sm" htmlFor="dep-predecessor">
            {copy.predecessor}
            {taskSelect('dep-predecessor', predecessorId, setPredecessorId)}
          </label>
          <label className="grid gap-1 text-sm" htmlFor="dep-successor">
            {copy.successor}
            {taskSelect('dep-successor', successorId, setSuccessorId)}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-sm" htmlFor="dep-type">
              {copy.type}
              <select id="dep-type" className={FIELD_CLASS} value={type} onChange={(event) => setType(event.target.value as DependencyType)}>
                {TYPES.map((kind) => (
                  <option key={kind} value={kind}>
                    {`${t.flowSchedule.linkTypes[kind]} · ${t.flowSchedule.linkTypeNames[kind]}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm" htmlFor="dep-lag">
              {copy.lag}
              <input id="dep-lag" type="number" inputMode="numeric" className={FIELD_CLASS} value={lag} onChange={(event) => setLag(event.target.value)} />
            </label>
          </div>
          {(same || cycle) && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {same ? copy.same : copy.cycle}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {copy.cancel}
          </Button>
          <Button type="button" onClick={submit} disabled={!valid || create.isPending}>
            {copy.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
