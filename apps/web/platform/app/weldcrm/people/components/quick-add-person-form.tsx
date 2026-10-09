import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { useTranslations } from '@weldsuite/i18n/client';
import { useObjectPanel } from '@/components/object-panel/use-object-panel';
import { useCreatePerson, type Person } from '@/hooks/queries/use-people-queries';
import { useTemplatePicker } from '@/app/settings/object-templates/use-template-picker';
import { TemplateFieldsRenderer } from '@/app/settings/object-templates/template-fields-renderer';
import { DialogFooter } from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { personSeedFromQuery } from '@/app/weldcrm/people/lib/person-seed';

/**
 * Create-a-Person form body — the `<form>` only, with no surrounding dialog.
 *
 * Rendered both by {@link QuickAddPersonDialog} (its own modal) and inline as a
 * second "page" of the list add-member picker (Attio-style back navigation).
 * Mount it fresh per use; it derives its initial values from `initialName`
 * (a name, an email, or "Name <email>") and does not reset itself.
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
    customFields: z.record(z.unknown()).optional(),
  })
  .passthrough()
  .refine((v) => !!(v.firstName || v.lastName || v.email), {
    message: 'Provide at least a first name, last name, or email',
    path: ['firstName'],
  });

type FormValues = z.infer<typeof schema>;

/** Id of the CRM person that already owns the email, from a `POST /people` 409 (`details.existingPersonId`). */
function existingPersonIdFromConflict(err: unknown): string | null {
  if (!isApiError(err) || err.status !== 409) return null;
  const details = (err.body as { error?: { details?: { existingPersonId?: unknown } } } | undefined)?.error?.details;
  return typeof details?.existingPersonId === 'string' ? details.existingPersonId : null;
}

interface Props {
  /**
   * Prefill from a people-search query. An email fills the email field, a
   * name fills first/last name, and "Name <email>" fills both.
   */
  initialName?: string;
  /** Fired with the created record after a successful save. */
  onCreated?: (person: Person) => void;
  /** Fired when the user dismisses the form (Cancel). */
  onCancel: () => void;
}

export function QuickAddPersonForm({ initialName, onCreated, onCancel }: Readonly<Props>) {
  const t = useTranslations();
  const create = useCreatePerson();
  const picker = useTemplatePicker('person');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Set when the email already belongs to another CRM person (409): the form
  // then offers to open that record instead of only toasting an error.
  const [duplicatePersonId, setDuplicatePersonId] = useState<string | null>(null);
  const { open: openPanel } = useObjectPanel();

  const seed = personSeedFromQuery(initialName ?? '');

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      firstName: seed.firstName,
      lastName: seed.lastName,
      email: seed.email,
      title: '',
      directPhone: '',
      mobilePhone: '',
      department: '',
      customFields: {},
    },
  });

  const onSubmit = async (values: FormValues) => {
    setIsSubmitting(true);
    setDuplicatePersonId(null);
    try {
      const payload = picker.buildPayload(values as Record<string, unknown>);
      const res = await create.mutateAsync(payload as Parameters<typeof create.mutateAsync>[0]);
      toast.success(t('crm.quickAddPerson.createdSuccess'));
      onCreated?.(res.data);
    } catch (err) {
      // useCreatePerson already toasts on error; a duplicate additionally gets
      // an "Open existing person" action below the form.
      setDuplicatePersonId(existingPersonIdFromConflict(err));
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
          {form.formState.errors.firstName.type === 'custom'
            ? t('crm.quickAddPerson.validationAtLeastOne')
            : form.formState.errors.firstName.type === 'too_big'
              ? t('crm.quickAddPerson.fieldTooLong', { field: t('crm.quickAddPerson.fieldFirstName'), max: 100 })
              : (form.formState.errors.firstName.message as string)}
        </p>
      )}
      {form.formState.errors.lastName?.type === 'too_big' && (
        <p className="text-xs text-destructive">
          {t('crm.quickAddPerson.fieldTooLong', { field: t('crm.quickAddPerson.fieldLastName'), max: 100 })}
        </p>
      )}

      {duplicatePersonId && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
        >
          <span className="text-destructive">{t('crm.quickAddPerson.duplicateEmail')}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              openPanel({ type: 'person', id: duplicatePersonId });
              onCancel();
            }}
          >
            {t('crm.quickAddPerson.openExistingPerson')}
          </Button>
        </div>
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
