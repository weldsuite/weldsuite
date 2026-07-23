import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { useCreateCompany, type Company } from '@/hooks/queries/use-companies-queries';
import { useTemplatePicker } from '@/app/settings/object-templates/use-template-picker';
import { TemplateFieldsRenderer } from '@/app/settings/object-templates/template-fields-renderer';
import { DialogFooter } from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';

/**
 * Create-a-Company form body — the `<form>` only, with no surrounding dialog.
 *
 * Rendered both by {@link QuickAddCompanyDialog} (its own modal) and inline as a
 * second "page" of the list add-member picker (Attio-style back navigation).
 * Mount it fresh per use; it derives its initial values from `initialName` and
 * does not reset itself.
 */

const schema = z
  .object({
    name: z.string().min(1, 'Name is required').max(255),
    email: z.string().email().optional().or(z.literal('')),
    website: z.string().optional().or(z.literal('')),
    industry: z.string().optional().or(z.literal('')),
    tradingName: z.string().optional().or(z.literal('')),
    registrationNumber: z.string().optional().or(z.literal('')),
    vatNumber: z.string().optional().or(z.literal('')),
    phone: z.string().optional().or(z.literal('')),
    mobile: z.string().optional().or(z.literal('')),
    employeeCount: z.string().optional().or(z.literal('')),
    customFields: z.record(z.string()).optional(),
  })
  .passthrough();

type FormValues = z.infer<typeof schema>;

interface Props {
  /** Prefill the name field (e.g. from a search term that found no match). */
  initialName?: string;
  /** Fired with the created record after a successful save. */
  onCreated?: (company: Company) => void;
  /** Fired when the user dismisses the form (Cancel). */
  onCancel: () => void;
}

export function QuickAddCompanyForm({ initialName, onCreated, onCancel }: Props) {
  const t = useTranslations();
  const create = useCreateCompany();
  const picker = useTemplatePicker('company');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initialName?.trim() ?? '',
      email: '',
      website: '',
      industry: '',
      customFields: {},
    },
  });

  const onSubmit = async (values: FormValues) => {
    setIsSubmitting(true);
    try {
      const payload = picker.buildPayload(values as Record<string, unknown>);
      const res = await create.mutateAsync(payload as Parameters<typeof create.mutateAsync>[0]);
      toast.success(t('crm.quickAddCompany.createdSuccess'));
      onCreated?.(res.data);
    } catch {
      // useCreateCompany already toasts on error
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <TemplateFieldsRenderer
        entityType="company"
        visibleSlugs={picker.visibleSlugs}
        customFieldBySlug={picker.customFieldBySlug}
        form={form}
        templateId={picker.templateId}
        setTemplateId={picker.setTemplateId}
        templates={picker.templates}
      />

      {form.formState.errors.name && (
        <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          {t('crm.quickAddCompany.cancelButton')}
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? t('crm.quickAddCompany.savingLabel') : t('crm.quickAddCompany.saveButton')}
        </Button>
      </DialogFooter>
    </form>
  );
}
