import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import type { LegalEntity, UpdateLegalEntityInput } from '@weldsuite/app-api-client/schemas/legal-entities';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { CountrySelect } from '@/components/settings/country-select';
import { useUpdateLegalEntity } from '@/hooks/queries/use-legal-entities-queries';
import { currencyOptions } from '@/lib/weldbooks/currencies';
import { entityTypesFor } from '@/lib/weldbooks/entity-types';
import { useI18n } from '@/lib/i18n/provider';
import { useLegalFormLabel } from './legal-forms';

const NONE = '__none__';

const formSchema = z.object({
  name: z.string(),
  legalName: z.string(),
  dba: z.string(),
  entityType: z.string(),
  jurisdictionCode: z.string(),
  baseCurrency: z.string(),
  fiscalYearStart: z.string(),
  street: z.string(),
  houseNumber: z.string(),
  houseNumberAddition: z.string(),
  line2: z.string(),
  postalCode: z.string(),
  city: z.string(),
  state: z.string(),
  addressCountry: z.string(),
  email: z.string(),
  phone: z.string(),
  website: z.string(),
  contactFirstName: z.string(),
  contactLastName: z.string(),
  logoUrl: z.string(),
  primaryColor: z.string(),
  accentColor: z.string(),
});
type FormValues = z.infer<typeof formSchema>;

function toFormValues(entity: LegalEntity): FormValues {
  return {
    name: entity.name,
    legalName: entity.legalName ?? '',
    dba: entity.dba ?? '',
    entityType: entity.entityType ?? NONE,
    jurisdictionCode: entity.jurisdictionCode,
    baseCurrency: entity.baseCurrency,
    fiscalYearStart: entity.fiscalYearStart ? String(entity.fiscalYearStart) : NONE,
    street: entity.address?.line1 ?? '',
    houseNumber: entity.address?.houseNumber ?? '',
    houseNumberAddition: entity.address?.houseNumberAddition ?? '',
    line2: entity.address?.line2 ?? '',
    postalCode: entity.address?.postalCode ?? '',
    city: entity.address?.city ?? '',
    state: entity.address?.state ?? '',
    addressCountry: entity.address?.country ?? '',
    email: entity.contact?.email ?? '',
    phone: entity.contact?.phone ?? '',
    website: entity.contact?.website ?? '',
    contactFirstName: entity.contact?.contactPerson?.firstName ?? '',
    contactLastName: entity.contact?.contactPerson?.lastName ?? '',
    logoUrl: entity.branding?.logoUrl ?? '',
    primaryColor: entity.branding?.primaryColor ?? '',
    accentColor: entity.branding?.accentColor ?? '',
  };
}

/** Keep only the filled fields; null when nothing is left. */
function compact<T extends Record<string, string | undefined>>(fields: T): { [K in keyof T]?: string } | null {
  const result: { [K in keyof T]?: string } = {};
  let any = false;
  for (const key of Object.keys(fields) as Array<keyof T>) {
    const value = fields[key]?.trim();
    if (value) {
      result[key] = value;
      any = true;
    }
  }
  return any ? result : null;
}

/** The form's values as the API's update body. */
export function toUpdateInput(values: FormValues): UpdateLegalEntityInput {
  const address = compact({
    line1: values.street,
    line2: values.line2,
    houseNumber: values.houseNumber,
    houseNumberAddition: values.houseNumberAddition,
    city: values.city,
    state: values.state,
    postalCode: values.postalCode,
    country: values.addressCountry,
  });
  const person = compact({ firstName: values.contactFirstName, lastName: values.contactLastName });
  const contactFields = compact({ email: values.email, phone: values.phone, website: values.website });
  const contact = contactFields || person ? { ...contactFields, ...(person ? { contactPerson: person } : {}) } : null;
  return {
    name: values.name.trim(),
    legalName: values.legalName.trim() || null,
    dba: values.dba.trim() || null,
    entityType: values.entityType === NONE ? null : values.entityType,
    jurisdictionCode: values.jurisdictionCode,
    baseCurrency: values.baseCurrency,
    fiscalYearStart: values.fiscalYearStart === NONE ? undefined : Number(values.fiscalYearStart),
    address,
    contact,
    branding: compact({ logoUrl: values.logoUrl, primaryColor: values.primaryColor, accentColor: values.accentColor }),
  };
}

interface GeneralTabProps {
  entity: LegalEntity;
  canEdit: boolean;
}

