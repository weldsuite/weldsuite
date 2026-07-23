import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { getTranslations } from '@/lib/i18n';
import {
  useCreateKnowledgeSpace,
  useUpdateKnowledgeSpace,
  type KnowledgeSpace,
  type KnowledgeSpaceVisibility,
} from '@/hooks/queries/use-knowledge-queries';

interface CreateSpaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the dialog edits this space instead of creating a new one. */
  space?: KnowledgeSpace | null;
}

export function CreateSpaceDialog({ open, onOpenChange, space }: CreateSpaceDialogProps) {
  const t = getTranslations('weldknow');
  const isEdit = !!space;
  const createSpace = useCreateKnowledgeSpace();
  const updateSpace = useUpdateKnowledgeSpace();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<KnowledgeSpaceVisibility>('workspace');

  useEffect(() => {
    if (open) {
      setName(space?.name ?? '');
      setDescription(space?.description ?? '');
      setVisibility(space?.visibility ?? 'workspace');
    }
  }, [open, space]);

  const isPending = createSpace.isPending || updateSpace.isPending;

  const handleSubmit = async () => {
    if (!name.trim()) return;
    try {
      if (isEdit && space) {
        await updateSpace.mutateAsync({
          id: space.id,
          data: { name: name.trim(), description: description.trim() || undefined, visibility },
        });
        toast.success(t.space.updateSuccess);
      } else {
        await createSpace.mutateAsync({
          name: name.trim(),
          description: description.trim() || undefined,
          visibility,
        });
        toast.success(t.space.createSuccess);
      }
      onOpenChange(false);
    } catch {
      toast.error(isEdit ? t.space.updateError : t.space.createError);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? t.space.editTitle : t.space.createTitle}</DialogTitle>
          <DialogDescription className="sr-only">{t.space.descriptionLabel}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="weldknow-space-name">{t.space.nameLabel}</Label>
            <Input
              id="weldknow-space-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.space.namePlaceholder}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="weldknow-space-description">{t.space.descriptionLabel}</Label>
            <Textarea
              id="weldknow-space-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t.space.descriptionPlaceholder}
              rows={3}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t.space.visibilityLabel}</Label>
            <Select value={visibility} onValueChange={(v) => setVisibility(v as KnowledgeSpaceVisibility)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="workspace">{t.space.visibilityWorkspace}</SelectItem>
                <SelectItem value="private">{t.space.visibilityPrivate}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {t.common.cancel}
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={isPending || !name.trim()}>
            {isEdit ? t.space.save : t.space.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
