import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { templateFromProjectSchema, type ProjectTemplateDetail } from '@weldsuite/app-api-client/schemas/project-closing';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useProjects } from '@/hooks/queries/use-projects-queries';
import { useSaveProjectAsTemplate } from '@/hooks/queries/use-project-closing-queries';
import { apiMessage } from '@/app/weldflow/project/[projectId]/close/_lib/api-error';
import { closingResolverOptions } from '@/app/weldflow/project/[projectId]/close/_lib/form';

const shape = templateFromProjectSchema.shape;

const saveFormSchema = z.object({
  projectId: z.string().min(1),
  name: shape.name,
  description: z.string().max(2_000),
  shared: z.boolean(),
});
type SaveFormValues = z.infer<typeof saveFormSchema>;

interface SaveTemplateDialogProps {
  open: boolean;
  onClose: () => void;
  /** Fixed project (the close page); without it the dialog offers a project picker. */
  projectId?: string;
  /** The name to start with (the project's name). */
  defaultName?: string;
  onSaved?: (template: ProjectTemplateDetail) => void;
}

function SaveForm({ projectId, defaultName, onClose, onSaved }: Readonly<Omit<SaveTemplateDialogProps, 'open'>>) {
  const { t, format } = useI18n();
  const copy = t.flowClosing.templates.saveDialog;
  const router = useRouter();
  const save = useSaveProjectAsTemplate();
  const projects = useProjects({ pageSize: 100 });
  const options = useMemo(() => closingResolverOptions(t.flowClosing.shared.validation, format), [t, format]);
  const form = useForm<SaveFormValues>({
    resolver: zodResolver(saveFormSchema, options),
    defaultValues: { projectId: projectId ?? '', name: defaultName ?? '', description: '', shared: false },
  });

  const submit = async (values: SaveFormValues) => {
    try {
      const res = await save.mutateAsync({
        projectId: values.projectId,
        data: { name: values.name, description: values.description.trim() || null, shared: values.shared },
      });
      toast.success(format(copy.saved, { name: res.data.name }), {
        action: { label: copy.openTemplates, onClick: () => router.push('/weldflow/templates') },
      });
      onSaved?.(res.data);
      onClose();
    } catch (error) {
      toast.error(apiMessage(error, copy.failed));
    }
  };

  return (
    <Form {...form}>
      <form noValidate onSubmit={form.handleSubmit(submit)} className="space-y-4">
        {projectId ? null : (
          <FormField
            control={form.control}
            name="projectId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{copy.project}</FormLabel>
                {projects.isError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {copy.projectsFailed}
                  </p>
                ) : (
                  <Select
                    value={field.value}
                    onValueChange={(id) => {
                      field.onChange(id);
                      const picked = projects.data?.data.find((project) => project.id === id);
                      if (picked && !form.getFieldState('name').isDirty) form.setValue('name', picked.name);
                    }}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={copy.projectPlaceholder} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(projects.data?.data ?? []).map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {form.formState.errors.projectId ? <p className="text-sm text-destructive">{copy.projectRequired}</p> : null}
              </FormItem>
            )}
          />
        )}
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
                <Textarea {...field} rows={3} placeholder={copy.descriptionPlaceholder} />
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
          <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
            {t.flowClosing.shared.cancel}
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {save.isPending ? t.flowClosing.shared.saving : copy.submit}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

/** "Save as template": one project becomes a template. */
export function SaveTemplateDialog({ open, onClose, projectId, defaultName, onSaved }: Readonly<SaveTemplateDialogProps>) {
  const { t } = useI18n();
  const copy = t.flowClosing.templates.saveDialog;
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        {open ? <SaveForm projectId={projectId} defaultName={defaultName} onClose={onClose} onSaved={onSaved} /> : null}
      </DialogContent>
    </Dialog>
  );
}
