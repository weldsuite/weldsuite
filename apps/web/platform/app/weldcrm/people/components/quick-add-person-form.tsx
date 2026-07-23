import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { useCreatePerson, type Person } from '@/hooks/queries/use-people-queries';
import { useTemplatePicker } from '@/app/settings/object-templates/use-template-picker';
import { TemplateFieldsRenderer } from '@/app/settings/object-templates/template-fields-renderer';
import { DialogFooter } from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';

/**
 * Create-a-Person form body — the `<form>` only, with no surrounding dialog.
 *
 * Rendered both by {@link QuickAddPersonDialog} (its own modal) and inline as a
 * second "page" of the list add-member picker (Attio-style back navigation).
 * Mount it fresh per use; it derives its initial values from `initialName` and
 * does not reset itself.
 */

const schema = z
  .object({
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    email: z.string().email().optional().or(z.literal('')),
    title: z.string().optional(),
    directPhone: z.string().optional(),
    mobilePhone: z.string().optional(),
    department: z.string().optional(),
    customFields: z.record(z.string()).optional(),
  })
  .passthrough()
  .refine((v) => !!(v.firstName || v.lastName || v.email), {
    message: 'Provide at least a first name, last name, or email',
    path: ['firstName'],
  });

type FormValues = z.infer<typeof schema>;

interface Props {
  /** Prefill the name fields (e.g. from a search term that found no match). */
  initialName?: string;
  /** Fired with the created record after a successful save. */
  onCreated?: (person: Person) => void;
  /** Fired when the user dismisses the form (Cancel). */
  onCancel: () => void;
}

export function QuickAddPersonForm({ initialName, onCreated, onCancel }: Props) {
  const t = useTranslations();
  const create = useCreatePerson();
  const picker = useTemplatePicker('person');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const trimmed = initialName?.trim() ?? '';
  const [firstPart, ...restParts] = trimmed.split(/\s+/);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      firstName: trimmed ? firstPart ?? '' : '',
      lastName: trimmed ? restParts.join(' ') : '',
      email: '',
      title: '',
      directPhone: '',
      customFields: {},
    },
  });

  const onSubmit = async (values: FormValues) => {
    setIsSubmitting(true);
    try {
      const payload = picker.buildPayload(values as Record<string, unknown>);
      const res = await create.mutateAsync(payload as Parameters<typeof create.mutateAsync>[0]);
      toast.success(t('crm.quickAddPerson.createdSuccess'));
      onCreated?.(res.data);
    } catch {
      // useCreatePerson already toasts on error
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <TemplateFieldsRenderer
        entityType="person"
        visibleSlugs={picker.visibleSlugs}
        customFieldBySlug={picker.customFieldBySlug}
        form={form}
        templateId={picker.templateId}
        setTemplateId={picker.setTemplateId}
        templates={picker.templates}
      />

      {form.formState.errors.firstName && (
        <p className="text-xs text-destructive">
          {form.formState.errors.firstName.message as string}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          {t('crm.quickAddPerson.cancelButton')}
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? t('crm.quickAddPerson.savingLabel') : t('crm.quickAddPerson.saveButton')}
        </Button>
      </DialogFooter>
    </form>
  );
}
