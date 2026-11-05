import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { updateTemplateSchema, type ProjectTemplate } from '@weldsuite/app-api-client/schemas/project-closing';
import { useI18n } from '@/lib/i18n/provider';
import { useUpdateTemplate } from '@/hooks/queries/use-project-closing-queries';
import { apiMessage } from '@/app/weldflow/project/[projectId]/close/_lib/api-error';
import { closingResolverOptions } from '@/app/weldflow/project/[projectId]/close/_lib/form';

const editFormSchema = z.object({
  name: updateTemplateSchema.shape.name.unwrap(),
  description: z.string().max(2_000),
  shared: z.boolean(),
});
type EditFormValues = z.infer<typeof editFormSchema>;

function EditForm({ template, onClose }: Readonly<{ template: ProjectTemplate; onClose: () => void }>) {
  const { t, format } = useI18n();
  const copy = t.flowClosing.templates.editDialog;
  const update = useUpdateTemplate();
  const options = useMemo(() => closingResolverOptions(t.flowClosing.shared.validation, format), [t, format]);
  const form = useForm<EditFormValues>({
    resolver: zodResolver(editFormSchema, options),
    defaultValues: { name: template.name, description: template.description ?? '', shared: template.shared },
  });

  const submit = async (values: EditFormValues) => {
    try {
      await update.mutateAsync({
        id: template.id,
        data: { name: values.name, description: values.description.trim() || null, shared: values.shared },
      });
      toast.success(copy.saved);
      onClose();
    } catch (error) {
      toast.error(apiMessage(error, copy.failed));
    }
  };

  return (
    <Form {...form}>
      <form noValidate onSubmit={form.handleSubmit(submit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{copy.name}</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{copy.descriptionLabel}</FormLabel>
              <FormControl>
                <Textarea {...field} rows={3} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="shared"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start justify-between gap-3 space-y-0 rounded-lg border p-3">
              <div className="space-y-0.5">
                <FormLabel>{copy.shared}</FormLabel>
                <FormDescription>{copy.sharedHint}</FormDescription>
              </div>
              <FormControl>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
            </FormItem>
          )}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={update.isPending}>
            {t.flowClosing.shared.cancel}
          </Button>
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {update.isPending ? t.flowClosing.shared.saving : copy.submit}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

/** Rename a template, change its description, share or unshare it. */
export function EditTemplateDialog({ template, onClose }: Readonly<{ template: ProjectTemplate | null; onClose: () => void }>) {
  const { t } = useI18n();
  return (
    <Dialog open={template !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.flowClosing.templates.editDialog.title}</DialogTitle>
        </DialogHeader>
        {template ? <EditForm key={template.id} template={template} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}
