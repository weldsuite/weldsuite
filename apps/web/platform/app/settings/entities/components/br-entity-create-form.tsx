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
import { EMPTY_POSTAL_ADDRESS, cleanPostalAddress, type PostalAddress } from '@/components/address/postal-address';
import { useCreateAccountingEntity } from '@/hooks/queries/use-accounting-queries';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import type { CreateAccountingEntityInput } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import {
  BR_DEFAULTS,
  BR_ENTITY_TYPES,
  DEFAULT_BR_VALUES,
  brEntityPayload,
  defaultBrRegime,
  timezoneOfUf,
  validBrRegime,
  type BrEntityValues,
} from '@/lib/weldbooks/br-entity';
import { normalizeCep } from '@/lib/weldbooks/identifiers';
import { BrEntityCards, BrField } from './br-entity-cards';
import { addBrEntityIssues, brFieldErrors, type BrEntityErrorMessages } from './br-entity-form';

const CURRENCIES = ['BRL', 'USD', 'EUR', 'GBP'];

function createFormSchema(messages: BrEntityErrorMessages & { nameRequired: string }) {
  return z
    .object({
      name: z.string().trim().min(1, messages.nameRequired),
      legalName: z.string(),
      entityType: z.string(),
      baseCurrency: z.string().length(3),
      cnpj: z.string(),
      ie: z.string(),
      address: z.object({
        line1: z.string().optional(),
        line2: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        postalCode: z.string().optional(),
        country: z.string().optional(),
        county: z.string().optional(),
      }),
      bankName: z.string(),
      routingNumber: z.string(),
      accountNumber: z.string(),
      isDefault: z.boolean(),
      seedDefaults: z.boolean(),
      br: z.custom<BrEntityValues>(),
    })
    .superRefine((values, ctx) => {
      addBrEntityIssues(
        ctx,
        values.br,
        { entityType: values.entityType, cnpj: values.cnpj, ie: values.ie },
        messages,
        { br: ['br'], cnpj: ['cnpj'], ie: ['ie'] },
      );
      const cep = values.address.postalCode?.trim();
      if (cep && !normalizeCep(cep)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['address', 'postalCode'], message: messages.cep });
      }
    });
}

type CreateFormValues = z.infer<ReturnType<typeof createFormSchema>>;

interface BrEntityCreateFormProps {
  /** The jurisdiction select of the page, shown with the business details. */
  jurisdictionPicker: ReactNode;
}

/**
 * Creating a Brazilian entity: legal form and tax regime, CNPJ and state
 * registration, municipality and ISS, Pix, bank details (banco, agência,
 * conta), the address with the UF picker. Creating it seeds the Brazilian
 * chart of accounts and the tax profiles of the regime.
 */
