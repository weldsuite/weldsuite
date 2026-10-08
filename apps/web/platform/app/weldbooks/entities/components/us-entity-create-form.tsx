import { useMemo, type ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { useNavigate } from '@tanstack/react-router';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { AddressFields } from '@/components/address/address-fields';
import {
  EMPTY_POSTAL_ADDRESS,
  cleanPostalAddress,
  type PostalAddress,
} from '@/components/address/postal-address';
import { useCreateAccountingEntity } from '@/hooks/queries/use-accounting-queries';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import type { CreateAccountingEntityInput } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import type { UsEntityTypeSummary } from '@/lib/weldbooks/us-entity';
import { UsEntityCards, usFieldErrors } from './us-entity-cards';
import {
  DEFAULT_US_VALUES,
  createUsEntitySchema,
  einPayload,
  ssnPayload,
  usPayload,
} from './us-entity-form';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'CHF', 'INR'];

function createFormSchema(messages: {
  nameRequired: string;
  entityTypeRequired: string;
  classificationRequired: string;
  einInvalidFormat: string;
  einInvalidPrefix: string;
  ssnInvalid: string;
}) {
  return z.object({
    name: z.string().trim().min(1, messages.nameRequired),
    legalName: z.string(),
    baseCurrency: z.string().length(3),
    address: z.object({
      line1: z.string().optional(),
      line2: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
    }),
    isDefault: z.boolean(),
    seedDefaults: z.boolean(),
    us: createUsEntitySchema(messages, { requireType: true }),
  });
}

type CreateFormValues = z.infer<ReturnType<typeof createFormSchema>>;

interface UsEntityCreateFormProps {
  /** The jurisdiction select of the page, shown with the business details. */
  jurisdictionPicker: ReactNode;
  entityTypes: readonly UsEntityTypeSummary[];
}

/**
 * Creating a US entity: legal form and tax classification, EIN or SSN,
 * accounting method, fiscal year, address with the state picker and time zone.
 * Creating it seeds the chart of accounts for its legal form with the accounts
 * mapped to the lines of its tax return.
 */
export function UsEntityCreateForm({ jurisdictionPicker, entityTypes }: Readonly<UsEntityCreateFormProps>) {
  const { t } = useI18n();
  const te = t.accounting.entities;
  const tu = t.weldbooksUs.setup.entity;
  const navigate = useNavigate();
  const { setEntityId } = useCurrentAccountingEntity();
  const createEntity = useCreateAccountingEntity();
  const canCreate = useCan('entities:create');

  const schema = useMemo(
    () =>
      createFormSchema({
        nameRequired: tu.nameRequired,
        entityTypeRequired: tu.entityTypeRequired,
        classificationRequired: tu.classificationRequired,
        einInvalidFormat: tu.einInvalidFormat,
        einInvalidPrefix: tu.einInvalidPrefix,
        ssnInvalid: tu.ssnInvalid,
      }),
    [tu.nameRequired, tu.entityTypeRequired, tu.classificationRequired, tu.einInvalidFormat, tu.einInvalidPrefix, tu.ssnInvalid],
  );

  const form = useForm<CreateFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      legalName: '',
      baseCurrency: 'USD',
      address: { ...EMPTY_POSTAL_ADDRESS, country: 'US' } satisfies PostalAddress,
      isDefault: false,
      seedDefaults: true,
      us: DEFAULT_US_VALUES,
    },
  });
  const errors = form.formState.errors;
  const state = form.watch('address.state');

  const submit = async (values: CreateFormValues) => {
    const taxIdentifiers: NonNullable<CreateAccountingEntityInput['taxIdentifiers']> = {};
    const ein = einPayload(values.us);
    if (ein) taxIdentifiers.einOrSsn = ein;
    if (values.us.stateTaxId.trim()) taxIdentifiers.registrationNumber = values.us.stateTaxId.trim();

    const payload: CreateAccountingEntityInput = {
      name: values.name.trim(),
      legalName: values.legalName.trim() || undefined,
      jurisdictionCode: 'US',
      baseCurrency: values.baseCurrency,
      address: cleanPostalAddress(values.address),
      ...usPayload(values.us),
      isDefault: values.isDefault,
      seedDefaults: values.seedDefaults,
    };
    if (Object.keys(taxIdentifiers).length > 0) payload.taxIdentifiers = taxIdentifiers;
    const ssn = ssnPayload(values.us);
    if (typeof ssn === 'string') payload.ssn = ssn;

    try {
      const res = await createEntity.mutateAsync(payload);
      if (res.data?.id) setEntityId(res.data.id);
      toast.success(tu.created);
      navigate({ to: '/weldbooks/entities' });
    } catch (err) {
      toast.error(tu.createFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{tu.addTitle}</h1>
        <p className="text-sm text-muted-foreground">{tu.addDescription}</p>
      </div>

      <form onSubmit={form.handleSubmit(submit)} className="space-y-6" noValidate>
        <Card>
          <CardHeader>
            <CardTitle>{tu.business}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="us-entity-name">{te.displayName} *</Label>
              <Input
                id="us-entity-name"
                placeholder={te.displayNamePlaceholder}
                aria-invalid={errors.name ? true : undefined}
                {...form.register('name')}
              />
              {errors.name ? <p className="text-sm text-destructive">{errors.name.message}</p> : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="us-entity-legalName">{te.legalName}</Label>
              <Input id="us-entity-legalName" placeholder={te.legalNamePlaceholder2} {...form.register('legalName')} />
            </div>
            <div className="space-y-2">
              <Label>{te.jurisdiction}</Label>
              {jurisdictionPicker}
              <p className="text-xs text-muted-foreground">{tu.jurisdictionHelp}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="us-entity-currency">{te.baseCurrency}</Label>
              <Controller
                control={form.control}
                name="baseCurrency"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="us-entity-currency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((currency) => (
                        <SelectItem key={currency} value={currency}>
                          {currency}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <p className="text-xs text-muted-foreground">{tu.currencyHelp}</p>
            </div>
          </CardContent>
        </Card>

        <Controller
          control={form.control}
          name="us"
          render={({ field }) => (
            <UsEntityCards
              idPrefix="us-entity"
              value={field.value}
              onChange={field.onChange}
              errors={usFieldErrors(errors.us)}
              entityTypes={entityTypes}
              state={state}
            />
          )}
        />

        <Card>
          <CardHeader>
            <CardTitle>{t.accounting.entityEdit.address}</CardTitle>
          </CardHeader>
          <CardContent>
            <Controller
              control={form.control}
              name="address"
              render={({ field }) => (
                <AddressFields idPrefix="us-entity-address" value={field.value} onChange={field.onChange} />
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tu.options}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Controller
              control={form.control}
              name="isDefault"
              render={({ field }) => (
                <label className="flex items-center gap-2">
                  <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />
                  <span className="text-sm">{te.makeDefault}</span>
                </label>
              )}
            />
            <Controller
              control={form.control}
              name="seedDefaults"
              render={({ field }) => (
                <label className="flex items-center gap-2">
                  <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />
                  <span className="text-sm">{te.seedDefaults}</span>
                </label>
              )}
            />
          </CardContent>
        </Card>

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={createEntity.isPending || !canCreate}>
            {createEntity.isPending ? tu.creating : tu.create}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/weldbooks/entities' })}>
            {te.cancel}
          </Button>
        </div>
      </form>
    </div>
  );
}
