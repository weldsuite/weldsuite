/** Add a single prospect, or edit one: contact details, timezone and custom fields. */

import { useMemo, useState } from 'react';
import { useFieldArray, useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { z } from 'zod';
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
import { useTranslations } from '@weldsuite/i18n/client';
import {
  reachProspectInputSchema,
  type ReachProspect,
  type UpdateReachProspectInput,
} from '@weldsuite/app-api-client/schemas/reach';
import {
  useCreateReachProspect,
  useUpdateReachProspect,
} from '@/hooks/queries/use-reach-prospect-queries';
import { TIMEZONES } from '@/lib/timezones';
import { ErrorBanner, Notice, errorMessage } from '@/app/weldreach/components/engage/kit';
import { CUSTOM_FIELDS_MAX } from '../lib/import-mapping';

const NO_TIMEZONE = '__none__';

// The contract's prospect fields, with custom fields as editable key/value rows.
const formSchema = reachProspectInputSchema.omit({ customFields: true }).extend({
  customFields: z
    .array(
      z.object({
        key: z
          .string()
          .trim()
          .max(64)
          // A template can only use a key made of these characters (`{{key}}`).
          .regex(/^[a-zA-Z0-9_.-]*$/),
        value: z.string().max(2000),
      }),
    )
    .max(CUSTOM_FIELDS_MAX),
});
type ProspectFormValues = z.infer<typeof formSchema>;

function toFormValues(prospect: ReachProspect | undefined): ProspectFormValues {
  return {
    email: prospect?.email ?? '',
    firstName: prospect?.firstName ?? '',
    lastName: prospect?.lastName ?? '',
    companyName: prospect?.companyName ?? '',
    title: prospect?.title ?? '',
    timezone: prospect?.timezone ?? '',
    customFields: Object.entries(prospect?.customFields ?? {}).map(([key, value]) => ({ key, value })),
  };
}

export function ProspectDialog({
  prospect,
  listId,
  onClose,
}: Readonly<{
  /** The prospect to edit; omit to add a new one. */
  prospect?: ReachProspect;
  /** A list to add a new prospect to. */
  listId?: string;
  onClose: () => void;
}>) {
  const t = useTranslations();
  const isEdit = prospect !== undefined;
  const create = useCreateReachProspect();
  const update = useUpdateReachProspect();
  const [failure, setFailure] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;

  const form = useForm<ProspectFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: toFormValues(prospect),
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'customFields' });
  const { errors } = form.formState;

  const timezones = useMemo(() => {
    const current = prospect?.timezone;
    if (!current || TIMEZONES.some((zone) => zone.id === current)) return TIMEZONES;
    // A zone the prospect already has must stay selectable even if the list lacks it.
    return [{ id: current, label: current }, ...TIMEZONES];
  }, [prospect?.timezone]);

  const submit = form.handleSubmit(async (values) => {
    setFailure(null);
    const customFields = Object.fromEntries(
      values.customFields
        .filter((field) => field.key.trim() !== '')
        .map((field) => [field.key.trim(), field.value]),
    );
    try {
      if (prospect) {
        const changes: UpdateReachProspectInput = {
          firstName: values.firstName ?? '',
          lastName: values.lastName ?? '',
          companyName: values.companyName ?? '',
          title: values.title ?? '',
          timezone: values.timezone ?? '',
          customFields,
        };
        await update.mutateAsync({ id: prospect.id, changes });
      } else {
        await create.mutateAsync({
          email: values.email,
          firstName: values.firstName || undefined,
          lastName: values.lastName || undefined,
          companyName: values.companyName || undefined,
          title: values.title || undefined,
          timezone: values.timezone || undefined,
          customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
          listId,
        });
      }
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('reachEngage.prospects.dialog.failed')));
    }
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('reachEngage.prospects.dialog.editTitle') : t('reachEngage.prospects.dialog.addTitle')}
          </DialogTitle>
          <DialogDescription>{t('reachEngage.prospects.dialog.description')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

          <div className="space-y-1.5">
            <Label htmlFor="reach-prospect-email">{t('reachEngage.prospects.dialog.email')}</Label>
            <Input
              id="reach-prospect-email"
              type="email"
              autoComplete="off"
              readOnly={isEdit}
              className={isEdit ? 'bg-muted/50' : undefined}
              placeholder="ana@acme.com"
              aria-invalid={Boolean(errors.email)}
              {...form.register('email')}
            />
            {errors.email && (
              <p className="text-xs text-destructive">{t('reachEngage.prospects.dialog.emailInvalid')}</p>
            )}
            {!isEdit && (
              <p className="text-xs text-muted-foreground">{t('reachEngage.prospects.dialog.emailHint')}</p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="reach-prospect-first-name">{t('reachEngage.prospects.dialog.firstName')}</Label>
              <Input id="reach-prospect-first-name" autoComplete="off" {...form.register('firstName')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reach-prospect-last-name">{t('reachEngage.prospects.dialog.lastName')}</Label>
              <Input id="reach-prospect-last-name" autoComplete="off" {...form.register('lastName')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reach-prospect-company">{t('reachEngage.prospects.dialog.companyName')}</Label>
              <Input id="reach-prospect-company" autoComplete="off" {...form.register('companyName')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reach-prospect-title">{t('reachEngage.prospects.dialog.title')}</Label>
              <Input id="reach-prospect-title" autoComplete="off" {...form.register('title')} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label id="reach-prospect-timezone-label">{t('reachEngage.prospects.dialog.timezone')}</Label>
            <Controller
              control={form.control}
              name="timezone"
              render={({ field }) => (
                <Select
                  value={field.value ? field.value : NO_TIMEZONE}
                  onValueChange={(value) => field.onChange(value === NO_TIMEZONE ? '' : value)}
                >
                  <SelectTrigger aria-labelledby="reach-prospect-timezone-label" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value={NO_TIMEZONE}>{t('reachEngage.prospects.dialog.noTimezone')}</SelectItem>
                    {timezones.map((zone) => (
                      <SelectItem key={zone.id} value={zone.id}>
                        {zone.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>{t('reachEngage.prospects.dialog.customFields')}</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={fields.length >= CUSTOM_FIELDS_MAX}
                onClick={() => append({ key: '', value: '' })}
              >
                <Plus className="mr-1 h-4 w-4" />
                {t('reachEngage.prospects.dialog.addCustomField')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('reachEngage.prospects.dialog.customFieldsHint', { example: '{{key}}' })}
            </p>
            {fields.map((field, index) => (
              <div key={field.id} className="flex items-start gap-2">
                <Input
                  autoComplete="off"
                  placeholder={t('reachEngage.prospects.dialog.customKey')}
                  aria-label={t('reachEngage.prospects.dialog.customKey')}
                  aria-invalid={Boolean(errors.customFields?.[index]?.key)}
                  className="w-2/5 font-mono text-xs"
                  {...form.register(`customFields.${index}.key`)}
                />
                <Input
                  autoComplete="off"
                  placeholder={t('reachEngage.prospects.dialog.customValue')}
                  aria-label={t('reachEngage.prospects.dialog.customValue')}
                  className="flex-1"
                  {...form.register(`customFields.${index}.value`)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 text-muted-foreground"
                  onClick={() => remove(index)}
                  aria-label={t('reachEngage.common.remove')}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {errors.customFields && (
              <Notice tone="warning">{t('reachEngage.prospects.dialog.customKeyInvalid')}</Notice>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {t('reachEngage.common.cancel')}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isEdit ? t('reachEngage.common.save') : t('reachEngage.prospects.dialog.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
