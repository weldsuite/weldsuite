import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { getTranslations } from '@/lib/i18n';
import { DESK_PRIORITIES, type DeskPriority } from '@/hooks/queries/use-desk-queries';
import { useCreateDeskProblem, type DeskProblem } from '@/hooks/queries/use-desk-problem-queries';
import { deskLinkErrorMessage } from '@/hooks/queries/use-desk-link-queries';
import { PickOne } from '../inbox/ticket-fields';

/** The "New problem" dialog: a title, what is known so far and a priority. */
export function CreateProblemDialog({
  open,
  onOpenChange,
  onCreated,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; onCreated: (problem: DeskProblem) => void }>) {
  const t = getTranslations('deskProblems');
  const create = useCreateDeskProblem();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<DeskPriority | null>(null);

  const reset = () => {
    setTitle('');
    setDescription('');
    setPriority(null);
  };

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    create.mutate(
      { title: trimmed, description: description.trim() || null, priority },
      {
        onSuccess: (res) => {
          toast.success(t.create.created.replace('{number}', String(res.data.problem.problemNumber)));
          reset();
          onOpenChange(false);
          onCreated(res.data.problem);
        },
        onError: (err) => toast.error(deskLinkErrorMessage(err) ?? t.create.failed),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-lg" data-testid="desk-problem-create">
        <DialogHeader>
          <DialogTitle>{t.create.title}</DialogTitle>
          <DialogDescription>{t.create.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="desk-problem-title">{t.create.titleLabel}</Label>
            <Input
              id="desk-problem-title"
              value={title}
              maxLength={500}
              placeholder={t.create.titlePlaceholder}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit();
              }}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="desk-problem-description">{t.create.descriptionLabel}</Label>
            <Textarea
              id="desk-problem-description"
              value={description}
              maxLength={20_000}
              rows={4}
              placeholder={t.create.descriptionPlaceholder}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label>{t.create.priorityLabel}</Label>
            <PickOne
              value={priority}
              noneLabel={t.priority.none}
              items={DESK_PRIORITIES.map((value) => ({ value, label: t.priority[value] }))}
              onChange={(value) => setPriority(value as DeskPriority | null)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            {t.create.cancel}
          </Button>
          <Button onClick={submit} disabled={create.isPending || title.trim() === ''}>
            {t.create.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
