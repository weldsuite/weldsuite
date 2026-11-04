/**
 * The two ways to put a task behind a risk or an issue: create a new
 * mitigation (resolution) task, or link one the project already has.
 */

import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@weldsuite/ui/components/command';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form } from '@weldsuite/ui/components/form';
import { RAID_TASK_PRIORITIES } from '@weldsuite/app-api-client/schemas/project-control';
import type { RaidItem } from '@weldsuite/app-api-client/domains/project-control';
import { useI18n } from '@/lib/i18n/provider';
import { useCreateControlLink, useCreateRaidTask } from '@/hooks/queries/use-project-control-queries';
import { useProjectTasks } from '@/hooks/queries/use-projects-queries';
import { buildRaidTaskBody, raidResolverOptions, raidTaskFormSchema, type RaidTaskFormValues } from '../_lib/form';
import { SelectField, TextAreaField, TextField } from './form-fields';
import { useRaid } from './raid-context';

// ── Create ──────────────────────────────────────────────────────────────────

interface CreateTaskDialogProps {
  /** The risk or issue the task is for; the dialog is open while this is set. */
  item: RaidItem | null;
  onClose: () => void;
}

export function CreateTaskDialog({ item, onClose }: Readonly<CreateTaskDialogProps>) {
  const { t, format } = useI18n();
  const copy = t.projects.raid.taskDialog;
  return (
    <Dialog open={item !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="flex max-h-[92vh] flex-col gap-0 p-0 sm:max-w-xl">
        {item ? (
          <>
            <DialogHeader className="border-b px-6 pt-6 pb-4 text-left">
              <DialogTitle>{item.kind === 'risk' ? copy.titleMitigation : copy.titleResolution}</DialogTitle>
              <DialogDescription>{format(copy.description, { code: item.code })}</DialogDescription>
            </DialogHeader>
            <CreateTaskForm key={item.id} item={item} onClose={onClose} />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateTaskForm({ item, onClose }: Readonly<{ item: RaidItem; onClose: () => void }>) {
  const { t, format } = useI18n();
  const copy = t.projects.raid;
  const { projectId, members } = useRaid();
  const createTask = useCreateRaidTask(projectId);
  const resolverOptions = useMemo(() => raidResolverOptions(copy.validation, format), [copy.validation, format]);

  const form = useForm<RaidTaskFormValues>({
    resolver: zodResolver(raidTaskFormSchema, resolverOptions),
    defaultValues: {
      title: format(item.kind === 'risk' ? copy.form.mitigationTaskTitle : copy.taskDialog.resolutionTaskTitle, { title: item.title }),
      description: '',
      assigneeId: item.ownerId,
      dueDate: '',
      priority: 'medium',
    },
  });

  const submit = async (values: RaidTaskFormValues) => {
    const body = buildRaidTaskBody(values);
    if (!body) {
      toast.error(copy.toasts.taskCreateFailed);
      return;
    }
    try {
      await createTask.mutateAsync({ id: item.id, data: body });
      toast.success(copy.toasts.taskCreated);
      onClose();
    } catch {
      toast.error(copy.toasts.taskCreateFailed);
    }
  };

  return (
    <Form {...form}>
      <form noValidate onSubmit={form.handleSubmit(submit)} className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <TextField control={form.control} name="title" label={copy.taskDialog.taskTitle} autoFocus />
          <TextAreaField control={form.control} name="description" label={copy.taskDialog.taskDescription} rows={3} />
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              control={form.control}
              name="assigneeId"
              label={copy.taskDialog.assignee}
              noneLabel={copy.taskDialog.noAssignee}
              options={members.map((member) => ({ value: member.userId, label: member.name }))}
            />
            <TextField control={form.control} name="dueDate" type="date" label={copy.taskDialog.dueDate} />
          </div>
          <SelectField
            control={form.control}
            name="priority"
            label={copy.taskDialog.priority}
            options={RAID_TASK_PRIORITIES.map((priority) => ({ value: priority, label: copy.taskDialog.priorities[priority] }))}
          />
        </div>
        <DialogFooter className="border-t px-6 py-3.5">
          <Button type="button" variant="outline" onClick={onClose} disabled={createTask.isPending}>
            {t.common.actions.cancel}
          </Button>
          <Button type="submit" disabled={createTask.isPending}>
            {createTask.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {copy.taskDialog.submit}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

// ── Link ────────────────────────────────────────────────────────────────────

interface LinkTaskDialogProps {
  item: RaidItem | null;
  /** Tasks already linked to the item, which the list leaves out. */
  linkedTaskIds: ReadonlySet<string>;
  onClose: () => void;
}

export function LinkTaskDialog({ item, linkedTaskIds, onClose }: Readonly<LinkTaskDialogProps>) {
  const { t, format } = useI18n();
  const copy = t.projects.raid.linkTask;
  return (
    <Dialog open={item !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        {item ? (
          <>
            <DialogHeader className="text-left">
              <DialogTitle>{copy.title}</DialogTitle>
              <DialogDescription>{format(copy.description, { code: item.code })}</DialogDescription>
            </DialogHeader>
            <LinkTaskList item={item} linkedTaskIds={linkedTaskIds} onClose={onClose} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {t.common.actions.cancel}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function LinkTaskList({ item, linkedTaskIds, onClose }: Readonly<{ item: RaidItem; linkedTaskIds: ReadonlySet<string>; onClose: () => void }>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  const { projectId } = useRaid();
  const tasks = useProjectTasks(projectId, { pageSize: 200 });
  const createLink = useCreateControlLink();
  let emptyText: string = copy.linkTask.empty;
  if (tasks.isLoading) emptyText = '…';
  else if (tasks.isError) emptyText = copy.linkTask.loadFailed;

  const candidates = useMemo(
    () => (tasks.data?.data ?? []).filter((task) => !linkedTaskIds.has(task.id) && task.status !== 'cancelled'),
    [tasks.data, linkedTaskIds],
  );

  const link = async (taskId: string) => {
    try {
      await createLink.mutateAsync({
        fromType: 'task',
        fromId: taskId,
        toType: 'raid_item',
        toId: item.id,
        relation: item.kind === 'risk' ? 'mitigates' : 'resolves',
      });
      toast.success(copy.toasts.taskLinked);
      onClose();
    } catch {
      toast.error(copy.toasts.linkFailed);
    }
  };

  return (
    <Command className="rounded-md border">
      <CommandInput placeholder={copy.linkTask.search} />
      <CommandList className="max-h-64">
        <CommandEmpty>{emptyText}</CommandEmpty>
        <CommandGroup>
          {candidates.map((task) => (
            <CommandItem
              key={task.id}
              // The id keeps search working when two tasks share a title.
              value={`${task.title} ${task.id}`}
              disabled={createLink.isPending}
              onSelect={() => void link(task.id)}
              className="flex items-center justify-between gap-2"
            >
              <span className="truncate">{task.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{task.status === 'done' ? copy.tasks.done : ''}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