export function GeneralTab({ entity, canEdit }: Readonly<GeneralTabProps>) {
  const { t, language } = useI18n();
  const tg = t.settings.legalEntities.general;
  const update = useUpdateLegalEntity();
  const legalFormLabel = useLegalFormLabel();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: toFormValues(entity) });

  // A save (or another tab's change) refreshes the entity: show what the server holds.
  useEffect(() => {
    form.reset(toFormValues(entity));
  }, [entity, form]);

  const country = form.watch('jurisdictionCode');
  const months = useMemo(() => {
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat(language, { month: 'long', timeZone: 'UTC' });
    } catch {
      formatter = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' });
    }
    return Array.from({ length: 12 }, (_, i) => ({
      value: String(i + 1),
      label: formatter.format(new Date(Date.UTC(2024, i, 1))),
    }));
  }, [language]);

  async function onSubmit(values: FormValues) {
    form.clearErrors();
    let invalid = false;
    if (!values.name.trim()) {
      form.setError('name', { message: tg.nameRequired });
      invalid = true;
    }
    if (values.email.trim() && !z.string().email().safeParse(values.email.trim()).success) {
      form.setError('email', { message: tg.invalidEmail });
      invalid = true;
    }
    if (invalid) return;
    try {
      await update.mutateAsync({ id: entity.id, input: toUpdateInput(values) });
      setSubmitError(null);
      toast.success(tg.saved);
    } catch (err) {
      // 409s (and other refusals) carry the server's explanation.
      setSubmitError(err instanceof Error ? err.message : t.settings.legalEntities.detail.actionFailed);
    }
  }

  const textField = (name: keyof FormValues, label: string, props: { placeholder?: string; type?: string } = {}) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input {...field} {...props} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  const colorField = (name: 'primaryColor' | 'accentColor', label: string) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <div className="flex items-center gap-2">
            <Input
              type="color"
              aria-label={label}
              className="h-9 w-12 shrink-0 p-1"
              value={/^#[0-9a-fA-F]{6}$/.test(field.value) ? field.value : '#000000'}
              onChange={(event) => field.onChange(event.target.value)}
            />
            <FormControl>
              <Input {...field} placeholder="#1a73e8" className="font-mono" />
            </FormControl>
          </div>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="max-w-3xl space-y-6">
        {!canEdit && <InfoBanner variant="neutral">{tg.readOnly}</InfoBanner>}
        <ErrorBanner error={submitError} onDismiss={() => setSubmitError(null)} />
        <fieldset disabled={!canEdit} className="min-w-0 space-y-6">
          <SectionCard title={tg.identity} description={tg.identityDescription}>
            <div className="grid gap-4 sm:grid-cols-2">
              {textField('name', tg.name)}
              {textField('legalName', tg.legalName)}
              {textField('dba', tg.tradingName)}
              <FormField
                control={form.control}
                name="jurisdictionCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tg.country}</FormLabel>
                    <FormControl>
                      <CountrySelect value={field.value} onChange={field.onChange} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="entityType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tg.legalForm}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={NONE}>{tg.noLegalForm}</SelectItem>
                        {entityTypesFor(country, entity.entityType).map((code) => (
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
                    <FormLabel>{tg.currency}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {currencyOptions(entity.baseCurrency).map((code) => (
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
              <FormField
                control={form.control}
                name="fiscalYearStart"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tg.fiscalYearStart}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={NONE}>-</SelectItem>
                        {months.map((month) => (
                          <SelectItem key={month.value} value={month.value}>
                            {month.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </SectionCard>

          <SectionCard title={tg.address} description={tg.addressDescription}>
            <div className="grid gap-4 sm:grid-cols-6">
              <div className="sm:col-span-3">{textField('street', tg.street)}</div>
              <div className="sm:col-span-1">{textField('houseNumber', tg.houseNumber)}</div>
              <div className="sm:col-span-2">{textField('houseNumberAddition', tg.houseNumberAddition)}</div>
              <div className="sm:col-span-6">{textField('line2', tg.line2)}</div>
              <div className="sm:col-span-2">{textField('postalCode', tg.postalCode)}</div>
              <div className="sm:col-span-4">{textField('city', tg.city)}</div>
              <div className="sm:col-span-3">{textField('state', tg.state)}</div>
              <div className="sm:col-span-3">
                <FormField
                  control={form.control}
                  name="addressCountry"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tg.addressCountry}</FormLabel>
                      <FormControl>
                        <CountrySelect value={field.value} onChange={field.onChange} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>
          </SectionCard>

          <SectionCard title={tg.contact} description={tg.contactDescription}>
            <div className="grid gap-4 sm:grid-cols-2">
              {textField('email', tg.email, { type: 'email' })}
              {textField('phone', tg.phone, { type: 'tel' })}
              {textField('website', tg.website)}
              <div className="hidden sm:block" />
              {textField('contactFirstName', tg.contactFirstName)}
              {textField('contactLastName', tg.contactLastName)}
            </div>
          </SectionCard>

          <SectionCard title={tg.branding} description={tg.brandingDescription}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">{textField('logoUrl', tg.logoUrl, { placeholder: 'https://' })}</div>
              {colorField('primaryColor', tg.primaryColor)}
              {colorField('accentColor', tg.accentColor)}
            </div>
          </SectionCard>
        </fieldset>

        {canEdit && (
          <div className="flex justify-end">
            <Button type="submit" disabled={update.isPending || !form.formState.isDirty}>
              {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {tg.save}
            </Button>
          </div>
        )}
      </form>
    </Form>
  );
}
