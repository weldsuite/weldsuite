/**
 * "New project": name, type and optional allowed domains. A created project
 * opens on its Install tab, where the snippet is.
 */

import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form } from '@weldsuite/ui/components/form';
import { useCreateWeldPanelProject } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { buildProjectFormSchema, type ProjectFormValues } from '../lib/validation';
import { ProjectFields } from './project-fields';

const DEFAULTS: ProjectFormValues = { name: '', kind: 'website', allowedDomains: [] };

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateProjectDialog({ open, onOpenChange }: Readonly<CreateProjectDialogProps>) {
  const { t } = useI18n();
  const td = t.weldpanel.createDialog;
  const router = useRouter();
  const create = useCreateWeldPanelProject();
  const schema = useMemo(() => buildProjectFormSchema(t.weldpanel.validation), [t.weldpanel.validation]);
  const form = useForm<ProjectFormValues>({ resolver: zodResolver(schema), defaultValues: DEFAULTS });

  // Every opening starts from a blank form.
  useEffect(() => {
    if (open) form.reset(DEFAULTS);
  }, [open, form]);

  const submit = form.handleSubmit(async (values) => {
    try {
      const project = await create.mutateAsync(values);
      toast.success(td.created);
      onOpenChange(false);
      router.push(`/weldpanel/projects/${project.id}`);
    } catch {
      toast.error(td.createFailed);
    }
  });

  const submitting = create.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{td.title}</DialogTitle>
          <DialogDescription>{td.description}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} noValidate className="space-y-5">
            <ProjectFields form={form} namePlaceholder={td.namePlaceholder} domainsHint={td.domainsHint} domainsOptional disabled={submitting} />
            <DialogFooter>
              <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
                {td.cancel}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="animate-spin" />}
                {submitting ? td.creating : td.submit}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
