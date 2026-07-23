import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
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
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  useCreateCannedResponse,
  useUpdateCannedResponse,
} from '@/hooks/queries/use-helpdesk-queries';

const savedReplySchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  content: z.string().min(1, 'Content is required'),
  subject: z.string().max(500).optional(),
  category: z.string().max(100).optional(),
  scope: z.enum(['personal', 'team', 'department', 'global']).default('personal'),
  shortcut: z.string().max(50).optional(),
});

type SavedReplyFormData = z.infer<typeof savedReplySchema>;

interface SavedReplyEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingItem: {
    id: string;
    name: string;
    content: string;
    category: string | null;
    scope: string;
    shortcut: string | null;
  } | null;
}

export function SavedReplyEditor({ open, onOpenChange, editingItem }: SavedReplyEditorProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const sre = t.helpdesk.savedReplyEditor;
  const createMutation = useCreateCannedResponse();
  const updateMutation = useUpdateCannedResponse();
  const isEditing = !!editingItem;

  const form = useForm<SavedReplyFormData>({
    resolver: zodResolver(savedReplySchema),
    defaultValues: {
      name: '',
      content: '',
      subject: '',
      category: '',
      scope: 'personal',
      shortcut: '',
    },
  });

  useEffect(() => {
    if (open) {
      if (editingItem) {
        form.reset({
          name: editingItem.name,
          content: editingItem.content,
          category: editingItem.category || '',
          scope: (editingItem.scope as SavedReplyFormData['scope']) || 'personal',
          shortcut: editingItem.shortcut || '',
        });
      } else {
        form.reset({
          name: '',
          content: '',
          subject: '',
          category: '',
          scope: 'personal',
          shortcut: '',
        });
      }
    }
  }, [open, editingItem, form]);

  const onSubmit = async (data: SavedReplyFormData) => {
    try {
      if (isEditing) {
        await updateMutation.mutateAsync({
          id: editingItem.id,
          name: data.name,
          content: data.content,
          subject: data.subject || undefined,
          category: data.category || undefined,
          scope: data.scope,
          shortcut: data.shortcut || undefined,
        });
        toast.success(t.helpdesk.ticketTypesSettings.savedReplyUpdated);
      } else {
        await createMutation.mutateAsync({
          name: data.name,
          content: data.content,
          subject: data.subject || undefined,
          category: data.category || undefined,
          scope: data.scope,
          shortcut: data.shortcut || undefined,
        });
        toast.success(t.helpdesk.ticketTypesSettings.savedReplyCreated);
      }
      onOpenChange(false);
    } catch {
      toast.error(isEditing ? t.helpdesk.ticketTypesSettings.failedToUpdateSavedReply : t.helpdesk.ticketTypesSettings.failedToDeleteSavedReply);
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? sre.editTitle : sre.createTitle}</DialogTitle>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">{sre.nameLabel}</Label>
            <Input
              id="name"
              placeholder={sre.namePlaceholder}
              {...form.register('name')}
            />
            {form.formState.errors.name && (
              <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="content">{sre.contentLabel}</Label>
            <Textarea
              id="content"
              placeholder={sre.contentPlaceholder}
              rows={6}
              {...form.register('content')}
            />
            {form.formState.errors.content && (
              <p className="text-sm text-destructive">{form.formState.errors.content.message}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {sre.availableVars} {'{{customer.name}}'}, {'{{customer.email}}'}, {'{{agent.name}}'}, {'{{conversation.id}}'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="scope">{sre.scopeLabel}</Label>
              <Select
                value={form.watch('scope')}
                onValueChange={(value) => form.setValue('scope', value as SavedReplyFormData['scope'])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">{sre.personal}</SelectItem>
                  <SelectItem value="team">{sre.team}</SelectItem>
                  <SelectItem value="department">{sre.department}</SelectItem>
                  <SelectItem value="global">{sre.global}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="category">{sre.categoryLabel}</Label>
              <Input
                id="category"
                placeholder={sre.categoryPlaceholder}
                {...form.register('category')}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="shortcut">{sre.shortcutLabel}</Label>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">/</span>
              <Input
                id="shortcut"
                placeholder={st('sweep.welddesk.savedReplyEditor.shortcutPlaceholder')}
                {...form.register('shortcut')}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {sre.shortcutDesc.replace('{shortcut}', form.watch('shortcut') || 'shortcut')}
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {sre.cancel}
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  {isEditing ? sre.updating : sre.creating}
                </>
              ) : (
                isEditing ? sre.update : sre.create
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
