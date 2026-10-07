import { useState } from 'react';
import { toast } from 'sonner';
import { LayoutTemplate } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { usePermissions } from '@weldsuite/permissions/react';
import { useSaveWorkflowAsTemplate } from '@/hooks/queries/use-automation-queries';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { TemplateFormDialog, type TemplateFormValues } from '../../templates/components/template-form-dialog';

interface SaveAsTemplateButtonProps {
  workflowId: string;
  workflowName: string;
  workflowDescription: string;
}

/**
 * "Save as template": snapshots the workflow's saved trigger and steps into a
 * workspace template (POST /workflow-templates/from-workflow/:id). Hidden
 * without `workflow-templates:create`.
 */
export function SaveAsTemplateButton({ workflowId, workflowName, workflowDescription }: Readonly<SaveAsTemplateButtonProps>) {
  const { t } = useI18n();
  const tt = t.weldconnect.templates;
  const router = useRouter();
  const { canAny } = usePermissions();
  const saveAsTemplate = useSaveWorkflowAsTemplate();
  const [open, setOpen] = useState(false);

  if (!canAny('workflow-templates:create', 'weldconnect:workflow-templates:create')) return null;

  const handleSubmit = (values: TemplateFormValues) => {
    saveAsTemplate.mutate(
      { workflowId, ...values },
      {
        onSuccess: (result) => {
          setOpen(false);
          toast.success(tt.toasts.saved.replace('{name}', result.data.name), {
            action: { label: tt.toasts.viewTemplates, onClick: () => router.push('/weldconnect/templates') },
          });
        },
        onError: () => toast.error(tt.toasts.saveFailed),
      },
    );
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <LayoutTemplate className="h-3.5 w-3.5 mr-1.5" />
        {tt.saveAsTemplate.button}
      </Button>
      <TemplateFormDialog
        open={open}
        onOpenChange={setOpen}
        title={tt.saveAsTemplate.dialogTitle}
        description={tt.saveAsTemplate.dialogDescription}
        initialValues={{ name: workflowName, description: workflowDescription, category: 'custom' }}
        submitLabel={tt.saveAsTemplate.save}
        submittingLabel={tt.saveAsTemplate.saving}
        isSubmitting={saveAsTemplate.isPending}
        onSubmit={handleSubmit}
      />
    </>
  );
}
