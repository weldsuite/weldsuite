import { useEffect, useState, type FormEvent } from 'react';
import { Globe, Lock, Users } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useCan } from '@weldsuite/permissions/react';
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
  /** When set, the dialog edits this teamspace instead of creating a new one. */
  space?: KnowledgeSpace | null;
}

export function CreateSpaceDialog({ open, onOpenChange, space }: Readonly<CreateSpaceDialogProps>) {
  const t = getTranslations('weldknow');
  const isEdit = !!space;
  const canManageAll = useCan('knowledge:manage');
  const createSpace = useCreateKnowledgeSpace();
  const updateSpace = useUpdateKnowledgeSpace();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<KnowledgeSpaceVisibility>('open');
  const [isDefault, setIsDefault] = useState(false);

  useEffect(() => {
    if (open) {
      setName(space?.name ?? '');
      setDescription(space?.description ?? '');
      setVisibility(space?.visibility ?? 'open');
      setIsDefault(space?.isDefault ?? false);
    }
  }, [open, space]);

  const isPending = createSpace.isPending || updateSpace.isPending;

  const visibilityOptions: { value: KnowledgeSpaceVisibility; label: string; hint: string; icon: typeof Globe }[] = [
    { value: 'open', label: t.space.visibilityOpen, hint: t.space.visibilityOpenHint, icon: Globe },
    { value: 'closed', label: t.space.visibilityClosed, hint: t.space.visibilityClosedHint, icon: Users },
    { value: 'private', label: t.space.visibilityPrivate, hint: t.space.visibilityPrivateHint, icon: Lock },
  ];

  const handleSubmit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!name.trim() || isPending) return;
    // Only workspace admins may touch the default flag; leave it out otherwise.
    const defaultField = canManageAll ? { isDefault } : {};
    try {
      if (isEdit && space) {
        await updateSpace.mutateAsync({
          id: space.id,
          data: { name: name.trim(), description: description.trim() || undefined, visibility, ...defaultField },
        });
        toast.success(t.space.updateSuccess);
      } else {
        await createSpace.mutateAsync({
          name: name.trim(),
          description: description.trim() || undefined,
          visibility,
          ...defaultField,
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
          <DialogDescription className="sr-only">
            {isEdit ? t.space.editDescription : t.space.createDescription}
          </DialogDescription>
        </DialogHeader>

        {/* A real form, so Enter in the name field creates the teamspace
            (native submit also waits for an IME to finish composing). */}
        <form id="weldknow-space-form" onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
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

          {/* One select instead of three option cards: the closed button shows
              the choice (icon and name), the open list explains each one. */}
          <div className="space-y-1.5">
            <Label htmlFor="weldknow-space-visibility">{t.space.visibilityLabel}</Label>
            <Select value={visibility} onValueChange={(v) => setVisibility(v as KnowledgeSpaceVisibility)}>
              <SelectTrigger id="weldknow-space-visibility" className="w-full">
                <SelectValue />
              </SelectTrigger>
              {/* As wide as the field, so the descriptions wrap inside the dialog. */}
              <SelectContent className="w-[var(--radix-select-trigger-width)]">
                {visibilityOptions.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    // Lined up under the name, past the 16px icon and 8px gap.
                    description={<span className="block pl-6">{option.hint}</span>}
                  >
                    <option.icon />
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {canManageAll && (
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="weldknow-space-default">{t.space.defaultLabel}</Label>
              <Switch id="weldknow-space-default" checked={isDefault} onCheckedChange={setIsDefault} />
            </div>
          )}
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {t.common.cancel}
          </Button>
          <Button type="submit" form="weldknow-space-form" disabled={isPending || !name.trim()}>
            {isEdit ? t.space.save : t.space.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
