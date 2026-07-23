/**
 * MoveTaskDialog — move a WeldFlow task (and its subtasks) to another project.
 *
 * Self-contained: owns the project picker + the `useMoveTask` mutation so it
 * can be dropped into any surface (task list row menu, task detail panel)
 * without prop-drilling a handler. The destination project's sprint /
 * milestone / pipeline stage / key / board position are reset server-side.
 *
 * Gated behind the `weldflow-move-task` Flagship flag by the caller — this
 * component does not check the flag itself.
 */

import { useMemo, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@weldsuite/ui/components/command';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { useMoveTask } from '@/hooks/queries/use-task-queries';
import { useProjects } from '@/hooks/queries/use-projects-queries';

export interface MoveTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  /** Excluded from the picker so a task can't be "moved" onto itself. */
  currentProjectId?: string | null;
  onMoved?: (result: { id: string; projectId: string; movedSubtaskCount: number }) => void;
}

export function MoveTaskDialog({
  open,
  onOpenChange,
  taskId,
  currentProjectId,
  onMoved,
}: MoveTaskDialogProps) {
  const { t } = useI18n();
  const tt = t.projects.tasks;
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  // A page size of 100 covers the vast majority of workspaces; the
  // CommandInput filters the loaded list client-side.
  const { data, isLoading } = useProjects({ pageSize: 100 });
  const moveTask = useMoveTask();

  const projects = useMemo(
    () => (data?.data ?? []).filter((p: { id: string }) => p.id !== currentProjectId),
    [data, currentProjectId],
  );

  const close = (value: boolean) => {
    onOpenChange(value);
    if (!value) setSelectedProjectId(null);
  };

  const handleMove = async () => {
    if (!selectedProjectId) return;
    try {
      const result = await moveTask.mutateAsync({ id: taskId, projectId: selectedProjectId });
      const count = result?.movedSubtaskCount ?? 0;
      toast.success(
        count > 0
          ? `${tt.taskMoved} · ${tt.taskMovedWithSubtasks.replace('{count}', String(count))}`
          : tt.taskMoved,
      );
      onMoved?.(result);
      close(false);
    } catch {
      toast.error(tt.failedToMoveTask);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tt.moveTaskDialogTitle}</DialogTitle>
          <DialogDescription>{tt.moveTaskDialogDescription}</DialogDescription>
        </DialogHeader>

        <Command className="rounded-md border">
          <CommandInput placeholder={tt.moveTaskSearchPlaceholder} />
          <CommandList className="max-h-64">
            <CommandEmpty>{isLoading ? '…' : tt.moveTaskNoProjects}</CommandEmpty>
            <CommandGroup>
              {projects.map((p: { id: string; name?: string }) => (
                <CommandItem
                  key={p.id}
                  // Include the id so search still matches when names collide.
                  value={`${p.name ?? ''} ${p.id}`}
                  onSelect={() => setSelectedProjectId(p.id)}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="truncate">{p.name || p.id}</span>
                  {selectedProjectId === p.id && (
                    <Check className="h-4 w-4 shrink-0 text-primary" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={moveTask.isPending}>
            {t.common.cancel}
          </Button>
          <Button onClick={handleMove} disabled={!selectedProjectId || moveTask.isPending}>
            {moveTask.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {moveTask.isPending ? tt.moveTaskInProgress : tt.moveTaskConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
