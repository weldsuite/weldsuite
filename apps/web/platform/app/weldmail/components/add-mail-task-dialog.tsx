import { useState } from 'react';
import { useUser } from '@/lib/auth';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useCreateTask } from '@/hooks/queries/use-task-queries';
import { useProjects } from '@/hooks/queries/use-projects-queries';
import { useI18n } from '@/lib/i18n/provider';

/** What "Add to Tasks" starts from: the mail's subject and a description that links back to it. */
export interface MailTaskDraft {
  title: string;
  description: string;
}

const NO_PROJECT = 'none';

function AddMailTaskForm({ draft, onClose }: Readonly<{ draft: MailTaskDraft; onClose: () => void }>) {
  const { t } = useI18n();
  const { user } = useUser();
  const createTask = useCreateTask();
  const { data: projectsData, isLoading: projectsLoading } = useProjects({ pageSize: 100, isActive: true });
  const [title, setTitle] = useState(draft.title);
  const [projectId, setProjectId] = useState(NO_PROJECT);
  const projects = projectsData?.data ?? [];

  const create = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    createTask.mutate(
      {
        title: trimmed,
        description: draft.description,
        tags: ['mail'],
        assigneeId: user?.id,
        projectId: projectId === NO_PROJECT ? undefined : projectId,
      },
      {
        onSuccess: () => {
          toast.success(t.mail.messageList.taskCreated);
          onClose();
        },
        onError: () => toast.error(t.mail.messageList.failedToCreateTask),
      },
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t.mail.messageList.addTaskTitle}</DialogTitle>
        <DialogDescription>{t.mail.messageList.addTaskDescription}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div className="space-y-2">
          <Label htmlFor="mail-task-title">{t.mail.messageList.taskTitleLabel}</Label>
          <Input
            id="mail-task-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !createTask.isPending) create();
            }}
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="mail-task-project">{t.mail.messageList.taskProjectLabel}</Label>
          <Select value={projectId} onValueChange={setProjectId} disabled={projectsLoading}>
            <SelectTrigger id="mail-task-project" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PROJECT}>{t.mail.messageList.taskNoProject}</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={createTask.isPending}>
          {t.common.actions.cancel}
        </Button>
        <Button onClick={create} disabled={createTask.isPending || !title.trim()}>
          {t.mail.messageList.taskCreateButton}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * "Add to Tasks" for a mail row: a task titled after the mail, assigned to the
 * current user, in a project when one is picked, with a link back to the mail.
 */
export function AddMailTaskDialog({ draft, onClose }: Readonly<{ draft: MailTaskDraft | null; onClose: () => void }>) {
  return (
    <Dialog open={draft !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>{draft && <AddMailTaskForm draft={draft} onClose={onClose} />}</DialogContent>
    </Dialog>
  );
}
