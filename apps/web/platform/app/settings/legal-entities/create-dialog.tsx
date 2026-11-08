import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import type { LegalEntity } from '@weldsuite/app-api-client/schemas/legal-entities';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { CountrySelect } from '@/components/settings/country-select';
import { useCreateLegalEntity } from '@/hooks/queries/use-legal-entities-queries';
import { currencyOptions } from '@/lib/weldbooks/currencies';
import { entityTypesFor } from '@/lib/weldbooks/entity-types';
import { useI18n } from '@/lib/i18n/provider';
import { defaultCurrencyForCountry } from './currency';
import { useLegalFormLabel } from './legal-forms';

const NO_LEGAL_FORM = '__none__';

const formSchema = z.object({
  name: z.string().trim().min(1),
  legalName: z.string(),
  dba: z.string(),
  entityType: z.string(),
  jurisdictionCode: z.string().min(1),
  baseCurrency: z.string().min(1),
});
type FormValues = z.infer<typeof formSchema>;

const EMPTY: FormValues = {
  name: '',
  legalName: '',
  dba: '',
  entityType: NO_LEGAL_FORM,
  jurisdictionCode: '',
  baseCurrency: 'EUR',
};

interface CreateLegalEntityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** No entity exists yet, so this one becomes the default. */
  isFirst: boolean;
  onCreated: (entity: LegalEntity) => void;
}

export function CreateLegalEntityDialog({ open, onOpenChange, isFirst, onCreated }: Readonly<CreateLegalEntityDialogProps>) {
  const { t } = useI18n();
  const tc = t.settings.legalEntities.create;
  const create = useCreateLegalEntity();
  const legalFormLabel = useLegalFormLabel();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: EMPTY });

  useEffect(() => {
    if (open) {
      setSubmitError(null);
      form.reset(EMPTY);
    }
  }, [open, form]);

  const country = form.watch('jurisdictionCode');

  async function onSubmit(values: FormValues) {
    form.clearErrors();
    try {
      const entity = await create.mutateAsync({
        name: values.name.trim(),
        legalName: values.legalName.trim() || null,
        dba: values.dba.trim() || null,
        entityType: values.entityType === NO_LEGAL_FORM ? null : values.entityType,
        jurisdictionCode: values.jurisdictionCode,
        baseCurrency: values.baseCurrency,
      });
      toast.success(tc.success);
      onOpenChange(false);
      onCreated(entity);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : tc.failed);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tc.title}</DialogTitle>
          <DialogDescription>{tc.description}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit, (errors) => {
              if (errors.name) form.setError('name', { message: tc.nameRequired });
              if (errors.jurisdictionCode) form.setError('jurisdictionCode', { message: tc.countryRequired });
              if (errors.baseCurrency) form.setError('baseCurrency', { message: tc.currencyRequired });
            })}
            className="space-y-4"
          >
            <ErrorBanner error={submitError} onDismiss={() => setSubmitError(null)} />
            {isFirst && <InfoBanner variant="info">{tc.firstEntityNote}</InfoBanner>}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tc.name}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={tc.namePlaceholder} autoFocus />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="legalName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tc.legalName}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="dba"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tc.tradingName}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="jurisdictionCode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tc.country}</FormLabel>
                  <FormControl>
                    <CountrySelect
                      value={field.value}
                      onChange={(code) => {
                        field.onChange(code);
                        // The legal form list follows the country, and so does the usual currency.
                        form.setValue('entityType', NO_LEGAL_FORM);
                        if (!form.formState.dirtyFields.baseCurrency) {
                          form.setValue('baseCurrency', defaultCurrencyForCountry(code));
                        }
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="entityType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tc.legalForm}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={NO_LEGAL_FORM}>{tc.noLegalForm}</SelectItem>
                        {entityTypesFor(country).map((code) => (
                          <SelectItem key={code} value={code}>
                            {legalFormLabel(code)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="baseCurrency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tc.currency}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {currencyOptions(field.value).map((code) => (
                          <SelectItem key={code} value={code}>
                            {code}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t.common.actions.cancel}
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {tc.submit}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
