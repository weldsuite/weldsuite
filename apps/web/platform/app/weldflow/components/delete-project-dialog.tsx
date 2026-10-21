import * as React from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button, buttonVariants } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { projectsApi, type ApiProject } from '../lib/api-client';

type TaskHandling = 'delete' | 'move';

interface DeleteProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: { id: string; name: string } | null;
  /** Called after the project is gone, with the project the tasks went to (if any). */
  onDeleted?: (projectId: string, movedTo: { id: string; name: string } | null) => void | Promise<void>;
}

/**
 * Confirms deleting a project, and lets the caller first move its tasks to
 * another project they can write to.
 */
export function DeleteProjectDialog({ open, onOpenChange, project, onDeleted }: Readonly<DeleteProjectDialogProps>) {
  const { t } = useI18n();
  const copy = t.projects.deleteProject;
  const [handling, setHandling] = React.useState<TaskHandling>('delete');
  const [targetId, setTargetId] = React.useState('');
  const [targets, setTargets] = React.useState<ApiProject[] | null>(null);
  const [pending, setPending] = React.useState(false);

  // Fresh choices every time the dialog opens, for whichever project it is.
  const projectId = project?.id;
  React.useEffect(() => {
    if (!open || !projectId) return;
    setHandling('delete');
    setTargetId('');
    setTargets(null);
    let cancelled = false;
    void projectsApi.list().then((result) => {
      if (cancelled) return;
      const rows = result.success ? (result.data ?? []) : [];
      setTargets(rows.filter((p) => p.id !== projectId && p.canWrite !== false));
    });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const moving = handling === 'move';
  const target = targets?.find((p) => p.id === targetId) ?? null;
  const canConfirm = !pending && !!project && (!moving || !!target);

  const handleConfirm = async () => {
    if (!project || !canConfirm) return;
    setPending(true);
    try {
      const result = await projectsApi.delete(project.id, moving && target ? { moveTasksTo: target.id } : undefined);
      if (!result.success) {
        toast.error(copy.failed, { description: result.error });
        return;
      }
      const movedTo = moving && target ? { id: target.id, name: target.name } : null;
      toast.success(movedTo ? copy.deletedAndMoved.replace('{name}', movedTo.name) : copy.deleted);
      onOpenChange(false);
      await onDeleted?.(project.id, movedTo);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={pending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description.replace('{name}', project?.name ?? '')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Label className="text-[13px]">{copy.tasksLabel}</Label>
          <RadioGroup
            value={handling}
            onValueChange={(value) => setHandling(value as TaskHandling)}
            disabled={pending}
            className="gap-2"
          >
            <Label className="flex items-center gap-2 font-normal cursor-pointer">
              <RadioGroupItem value="delete" />
              {copy.deleteTasks}
            </Label>
            <Label className="flex items-center gap-2 font-normal cursor-pointer">
              <RadioGroupItem value="move" />
              {copy.moveTasks}
            </Label>
          </RadioGroup>

          {moving && (
            <div className="space-y-2 pl-6">
              {targets === null ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : targets.length === 0 ? (
                <p className="text-sm text-muted-foreground">{copy.noOtherProjects}</p>
              ) : (
                <>
                  <Select value={targetId} onValueChange={setTargetId} disabled={pending}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={copy.targetPlaceholder} />
                    </SelectTrigger>
                    <SelectContent>
                      {targets.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{copy.moveHint}</p>
                </>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            {copy.cancel}
          </Button>
          <Button
            type="button"
            disabled={!canConfirm}
            onClick={handleConfirm}
            className={buttonVariants({ variant: 'destructive' })}
          >
            {pending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {moving ? copy.confirmAndMove : copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