export function BrEntityCreateForm({ jurisdictionPicker }: Readonly<BrEntityCreateFormProps>) {
  const { t } = useI18n();
  const te = t.accounting.entities;
  const tb = t.weldbooksBr.entity;
  const navigate = useNavigate();
  const { setEntityId } = useCurrentAccountingEntity();
  const createEntity = useCreateAccountingEntity();
  const canCreate = useCan('entities:create');

  const schema = useMemo(
    () => createFormSchema({ ...(tb.errors as BrEntityErrorMessages), nameRequired: t.accounting.entityEdit.nameRequired }),
    [tb.errors, t.accounting.entityEdit.nameRequired],
  );

  const form = useForm<CreateFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      legalName: '',
      entityType: 'ltda',
      baseCurrency: BR_DEFAULTS.baseCurrency,
      cnpj: '',
      ie: '',
      address: { ...EMPTY_POSTAL_ADDRESS, country: BR_DEFAULTS.country } satisfies PostalAddress,
      bankName: '',
      routingNumber: '',
      accountNumber: '',
      isDefault: false,
      seedDefaults: true,
      br: { ...DEFAULT_BR_VALUES, regime: defaultBrRegime('ltda') },
    },
  });
  const errors = form.formState.errors;
  const entityType = form.watch('entityType');

  const submit = async (values: CreateFormValues) => {
    const brPayload = brEntityPayload(values.br, { cnpj: values.cnpj, ie: values.ie });
    const address = cleanPostalAddress(values.address);
    const cep = values.address.postalCode ? normalizeCep(values.address.postalCode) : undefined;
    const bankDetails: NonNullable<CreateAccountingEntityInput['bankDetails']> = {};
    if (values.bankName.trim()) bankDetails.bankName = values.bankName.trim();
    if (values.routingNumber.trim()) bankDetails.routingNumber = values.routingNumber.trim();
    if (values.accountNumber.trim()) bankDetails.accountNumber = values.accountNumber.trim();

    const payload: CreateAccountingEntityInput = {
      name: values.name.trim(),
      legalName: values.legalName.trim() || undefined,
      entityType: values.entityType,
      jurisdictionCode: 'BR',
      baseCurrency: values.baseCurrency,
      locale: BR_DEFAULTS.locale,
      timezone: timezoneOfUf(values.br.uf || values.address.state),
      address: address && cep ? { ...address, postalCode: cep } : address,
      bankDetails: Object.keys(bankDetails).length > 0 ? bankDetails : undefined,
      ...brPayload,
      isDefault: values.isDefault,
      seedDefaults: values.seedDefaults,
    };

    try {
      const res = await createEntity.mutateAsync(payload);
      if (res.data?.id) setEntityId(res.data.id);
      toast.success(tb.created);
      navigate({ to: '/settings/entities' });
    } catch (err) {
      toast.error(tb.createFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const typeLabels = t.accounting.entityTypes as Record<string, string>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{tb.addTitle}</h1>
        <p className="text-sm text-muted-foreground">{tb.addDescription}</p>
      </div>

      <form onSubmit={form.handleSubmit(submit)} className="space-y-6" noValidate>
        <Card>
          <CardHeader>
            <CardTitle>{tb.businessTitle}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <BrField id="br-entity-name" label={`${te.displayName} *`} error={errors.name?.message}>
              <Input
                id="br-entity-name"
                placeholder={te.displayNamePlaceholders.BR}
                aria-invalid={errors.name ? true : undefined}
                {...form.register('name')}
              />
            </BrField>
            <BrField id="br-entity-legalName" label={te.legalName}>
              <Input id="br-entity-legalName" placeholder={te.legalNamePlaceholders.BR} {...form.register('legalName')} />
            </BrField>
            <BrField id="br-entity-type" label={te.entityType}>
              <Controller
                control={form.control}
                name="entityType"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(next) => {
                      field.onChange(next);
                      // The legal form decides which regimes exist: keep the regime when it still fits.
                      const current = form.getValues('br');
                      form.setValue('br', { ...current, regime: validBrRegime(next, current.regime) }, { shouldDirty: true });
                    }}
                  >
                    <SelectTrigger id="br-entity-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BR_ENTITY_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {typeLabels[type]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </BrField>
            <BrField id="br-entity-currency" label={te.baseCurrency}>
              <Controller
                control={form.control}
                name="baseCurrency"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="br-entity-currency">
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
            </BrField>
            <div className="space-y-2 sm:col-span-2">
              <Label>{te.jurisdiction}</Label>
              {jurisdictionPicker}
            </div>
            <BrField id="br-entity-cnpj" label={tb.cnpj} help={tb.cnpjHelp} error={errors.cnpj?.message}>
              <Input
                id="br-entity-cnpj"
                placeholder="11.222.333/0001-81"
                autoComplete="off"
                aria-invalid={errors.cnpj ? true : undefined}
                {...form.register('cnpj')}
              />
            </BrField>
            <BrField id="br-entity-ie" label={tb.ie} help={tb.ieHelp} error={errors.ie?.message}>
              <Input id="br-entity-ie" placeholder="ISENTO" autoComplete="off" aria-invalid={errors.ie ? true : undefined} {...form.register('ie')} />
            </BrField>
          </CardContent>
        </Card>

        <Controller
          control={form.control}
          name="br"
          render={({ field }) => (
            <BrEntityCards
              idPrefix="br-entity"
              value={field.value}
              onChange={field.onChange}
              errors={brFieldErrors(errors.br)}
              entityType={entityType}
              onUfChange={(uf) => {
                const address = form.getValues('address');
                if (!address.state) form.setValue('address', { ...address, state: uf }, { shouldDirty: true });
              }}
            />
          )}
        />

        <Card>
          <CardHeader>
            <CardTitle>{t.accounting.entityEdit.address}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Controller
              control={form.control}
              name="address"
              render={({ field }) => (
                <AddressFields idPrefix="br-entity-address" value={field.value} onChange={field.onChange} />
              )}
            />
            {errors.address?.postalCode?.message ? (
              <p className="text-sm text-destructive">{errors.address.postalCode.message}</p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.accounting.entityEdit.bankDetails}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <BrField id="br-entity-bankName" label={tb.bankName}>
              <Input id="br-entity-bankName" placeholder="Banco do Brasil (001)" {...form.register('bankName')} />
            </BrField>
            <BrField id="br-entity-agencia" label={tb.agencia}>
              <Input id="br-entity-agencia" inputMode="numeric" autoComplete="off" placeholder="1234-5" {...form.register('routingNumber')} />
            </BrField>
            <BrField id="br-entity-conta" label={tb.conta}>
              <Input id="br-entity-conta" inputMode="numeric" autoComplete="off" placeholder="12345-6" {...form.register('accountNumber')} />
            </BrField>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tb.options}</CardTitle>
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
          <Button type="submit" disabled={!canCreate || createEntity.isPending}>
            {createEntity.isPending ? te.creatingEntity : te.createEntity2}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/settings/entities' })}>
            {te.cancel}
          </Button>
        </div>
      </form>
    </div>
  );
}
